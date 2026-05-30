const zlib = require('zlib');
const util = require('../util.js');

// --- module state (closure, not `this`, so it's robust regardless of caller) ---
let client = null; // redis client (real ioredis or an injected test double)
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
  const key = htmlKey(req.prerender.url);
  const deadline = Date.now() + config.waitMaxMs;

  return new Promise((resolve) => {
    const poll = () => {
      safeGet(key)
        .then((raw) => {
          const entry = raw && tryDeserialize(raw);
          if (entry) {
            serveFromCache(req, res, entry, 'HIT-WAIT');
            return resolve();
          }

          if (Date.now() >= deadline) {
            // Renderer is slow/crashed; render our own result but don't write
            // (avoid clobbering the owner's pending write).
            req.prerender._cacheLockOwner = false;
            logEvt('lock-wait-timeout', { url: req.prerender.url });
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
    util.log(`[redisCache] enabled, prefix=${config.keyPrefix}`);
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

    return safeGet(htmlKey(p.url))
      .then((raw) => {
        const entry = raw && tryDeserialize(raw);
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

    const value = serialize(check.code, p.headers, p.content, p.renderId);
    return safeSet(htmlKey(p.url), value)
      .then(() =>
        logEvt('store', {
          url: p.url,
          status: check.code,
          bytes: value.length,
          latencyMs: latency(req),
        }),
      )
      .catch((e) => logEvt('redis-error', { op: 'set', err: e && e.message }))
      .then(releaseIfOwned);
  },

  // --- test seams ---
  _setClientForTests: (c) => {
    client = c;
  },
  _setEnabledForTests: (e) => {
    enabled = e;
  },
  _setConfigForTests: (overrides) => {
    config = Object.assign(parseConfig(), overrides || {});
  },
  _reset: () => {
    client = null;
    enabled = false;
    config = null;
  },
};
