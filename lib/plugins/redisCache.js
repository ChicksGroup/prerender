const zlib = require('zlib');
const crypto = require('crypto');
const util = require('../util.js');

// --- module state (closure, not `this`, so it's robust regardless of caller) ---
let client = null; // redis client (real ioredis or an injected test double)
let objectStore = null; // Spaces/S3 body store (when CACHE_STORE=spaces)
let enabled = false; // CACHE_ENABLED
let config = null; // parsed config

// Lua compare-and-delete so we only release a single-flight lock we still own
// (never a successor's lock that replaced ours after a TTL expiry).
const RELEASE_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

function parseConfig() {
  const cacheable = (process.env.CACHE_CACHEABLE_STATUS || '200,301,302,404')
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !Number.isNaN(n));

  return {
    keyPrefix: process.env.CACHE_KEY_PREFIX || 'prerender',
    compression: (process.env.CACHE_COMPRESSION || 'true') !== 'false',
    singleFlight: (process.env.SINGLEFLIGHT_ENABLED || 'true') !== 'false',
    lockTtlMs: parseInt(process.env.SINGLEFLIGHT_LOCK_TTL_MS || '30000', 10),
    waitMaxMs: parseInt(process.env.SINGLEFLIGHT_WAIT_MAX_MS || '5000', 10),
    waitPollMs: parseInt(process.env.SINGLEFLIGHT_WAIT_POLL_MS || '150', 10),
    cacheableStatus: new Set(cacheable),
    // Refuse to cache a 200 HTML body smaller than this many bytes — guards
    // against permanently storing an empty/half-rendered shell (no eviction!).
    // 0 = off. See also the cache-manager's own render validation.
    minHtmlBytes: parseInt(process.env.CACHE_MIN_HTML_BYTES || '0', 10),
    // Where HTML bodies live: 'redis' (default; body in Redis) or 'spaces'
    // (body in DO Spaces / S3; the lock + index stay in Redis either way).
    store: (process.env.CACHE_STORE || 'redis').toLowerCase(),
    spaces: {
      bucket: process.env.SPACES_BUCKET || '',
      endpoint: process.env.SPACES_ENDPOINT || '',
      region: process.env.SPACES_REGION || 'us-east-1',
      prefix: process.env.SPACES_PREFIX || '',
      accessKeyId:
        process.env.SPACES_KEY || process.env.AWS_ACCESS_KEY_ID || '',
      secretAccessKey:
        process.env.SPACES_SECRET || process.env.AWS_SECRET_ACCESS_KEY || '',
      forcePathStyle: process.env.SPACES_FORCE_PATH_STYLE === 'true',
    },
  };
}

function buildClient() {
  // Lazy-require so tests that inject a client never need ioredis loaded.
  const Redis = require('ioredis');
  const opts = {
    lazyConnect: true,
    // Fail fast instead of queueing while disconnected -> we degrade to live
    // render immediately rather than hanging.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
    reconnectOnError: () => false,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  };

  let c;
  if (process.env.REDIS_URL) {
    // rediss:// auto-enables TLS (DO Managed Valkey).
    c = new Redis(process.env.REDIS_URL, opts);
  } else {
    c = new Redis(
      Object.assign({}, opts, {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASSWORD || undefined,
        tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
      }),
    );
  }

  // Swallow connection errors; every command is also try/caught and degrades.
  c.on('error', (e) => util.log('[redisCache] redis error', e && e.message));
  // Kick off the connection in the background; a boot-time outage must not
  // block the server from rendering live.
  c.connect().catch(() => {});
  return c;
}

// --- keys & serialization ---
function htmlKey(url) {
  return `${config.keyPrefix}:v1:html:${url}`;
}
function lockKey(url) {
  return `${config.keyPrefix}:v1:lock:${url}`;
}
// Sorted set of cached entries scored by store time (ms). Lets the cache-manager
// enumerate the oldest entries for refresh without SCANning the whole keyspace.
function indexKey() {
  return `${config.keyPrefix}:v1:index`;
}
// Object-store key for the HTML body (Spaces store). Hashed so it's a safe,
// fixed-length key regardless of URL contents.
function bodyKey(url) {
  const hash = crypto.createHash('sha256').update(url).digest('hex');
  return `${config.spaces.prefix}v1/html/${hash}`;
}

function pickHeaders(headers) {
  const out = {};
  if (!headers) return out;
  const allow = ['location', 'content-type'];
  Object.keys(headers).forEach((k) => {
    if (allow.indexOf(k.toLowerCase()) > -1) out[k.toLowerCase()] = headers[k];
  });
  return out;
}

