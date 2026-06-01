const zlib = require('zlib');
const crypto = require('crypto');
const util = require('../util.js');

// --- module state (closure, not `this`, so it's robust regardless of caller) ---
let client = null; // redis client (real ioredis or an injected test double)
let objectStore = null; // Spaces/S3 body store (when CACHE_STORE=spaces)
let enabled = false; // CACHE_ENABLED
let config = null; // parsed config

// Per-domain stats memo (recompute cache only — source of truth is the index).
let statsByDomainCache = null;
let statsByDomainCachedAt = 0;
let statsByDomainInFlight = null;

// Render/fallback counters persisted in a Redis HASH, per-domain (field `<metric>|<host>`).
const METRIC_FIELDS = [
  'renders',
  'cache_hits',
  'fallback_render',
  'fallback_capacity',
  'fallback_failed',
  // Cumulative duration sums (ms). Averages are derived downstream:
  //   avg render time   = render_ms / renders
  //   avg cache serve   = cache_ms  / cache_hits
  'render_ms',
  'cache_ms',
];

// Lua compare-and-delete so we only release a single-flight lock we still own
// (never a successor's lock that replaced ours after a TTL expiry).
const RELEASE_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

function parseConfig() {
  // Optional explicit allowlist. Default empty => range mode (cache 200 + every
  // 3xx + every 4xx; see isCacheable). Set it to pin an exact set, e.g. "200,301".
  const cacheable = (process.env.CACHE_CACHEABLE_STATUS || '')
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
    // 4xx responses are cached but auto-evicted after this many ms (the refresh
    // window) so a stale 404 isn't served forever and a recovered page can heal.
    // 2xx/3xx have no TTL here — the cache-manager refreshes them on its cadence.
    error4xxTtlMs: parseInt(process.env.CACHE_4XX_TTL_MS || '86400000', 10),
    // Max render attempts for a queued URL before it's dropped (the cache-manager
    // re-enqueues it on its next sitemap scan anyway).
    queueMaxAttempts: parseInt(process.env.CACHE_QUEUE_MAX_ATTEMPTS || '3', 10),
    // Per-domain stats memo TTL (ms) + per-deployment metrics namespace.
    statsCacheTtlMs: parseInt(process.env.STATS_CACHE_TTL_MS || '60000', 10),
    metricsLabel: process.env.METRICS_LABEL || 'default',
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
// Parallel HASH (field = normalized url -> HTTP status code). The index ZSET
// carries only timestamps, so this is how /cache/status reports per-URL status
// to the cache-manager (which it needs to skip 4xx and slow-refresh 3xx).
function statusKey() {
  return `${config.keyPrefix}:v1:status`;
}
// Work queue (ZSET scored by priority*1e13 + enqueue time, so ZPOPMIN pops the
// highest-priority item, FIFO within a priority). The cache-manager produces
// into it (seed/refresh URLs); the in-server refresher consumes it at capacity.
function queueKey() {
  return `${config.keyPrefix}:v1:queue`;
}
// Per-URL render-attempt counter for queued items (so a flaky URL is dropped
// rather than retried forever).
function queueAttemptsKey() {
  return `${config.keyPrefix}:v1:queue:attempts`;
}
// Priority dominates the score; the wall-clock term only breaks ties (FIFO).
function queueScore(priority) {
  return priority * 1e13 + Date.now();
}
// Object-store key for the HTML body (Spaces store). Hashed so it's a safe,
// fixed-length key regardless of URL contents.
function bodyKey(url) {
  const hash = crypto.createHash('sha256').update(url).digest('hex');
  return `${config.spaces.prefix}v1/html/${hash}`;
}
// Per-deployment render/fallback metrics HASH.
function metricsKey() {
  return `${config.keyPrefix}:v1:metrics:${config.metricsLabel}`;
}
function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase() || 'unknown';
  } catch (e) {
    return 'unknown';
  }
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
      storedAt: entry.storedAt ? Date.parse(entry.storedAt) : null,
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
  // Never cache sub-2xx or server errors. 408/429 are OUR transient signals
  // (timeout / capacity-shed), not durable page outcomes — never cache them.
  if (code < 200 || code >= 500) return { ok: false, reason: 'serverError' };
  if (code === 408 || code === 429) return { ok: false, reason: 'transient' };
  // Range mode (default): cache 200 + every 3xx + every 4xx. An explicit
  // CACHE_CACHEABLE_STATUS pins the set instead. 4xx get a TTL (see putBody).
  if (config.cacheableStatus.size > 0 && !config.cacheableStatus.has(code))
    return { ok: false, reason: 'statusNotCacheable' };

  // Empty-shell guard is a 200-only concern; 3xx/404 legitimately carry a
  // tiny or empty body, so don't reject them for being small.
  if (
    code === 200 &&
    config.minHtmlBytes > 0 &&
    Buffer.byteLength(p.content, 'utf8') < config.minHtmlBytes
  )
    return { ok: false, reason: 'tooSmall' };

  return { ok: true, code };
}