function serialize(statusCode, headers, content, renderId) {
  let body = content;
  let compressed = false;
  if (config.compression) {
    body = zlib.gzipSync(Buffer.from(content, 'utf8')).toString('base64');
    compressed = true;
  }
  return JSON.stringify({
    v: 1,
    statusCode: parseInt(statusCode, 10),
    headers: pickHeaders(headers),
    renderType: 'html',
    compressed,
    storedAt: new Date().toISOString(),
    renderId,
    body,
  });
}

function tryDeserialize(raw) {
  try {
    const entry = JSON.parse(raw);
    let content = entry.body;
    if (entry.compressed) {
      content = zlib
        .gunzipSync(Buffer.from(entry.body, 'base64'))
        .toString('utf8');
    }
    return {
      statusCode: entry.statusCode,
      headers: entry.headers || {},
      content,
    };
  } catch (e) {
    return null;
  }
}

// Read a flag from the tab (where chrome.js sets it) or fall back to req.prerender.
function flag(req, name) {
  const t = req.prerender.tab && req.prerender.tab.prerender;
  return (t && t[name]) || req.prerender[name];
}

// Strict cacheability — nothing ever evicts, so a poisoned entry would live
// forever. Only persist known-good HTML responses.
function isCacheable(req) {
  const p = req.prerender;
  const t = p.tab && p.tab.prerender;

  if (p.renderType && p.renderType !== 'html')
    return { ok: false, reason: 'notHtml' };
  if (p.prerenderData) return { ok: false, reason: 'prerenderData' };
  if (flag(req, 'timedout')) return { ok: false, reason: 'timedout' };
  if (flag(req, 'dirtyRender')) return { ok: false, reason: 'dirtyRender' };
  if (flag(req, 'navigateError')) return { ok: false, reason: 'navigateError' };
  if (flag(req, 'statusCodeReason'))
    return { ok: false, reason: 'statusCodeReason' };

  const errors = (t && t.errors) || p.errors || [];
  if (errors.length > 0) return { ok: false, reason: 'errors' };

  if (typeof p.content !== 'string' || p.content.length === 0)
    return { ok: false, reason: 'empty' };
  if (
    config.minHtmlBytes > 0 &&
    Buffer.byteLength(p.content, 'utf8') < config.minHtmlBytes
  )
    return { ok: false, reason: 'tooSmall' };

  const code = parseInt(
    p.statusCode != null ? p.statusCode : t && t.statusCode,
    10,
  );
  if (Number.isNaN(code)) return { ok: false, reason: 'noStatus' };
  if (code >= 500) return { ok: false, reason: 'serverError' };
  if (!config.cacheableStatus.has(code))
    return { ok: false, reason: 'statusNotCacheable' };

  return { ok: true, code };
}

function isBypass(req) {
  const q = req.query || {};
  if (q.bypassCache === 'true') return true;
  const h = req.headers || {};
  if (h['x-prerender-bypass-cache'] === 'true') return true;
  return false;
}

function logEvt(evt, data) {
  util.log('[redisCache]', JSON.stringify(Object.assign({ evt }, data || {})));
}

function latency(req) {
  return req.prerender.start
    ? Date.now() - req.prerender.start.getTime()
    : null;
}

// --- best-effort redis ops (every one degrades to live render on failure) ---
function safeGet(key) {
  return Promise.resolve().then(() => client.get(key));
}
function safeSet(key, value) {
  return Promise.resolve().then(() => client.set(key, value));
}
function safeSetNxPx(key, value, ttlMs) {
  return Promise.resolve()
    .then(() => client.set(key, value, 'PX', ttlMs, 'NX'))
    .then((r) => r === 'OK');
}
function safeReleaseLock(key, value) {
  return Promise.resolve().then(() => client.eval(RELEASE_LUA, 1, key, value));
}
function safeZAdd(member, scoreMs) {
  return Promise.resolve().then(() => client.zadd(indexKey(), scoreMs, member));
}

// --- body storage: Redis string (default) or Spaces object (CACHE_STORE) ---
function putBody(url, statusCode, headers, content, renderId) {
  if (config.store === 'spaces') {
    const gz = config.compression
      ? zlib.gzipSync(Buffer.from(content, 'utf8'))
      : Buffer.from(content, 'utf8');
    const h = pickHeaders(headers);
    return objectStore.put(bodyKey(url), gz, {
      status: String(statusCode),
      location: h.location || '',
      ctype: h['content-type'] || '',
      compressed: config.compression ? '1' : '0',
      storedat: String(Date.now()),
      renderid: renderId || '',
    });
  }
  return safeSet(
    htmlKey(url),
    serialize(statusCode, headers, content, renderId),
  );
}

function getBody(url) {
  if (config.store === 'spaces') {
    return Promise.resolve()
      .then(() => objectStore.get(bodyKey(url)))
      .then((obj) => {
        if (!obj) return null;
        const meta = obj.meta || {};
        let content;
        try {
          content =
            meta.compressed === '0'
              ? obj.body.toString('utf8')
              : zlib.gunzipSync(obj.body).toString('utf8');
        } catch (e) {
          return null;
        }
        const headers = {};
        if (meta.location) headers.location = meta.location;
        if (meta.ctype) headers['content-type'] = meta.ctype;
        return {
          statusCode: parseInt(meta.status, 10) || 200,
          headers,
          content,
        };
      });
  }
  return safeGet(htmlKey(url)).then((raw) =>
    raw ? tryDeserialize(raw) : null,
  );
}

function serveFromCache(req, res, entry, mode) {
  req.prerender.statusCode = entry.statusCode;
  req.prerender.content = entry.content;
  req.prerender.headers = entry.headers;
  req.prerender._servedFromCache = true;
  res.setHeader('X-Prerender-Cache', mode);
  logEvt(mode === 'HIT-WAIT' ? 'hit-wait' : 'hit', {
    url: req.prerender.url,
    status: entry.statusCode,
  });
  return res.send(entry.statusCode, entry.content);
}

// Single-flight: try to claim the render; if another instance holds the lock,
// wait briefly for the entry it will write, else render-through.
function acquireOrWait(req, res, next) {
  if (!config.singleFlight) {
    req.prerender._cacheLockOwner = true; // everyone writes (idempotent overwrite)
    logEvt('miss', { url: req.prerender.url });
    return next();
  }

  return safeSetNxPx(
    lockKey(req.prerender.url),
    req.prerender.renderId,
    config.lockTtlMs,
  )
    .then((acquired) => {
      if (acquired) {
        req.prerender._cacheLockOwner = true;
        logEvt('miss', { url: req.prerender.url, lock: 'acquired' });
        return next();
      }
      return waitForEntry(req, res, next);
    })
    .catch(() => {
      // Lock op failed -> render-through and write (best effort).
      req.prerender._cacheLockOwner = true;
      return next();
    });
}

function waitForEntry(req, res, next) {
  const url = req.prerender.url;
  const deadline = Date.now() + config.waitMaxMs;

  return new Promise((resolve) => {
    const poll = () => {
      getBody(url)
        .then((entry) => {
          if (entry) {
            serveFromCache(req, res, entry, 'HIT-WAIT');
            return resolve();
          }

          if (Date.now() >= deadline) {
            // Renderer is slow/crashed; render our own result but don't write
            // (avoid clobbering the owner's pending write).
            req.prerender._cacheLockOwner = false;
            logEvt('lock-wait-timeout', { url });
            next();
            return resolve();
          }
          setTimeout(poll, config.waitPollMs);
        })
        .catch(() => {
          req.prerender._cacheLockOwner = false;
          next();
          resolve();
        });
    };

    poll();
  });
}

// --- introspection (backs the /cache/* routes + the cache-manager worker) ---

// For each input URL: normalize it the SAME way the render path does (so keys
// match), report whether it's cached, and when it was stored (ms, from the index).
async function status(urls) {
  if (!enabled || !client) throw new Error('cache disabled');
  const list = Array.isArray(urls) ? urls : [];
  return Promise.all(
    list.map(async (rawUrl) => {
      const normalizedUrl = util.getUrl(rawUrl);
      // The index (Redis ZSET) is the backend-agnostic source of truth for
      // "is it cached + when" — whether the body lives in Redis or Spaces.
      const score = await Promise.resolve().then(() =>
        client.zscore(indexKey(), normalizedUrl),
      );
      return {
        url: rawUrl,
        normalizedUrl,
        cached: score != null,
        storedAt: score != null ? Number(score) : null,
      };
    }),
  );
}

function parseZsetWithScores(rows) {
  const out = [];
  for (let i = 0; i + 1 < rows.length; i += 2) {
    out.push({ url: rows[i], storedAt: Number(rows[i + 1]) });
  }
  return out;
}