function isBypass(req) {
  const q = req.query || {};
  if (q.bypassCache === 'true') return true;
  const h = req.headers || {};
  if (h['x-prerender-bypass-cache'] === 'true') return true;
  return false;
}

// A per-request "don't touch the cache" signal: skip the READ and the WRITE —
// render live every time and store nothing (no lock, no index/status entry).
// For non-prod sites (dev/staging) that share this deployment but whose pages
// must never be cached. Distinct from bypassCache, which renders fresh but DOES
// write (the refresher's refresh-the-cached-copy path).
function isNoStore(req) {
  const q = req.query || {};
  if (q.noStore === 'true') return true;
  const h = req.headers || {};
  if (h['x-prerender-no-store'] === 'true') return true;
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
function safeSetPx(key, value, ttlMs) {
  return Promise.resolve().then(() => client.set(key, value, 'PX', ttlMs));
}
function safeDel(key) {
  return Promise.resolve().then(() => client.del(key));
}
function safeZRem(member) {
  return Promise.resolve().then(() => client.zrem(indexKey(), member));
}
function safeHSet(member, value) {
  return Promise.resolve().then(() => client.hset(statusKey(), member, value));
}
function safeHDel(member) {
  return Promise.resolve().then(() => client.hdel(statusKey(), member));
}
function safeHMGet(members) {
  if (!members || members.length === 0) return Promise.resolve([]);
  return Promise.resolve().then(() => client.hmget(statusKey(), ...members));
}

// --- auto-eviction (4xx only) ----------------------------------------------
// A 4xx is cacheable but must not outlive the refresh window: a stale error
// shouldn't be served forever, and the page may recover. 2xx/3xx never expire
// here (the cache-manager refreshes those instead).
function isExpired4xx(code, storedAtMs) {
  return (
    Number.isFinite(code) &&
    code >= 400 &&
    code < 500 &&
    storedAtMs != null &&
    Date.now() - storedAtMs > config.error4xxTtlMs
  );
}
// Delete the body from whichever backend holds it (best-effort).
function delBody(url) {
  if (config.store === 'spaces') {
    return Promise.resolve()
      .then(() => objectStore.del(bodyKey(url)))
      .catch(() => {});
  }
  return safeDel(htmlKey(url)).catch(() => {});
}
// Remove an entry from every structure (body + index + status). Best-effort.
function evict(url) {
  return Promise.all([
    delBody(url),
    safeZRem(url).catch(() => {}),
    safeHDel(url).catch(() => {}),
  ]).then(() => {});
}

// --- body storage: Redis string (default) or Spaces object (CACHE_STORE) ---
// ttlMs > 0 sets a body expiry (used for 4xx). Spaces has no native per-object
// TTL, so there a 4xx is reaped lazily on read/status via isExpired4xx instead.
function putBody(url, statusCode, headers, content, renderId, ttlMs) {
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
  const payload = serialize(statusCode, headers, content, renderId);
  return ttlMs > 0
    ? safeSetPx(htmlKey(url), payload, ttlMs)
    : safeSet(htmlKey(url), payload);
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
        const code = parseInt(meta.status, 10) || 200;
        const storedAt = parseInt(meta.storedat, 10) || null;
        // Spaces has no PX, so reap a stale 4xx here (treat as a miss).
        if (isExpired4xx(code, storedAt)) {
          evict(url);
          return null;
        }
        const headers = {};
        if (meta.location) headers.location = meta.location;
        if (meta.ctype) headers['content-type'] = meta.ctype;
        return {
          statusCode: code,
          headers,
          content,
        };
      });
  }
  return safeGet(htmlKey(url)).then((raw) => {
    if (!raw) return null;
    const entry = tryDeserialize(raw);
    // Belt-and-suspenders for Redis: the body PX should already be gone, but a
    // pre-TTL entry (written before this rolled out) gets reaped here too.
    if (entry && isExpired4xx(entry.statusCode, entry.storedAt)) {
      evict(url);
      return null;
    }
    return entry;
  });
}