// Oldest cached entries first. With olderThanMs, only entries stored longer ago
// than that are returned (the refresh candidates).
async function stale(opts) {
  if (!enabled || !client) throw new Error('cache disabled');
  const limit = Math.max(1, (opts && opts.limit) || 100);
  const olderThanMs = (opts && opts.olderThanMs) || 0;
  let rows;
  if (olderThanMs > 0) {
    rows = await client.zrangebyscore(
      indexKey(),
      '-inf',
      Date.now() - olderThanMs,
      'WITHSCORES',
      'LIMIT',
      0,
      limit,
    );
  } else {
    rows = await client.zrange(indexKey(), 0, limit - 1, 'WITHSCORES');
  }
  return parseZsetWithScores(rows || []);
}

async function stats() {
  if (!enabled || !client) return { enabled: false };
  const [count, oldest, newest] = await Promise.all([
    Promise.resolve().then(() => client.zcard(indexKey())),
    Promise.resolve().then(() => client.zrange(indexKey(), 0, 0, 'WITHSCORES')),
    Promise.resolve().then(() =>
      client.zrevrange(indexKey(), 0, 0, 'WITHSCORES'),
    ),
  ]);
  return {
    enabled: true,
    count: count || 0,
    oldestStoredAt: oldest && oldest[1] != null ? Number(oldest[1]) : null,
    newestStoredAt: newest && newest[1] != null ? Number(newest[1]) : null,
  };
}

module.exports = {
  init: () => {
    config = parseConfig();
    enabled = (process.env.CACHE_ENABLED || 'false') === 'true';

    if (!enabled) {
      util.log('[redisCache] disabled (set CACHE_ENABLED=true to enable)');
      return;
    }

    if (!client) {
      try {
        client = buildClient();
      } catch (e) {
        util.log(
          '[redisCache] failed to init redis client, caching disabled',
          e && e.message,
        );
        enabled = false;
        return;
      }
    }
    if (config.store === 'spaces' && !objectStore) {
      try {
        const { createSpacesStore } = require('../objectStore');
        objectStore = createSpacesStore(config.spaces);
      } catch (e) {
        util.log(
          '[redisCache] failed to init Spaces store, caching disabled',
          e && e.message,
        );
        enabled = false;
        return;
      }
    }
    util.log(
      `[redisCache] enabled, store=${config.store}, prefix=${config.keyPrefix}`,
    );
  },

  // READ + single-flight (runs before Chrome). Auth/whitelist run first.
  requestReceived: (req, res, next) => {
    if (!enabled || !client) return next();

    const p = req.prerender;
    if (p.renderType && p.renderType !== 'html') return next();

    if (isBypass(req)) {
      p._cacheBypass = true;
      logEvt('bypass', { url: p.url });
      return next();
    }

    return getBody(p.url)
      .then((entry) => {
        if (entry) return serveFromCache(req, res, entry, 'HIT');
        return acquireOrWait(req, res, next);
      })
      .catch(() => next());
  },

  // WRITE (runs in finish() for every completed response, so 301/302/404
  // short-circuits from httpHeaders are captured too).
  beforeSend: (req, res, next) => {
    if (!enabled || !client) return next();

    const p = req.prerender;
    if (p._servedFromCache) return next(); // came from cache; nothing to write

    const releaseIfOwned = () => {
      if (p._cacheLockOwner === true && config.singleFlight) {
        return safeReleaseLock(lockKey(p.url), p.renderId)
          .catch(() => {})
          .then(() => next());
      }
      return next();
    };

    const bypass = !!p._cacheBypass;
    const shouldWrite =
      bypass || p._cacheLockOwner === true || !config.singleFlight;

    const check = isCacheable(req);
    if (!check.ok) {
      logEvt('store-skip', { url: p.url, reason: check.reason });
      return releaseIfOwned();
    }
    if (!shouldWrite) return releaseIfOwned();

    return putBody(p.url, check.code, p.headers, p.content, p.renderId)
      .then(() => safeZAdd(p.url, Date.now()).catch(() => {})) // index for refresh; best-effort
      .then(() =>
        logEvt('store', {
          url: p.url,
          status: check.code,
          store: config.store,
          bytes: Buffer.byteLength(p.content, 'utf8'),
          latencyMs: latency(req),
        }),
      )
      .catch((e) => logEvt('redis-error', { op: 'store', err: e && e.message }))
      .then(releaseIfOwned);
  },

  // introspection helpers (called by lib/index.js cache routes)
  status,
  stale,
  stats,

  // --- test seams ---
  _setClientForTests: (c) => {
    client = c;
  },
  _setObjectStoreForTests: (s) => {
    objectStore = s;
  },
  _setEnabledForTests: (e) => {
    enabled = e;
  },
  _setConfigForTests: (overrides) => {
    config = Object.assign(parseConfig(), overrides || {});
  },
  _reset: () => {
    client = null;
    objectStore = null;
    enabled = false;
    config = null;
  },
};