function serveFromCache(req, res, entry, mode) {
  req.prerender.statusCode = entry.statusCode;
  req.prerender.content = entry.content;
  req.prerender.headers = entry.headers;
  req.prerender._servedFromCache = true;
  res.setHeader('X-Prerender-Cache', mode);
  incrMetric('cache_hits', req.prerender.url);
  // Cache-serve duration (paired 1:1 with cache_hits). _cacheStart is stamped in
  // requestReceived just before the lookup; covers both HIT and HIT-WAIT.
  incrMetric('cache_ms', req.prerender.url, Date.now() - (req.prerender._cacheStart || Date.now()));
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
  const normalized = list.map((u) => util.getUrl(u));
  // One batched HMGET for all statuses (the index ZSET only carries timestamps).
  const codes = await safeHMGet(normalized).catch(() => []);
  return Promise.all(
    list.map(async (rawUrl, i) => {
      const normalizedUrl = normalized[i];
      // The index (Redis ZSET) is the backend-agnostic source of truth for
      // "is it cached + when" — whether the body lives in Redis or Spaces.
      const score = await Promise.resolve().then(() =>
        client.zscore(indexKey(), normalizedUrl),
      );
      const storedAt = score != null ? Number(score) : null;
      const code = codes[i] != null ? parseInt(codes[i], 10) : null;
      // A 4xx past its TTL is logically gone: reap it and report uncached so the
      // cache-manager re-seeds (never refreshes) it.
      if (storedAt != null && isExpired4xx(code, storedAt)) {
        await evict(normalizedUrl).catch(() => {});
        return {
          url: rawUrl,
          normalizedUrl,
          cached: false,
          storedAt: null,
          status: null,
        };
      }
      return {
        url: rawUrl,
        normalizedUrl,
        cached: score != null,
        storedAt,
        status: code,
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
  const parsed = parseZsetWithScores(rows || []);
  // Enrich with per-URL status so callers can tell 2xx/3xx/4xx apart.
  if (parsed.length > 0) {
    const codes = await safeHMGet(parsed.map((r) => r.url)).catch(() => []);
    parsed.forEach((r, i) => {
      r.status = codes[i] != null ? parseInt(codes[i], 10) : null;
    });
  }
  return parsed;
}

// Refresh candidates (oldest-first) whose age exceeds their per-status TTL.
// This is the in-server equivalent of the cache-manager's classify() refresh
// branch — driven entirely by our own index + status, no sitemap needed:
//   4xx       -> never refreshed (they auto-evict via CACHE_4XX_TTL_MS)
//   3xx       -> redirectTtlMs (redirects rarely change)
//   2xx/unknown -> refreshTtlMs
// Refreshed entries re-score to the tail (ZADD on write), so the head of the
// index is always the most overdue; we scan the oldest slice and return the due
// ones, skipping anything in `exclude` (URLs already being refreshed).
async function dueForRefresh(opts) {
  if (!enabled || !client) return [];
  const o = opts || {};
  const limit = Math.max(1, o.limit || 1);
  const refreshTtlMs = o.refreshTtlMs || 86400000;
  const redirectTtlMs = o.redirectTtlMs || 604800000;
  const exclude = o.exclude || new Set();
  const now = o.now || Date.now();
  // Scan more than `limit` so fresh/excluded/4xx entries at the head don't
  // starve the batch, but stay bounded (this runs on a loop).
  const scanMax = Math.max(limit * 10, 500);
  const rows = await Promise.resolve().then(() =>
    client.zrange(indexKey(), 0, scanMax - 1, 'WITHSCORES'),
  );
  const entries = parseZsetWithScores(rows || []);
  if (entries.length === 0) return [];
  const codes = await safeHMGet(entries.map((e) => e.url)).catch(() => []);
  const due = [];
  for (let i = 0; i < entries.length && due.length < limit; i += 1) {
    const { url, storedAt } = entries[i];
    if (exclude.has(url)) continue;
    const code = codes[i] != null ? parseInt(codes[i], 10) : null;
    if (code != null && code >= 400 && code < 500) continue; // 4xx never refreshed
    const ttl = code != null && code >= 300 && code < 400 ? redirectTtlMs : refreshTtlMs;
    if (storedAt == null || now - storedAt > ttl) due.push(url);
  }
  return due;
}

// --- render work queue (produced by the cache-manager, consumed in-server) ---

// Add URLs at a priority (0 = highest). NX so an already-queued URL keeps its
// place. Returns how many were newly added. Best-effort.
async function enqueue(urls, priority) {
  if (!enabled || !client) return 0;
  const list = Array.isArray(urls) ? urls : [];
  const p = Number.isFinite(priority) ? priority : 1;
  let added = 0;
  for (const raw of list) {
    const url = util.getUrl(raw);
    try {
      const r = await Promise.resolve().then(() =>
        client.zadd(queueKey(), 'NX', queueScore(p), url),
      );
      added += Number(r) || 0;
    } catch (e) {
      /* best-effort */
    }
  }
  return added;
}

// Atomically claim up to `count` highest-priority URLs (ZPOPMIN returns a flat
// [member, score, ...] list). Safe across multiple consumer instances.
async function dequeue(count) {
  if (!enabled || !client) return [];
  const n = Math.max(1, count || 1);
  const rows = await Promise.resolve()
    .then(() => client.zpopmin(queueKey(), n))
    .catch(() => []);
  const out = [];
  for (let i = 0; i + 1 < rows.length; i += 2) out.push(rows[i]);
  return out;
}

// Re-enqueue a failed URL (lower priority) until it has burned queueMaxAttempts,
// then drop it. Returns true if re-enqueued, false if dropped.
async function requeue(url, priority) {
  if (!enabled || !client) return false;
  const u = util.getUrl(url);
  const attempts = await Promise.resolve()
    .then(() => client.hincrby(queueAttemptsKey(), u, 1))
    .catch(() => config.queueMaxAttempts);
  if (attempts >= config.queueMaxAttempts) {
    await Promise.resolve().then(() => client.hdel(queueAttemptsKey(), u)).catch(() => {});
    return false;
  }
  const p = Number.isFinite(priority) ? priority : 2;
  await Promise.resolve().then(() => client.zadd(queueKey(), 'NX', queueScore(p), u)).catch(() => {});
  return true;
}

// Clear the attempt counter for a URL that rendered successfully.
function clearAttempt(url) {
  if (!enabled || !client) return Promise.resolve();
  return Promise.resolve()
    .then(() => client.hdel(queueAttemptsKey(), util.getUrl(url)))
    .catch(() => {});
}

function queueDepth() {
  if (!enabled || !client) return Promise.resolve(0);
  return Promise.resolve()
    .then(() => client.zcard(queueKey()))
    .then((n) => n || 0)
    .catch(() => 0);
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

// --- per-domain stats (count / age / buckets) from the index ZSET ---
function zeroBuckets() {
  return { '<1h': 0, '1-24h': 0, '1-7d': 0, '7-30d': 0, '>30d': 0 };
}
function bucketOf(ageMs) {
  if (ageMs < 3600e3) return '<1h';
  if (ageMs < 86400e3) return '1-24h';
  if (ageMs < 7 * 86400e3) return '1-7d';
  if (ageMs < 30 * 86400e3) return '7-30d';
  return '>30d';
}
function newAgg() {
  return {
    count: 0,
    sumAge: 0,
    oldest: null,
    newest: null,
    buckets: zeroBuckets(),
  };
}
function accum(agg, storedAt, ageMs) {
  agg.count++;
  agg.sumAge += ageMs;
  if (agg.oldest === null || storedAt < agg.oldest) agg.oldest = storedAt;
  if (agg.newest === null || storedAt > agg.newest) agg.newest = storedAt;
  agg.buckets[bucketOf(ageMs)]++;
}
function finalize(agg) {
  return {
    count: agg.count,
    avgAgeMs: agg.count ? Math.round(agg.sumAge / agg.count) : 0,
    oldestStoredAt: agg.oldest,
    newestStoredAt: agg.newest,
    buckets: agg.buckets,
  };
}

async function computeStatsByDomain() {
  const rows = await client.zrange(indexKey(), 0, -1, 'WITHSCORES');
  const entries = parseZsetWithScores(rows || []);
  const now = Date.now();
  const g = newAgg();
  const map = new Map();
  for (const e of entries) {
    const host = hostOf(e.url);
    const age = now - e.storedAt;
    let d = map.get(host);
    if (!d) {
      d = newAgg();
      map.set(host, d);
    }
    accum(d, e.storedAt, age);
    accum(g, e.storedAt, age);
  }
  const domains = [...map.entries()]
    .map(([domain, agg]) => Object.assign({ domain }, finalize(agg)))
    .sort((a, b) => b.count - a.count);
  return {
    enabled: true,
    computedAt: now,
    cacheTtlMs: config.statsCacheTtlMs,
    global: finalize(g),
    domains,
    domainCount: domains.length,
  };
}

// Memoized (TTL) + in-flight-deduped so dashboard loads don't each scan ~150k.
function statsByDomain() {
  if (!enabled || !client) return Promise.resolve({ enabled: false });
  const now = Date.now();
  if (
    statsByDomainCache &&
    now - statsByDomainCachedAt < config.statsCacheTtlMs
  ) {
    return Promise.resolve(statsByDomainCache);
  }
  if (statsByDomainInFlight) return statsByDomainInFlight;
  statsByDomainInFlight = computeStatsByDomain()
    .then((payload) => {
      statsByDomainCache = payload;
      statsByDomainCachedAt = Date.now();
      statsByDomainInFlight = null;
      return payload;
    })
    .catch((e) => {
      statsByDomainInFlight = null;
      throw e;
    });
  return statsByDomainInFlight;
}

// --- render/fallback metrics (persistent Redis counters, per-domain) ---
function incrMetric(field, url, n = 1) {
  if (!enabled || !client) return Promise.resolve();
  // best-effort; never blocks/breaks a render. Returns the promise for tests.
  return Promise.resolve()
    .then(() => client.hincrby(metricsKey(), `${field}|${hostOf(url)}`, n))
    .catch(() => {});
}

// Parse a flat metrics HASH (`<metric>|<host>` -> count) into { global, domains }.
function parseMetricsFlat(flat) {
  const global = {};
  METRIC_FIELDS.forEach((f) => (global[f] = 0));
  const byDomain = {};
  for (const key of Object.keys(flat || {})) {
    const idx = key.lastIndexOf('|');
    if (idx < 0) continue;
    const metric = key.slice(0, idx);
    const domain = key.slice(idx + 1);
    if (METRIC_FIELDS.indexOf(metric) < 0) continue;
    const v = Number(flat[key]) || 0;
    if (!byDomain[domain]) {
      byDomain[domain] = {};
      METRIC_FIELDS.forEach((f) => (byDomain[domain][f] = 0));
    }
    byDomain[domain][metric] += v;
    global[metric] += v;
  }
  return {
    global,
    domains: Object.keys(byDomain).map((domain) =>
      Object.assign({ domain }, byDomain[domain]),
    ),
  };
}

async function metrics() {
  if (!enabled || !client) return { enabled: false };
  const flat = (await client.hgetall(metricsKey())) || {};
  const parsed = parseMetricsFlat(flat);
  return {
    enabled: true,
    label: config.metricsLabel,
    computedAt: Date.now(),
    global: parsed.global,
    domains: parsed.domains,
  };
}

// Every deployment shares Redis, so any instance can report ALL labels' metrics
// by scanning the per-label HASHes. Lets the dashboard ingest on-demand +
// scheduled (etc.) from a single endpoint instead of one label per instance.
async function metricsAllLabels() {
  if (!enabled || !client) return { enabled: false };
  const prefix = `${config.keyPrefix}:v1:metrics:`;
  const keys = [];
  let cursor = '0';
  do {
    let res;
    try {
      res = await client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
    } catch (e) {
      break;
    }
    cursor = res[0];
    (res[1] || []).forEach((k) => keys.push(k));
  } while (cursor !== '0');
  const labels = {};
  for (const key of keys) {
    const label = key.slice(prefix.length);
    if (!label) continue;
    const flat = await Promise.resolve()
      .then(() => client.hgetall(key))
      .catch(() => ({}));
    labels[label] = parseMetricsFlat(flat || {});
  }
  return { enabled: true, computedAt: Date.now(), labels };
}

// --- admin: flush (start-fresh reset) --------------------------------------

// SCAN + delete every key matching a glob pattern. Returns the count deleted.
// Uses UNLINK (non-blocking) when the client supports it, else DEL.
async function scanDel(pattern) {
  let cursor = '0';
  let count = 0;
  do {
    let res;
    try {
      res = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    } catch (e) {
      break;
    }
    cursor = res[0];
    const keys = res[1] || [];
    if (keys.length > 0) {
      try {
        if (typeof client.unlink === 'function') await client.unlink(...keys);
        else await client.del(...keys);
        count += keys.length;
      } catch (e) {
        /* best-effort */
      }
    }
  } while (cursor !== '0');
  return count;
}

// Wipe cached content and/or metrics so the system can start fresh. Best-effort
// (each step degrades independently) but reports what it cleared.
//   opts.cache   -> delete ALL bodies (Spaces objects under <prefix>v1/html/, or
//                   Redis html keys) + the index/status/queue/attempts/lock keys.
//                   Every page then re-renders live on next request.
//   opts.metrics -> delete every per-label metrics HASH (prerender:v1:metrics:*)
//                   so the dashboard's live counters reset to zero.
// Returns { store, bodies, structuralKeys, metricsLabels }.
async function flush(opts) {
  if (!enabled || !client) throw new Error('cache disabled');
  const o = opts || {};
  const summary = { store: config.store, bodies: 0, structuralKeys: 0, metricsLabels: 0 };

  if (o.cache) {
    if (config.store === 'spaces') {
      summary.bodies = await objectStore
        .deleteAllUnderPrefix(`${config.spaces.prefix}v1/html/`)
        .catch(() => 0);
    } else {
      summary.bodies = await scanDel(`${config.keyPrefix}:v1:html:*`);
    }
    // Structural keys: the refresh index, per-URL status, work queue + attempts.
    for (const key of [indexKey(), statusKey(), queueKey(), queueAttemptsKey()]) {
      // eslint-disable-next-line no-await-in-loop
      const n = await Promise.resolve()
        .then(() => client.del(key))
        .catch(() => 0);
      summary.structuralKeys += Number(n) || 0;
    }
    // Single-flight locks are short-TTL, but clear any in-flight ones too.
    summary.structuralKeys += await scanDel(`${config.keyPrefix}:v1:lock:*`);
    // Drop the per-domain stats memo so the next read recomputes from empty.
    statsByDomainCache = null;
    statsByDomainCachedAt = 0;
  }

  if (o.metrics) {
    summary.metricsLabels = await scanDel(`${config.keyPrefix}:v1:metrics:*`);
  }

  return summary;
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

    // No-store: never read, lock, or write the cache for this request. Render
    // live and serve it straight through (dev/staging sites).
    if (isNoStore(req)) {
      p._cacheNoStore = true;
      logEvt('no-store', { url: p.url });
      return next();
    }

    if (isBypass(req)) {
      p._cacheBypass = true;
      logEvt('bypass', { url: p.url });
      return next();
    }

    p._cacheStart = Date.now();
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
    // No-store: result is intentionally not persisted. No lock was taken in
    // requestReceived, so there's nothing to release — just pass through.
    // (Explicit guard so this holds even when single-flight is disabled, where
    // shouldWrite would otherwise be true.)
    if (p._cacheNoStore) {
      logEvt('store-skip', { url: p.url, reason: 'noStore' });
      return next();
    }

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

    // 4xx is cached but short-lived; 2xx/3xx persist until the manager refreshes.
    const ttlMs = check.code >= 400 ? config.error4xxTtlMs : 0;
    return putBody(p.url, check.code, p.headers, p.content, p.renderId, ttlMs)
      .then(() => safeZAdd(p.url, Date.now()).catch(() => {})) // index for refresh; best-effort
      .then(() => safeHSet(p.url, check.code).catch(() => {})) // per-URL status for /cache/status
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
  dueForRefresh,
  enqueue,
  dequeue,
  requeue,
  clearAttempt,
  queueDepth,
  stats,
  statsByDomain,
  metrics,
  metricsAllLabels,
  incrMetric,
  flush,

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
    statsByDomainCache = null;
    statsByDomainCachedAt = 0;
    statsByDomainInFlight = null;
  },
};
