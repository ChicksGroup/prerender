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

// List snapshot memo: the raw [{url, storedAt, status, domain}] joined from the
// index ZSET + status HASH that backs the dashboard Cache page. Same TTL +
// in-flight-dedupe discipline as the per-domain stats memo above, so repeated
// page/sort/filter loads don't each re-scan the whole index.
let listSnapshotCache = null;
let listSnapshotCachedAt = 0;
let listSnapshotInFlight = null;

// Admin-tunable per-class cache policy (TTL + expiry action). Durable source of
// truth is the dashboard's MySQL; this is the runtime copy the dashboard pushes
// into Redis (policyKey) and every instance re-reads on a timer. policyOverrides
// is the stored object ({} = use defaults = historical behavior).
let policyOverrides = {};
let policyLoadedAt = 0;
let policyInFlight = null;
let policyTimer = null;
// Compiled URL-regex rules: [{ id, pattern, re, cache, ttlMs, onExpiry }]. A rule
// overrides the status-class policy for URLs its regex matches (first match wins,
// top-to-bottom). Empty by default (= class-only behavior).
let compiledRules = [];
// Compiled no-render rules: [{ id, pattern, re, statusCode }]. A URL matching one
// is never rendered, cached, or served from cache — the request short-circuits in
// requestReceived and returns statusCode with an empty body. Highest precedence
// (above cache hits and URL-regex/class TTL policy). Empty by default.
let compiledNoRender = [];

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
    // Max fallback-FAILURE events kept in the Redis ring buffer (read via
    // /cache/fallback-failures; the dashboard ingests them into MySQL for history).
    // Guard a non-numeric/zero/negative env value -> always a positive int so LTRIM
    // gets a valid stop index (otherwise NaN would silently skip the cap).
    fallbackLogMax: Math.max(1, parseInt(process.env.FALLBACK_LOG_MAX || '2000', 10) || 2000),
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
    // Default per-class cache TTLs (ms) for the admin-tunable policy. These mirror
    // the historical behavior so an UNSET policy === today: 2xx/3xx refresh on these
    // cadences, 4xx drops after error4xxTtlMs. The dashboard "TTLs" page overrides
    // them at runtime (durable in the dashboard's MySQL, pushed into policyKey here).
    ttl2xxMs: parseInt(process.env.REFRESHER_REFRESH_TTL_MS || '86400000', 10),
    ttl3xxMs: parseInt(
      process.env.REFRESHER_REDIRECT_TTL_MS || '604800000',
      10,
    ),
    // How often each instance re-reads the policy key from Redis (settings
    // propagate cluster-wide within this window; also self-heals a Redis restart
    // once the dashboard re-pushes from MySQL).
    policyTtlMs: parseInt(process.env.CACHE_POLICY_TTL_MS || '30000', 10),
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
// Capped list (newest-first via LPUSH) of recent fallback FAILURE events, each a
// JSON {id,at,url,host,trigger,reason}. Read by /cache/fallback-failures; ingested
// into the dashboard's MySQL for the "Fallbacks" analysis log.
function fallbackKey() {
  return `${config.keyPrefix}:v1:fallback-failures`;
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

// --- per-class cache policy (admin-tunable TTL + expiry action) ----------------
// Each class ('2xx'|'3xx'|'4xx') is either not cached, or cached with a TTL and an
// on-expiry action: 'refresh' (re-render in place; a copy is always served),
// 'drop' (hard-evict after the TTL), or 'keep' (cache indefinitely). Defaults
// reproduce the historical behavior exactly, so an unset policy changes nothing.
const HOUR_MS = 3600000;
// Status codes an admin may return from a no-render rule. Constrained on purpose:
// no 3xx (those need a Location), no 5xx (the server treats those as render-error
// / fallback triggers). 410 Gone is the default (best de-index signal for crawlers).
const NO_RENDER_STATUS = [410, 404, 403, 451, 204];
const NO_RENDER_DEFAULT_STATUS = 410;
function policyKey() {
  return `${config.keyPrefix}:v1:policy`;
}
// HTTP code -> class bucket, or null (sub-2xx / 5xx are never policy-managed).
function classOf(code) {
  if (!Number.isFinite(code)) return null;
  if (code >= 200 && code < 300) return '2xx';
  if (code >= 300 && code < 400) return '3xx';
  if (code >= 400 && code < 500) return '4xx';
  return null;
}
function policyDefaults() {
  return {
    '2xx': { cache: true, ttlMs: config.ttl2xxMs, onExpiry: 'refresh' },
    '3xx': { cache: true, ttlMs: config.ttl3xxMs, onExpiry: 'refresh' },
    '4xx': { cache: true, ttlMs: config.error4xxTtlMs, onExpiry: 'drop' },
  };
}
function classOverridden(cls) {
  return Object.prototype.hasOwnProperty.call(policyOverrides, cls);
}
// Defaults merged with any stored overrides -> { cache, ttlMs, onExpiry } per class.
function effectivePolicy() {
  const def = policyDefaults();
  const out = {};
  for (const cls of ['2xx', '3xx', '4xx']) {
    const o = policyOverrides[cls];
    if (o && typeof o === 'object') {
      const cache = o.cache !== false;
      const onExpiry =
        ['refresh', 'drop', 'keep'].indexOf(o.onExpiry) > -1
          ? o.onExpiry
          : def[cls].onExpiry;
      const hrs = Number(o.ttlHours);
      const ttlMs = hrs > 0 ? Math.round(hrs * HOUR_MS) : def[cls].ttlMs;
      out[cls] = { cache, ttlMs, onExpiry };
    } else {
      out[cls] = def[cls];
    }
  }
  return out;
}
// Compile raw rules into matchable form. A bad regex is skipped + logged, never
// thrown — a poisoned policy value must not disable caching cluster-wide.
function compileRules(raw) {
  const out = [];
  if (!Array.isArray(raw)) return out;
  for (const r of raw) {
    if (!r || typeof r !== 'object' || typeof r.pattern !== 'string') continue;
    let re;
    try {
      re = new RegExp(r.pattern);
    } catch (e) {
      logEvt('rule-compile-skip', { pattern: r.pattern, err: e && e.message });
      continue;
    }
    const hrs = Number(r.ttlHours);
    out.push({
      id: r.id,
      pattern: r.pattern,
      re,
      cache: r.cache !== false,
      ttlMs: hrs > 0 ? Math.round(hrs * HOUR_MS) : config.error4xxTtlMs,
      onExpiry:
        ['refresh', 'drop', 'keep'].indexOf(r.onExpiry) > -1
          ? r.onExpiry
          : 'refresh',
    });
  }
  return out;
}
// First compiled rule (top-to-bottom) whose regex matches the normalized URL, or
// null. Cheap early-out when no rules are configured (the common case).
function matchRule(url) {
  if (compiledRules.length === 0) return null;
  for (const r of compiledRules) {
    if (r.re.test(url)) {
      return { cache: r.cache, ttlMs: r.ttlMs, onExpiry: r.onExpiry };
    }
  }
  return null;
}
// Compile raw no-render rules into matchable form. Mirrors compileRules: a bad
// regex is skipped + logged, never thrown. statusCode falls back to the default
// if missing/invalid (the dashboard constrains it, but be defensive here too).
function compileNoRenderRules(raw) {
  const out = [];
  if (!Array.isArray(raw)) return out;
  for (const r of raw) {
    if (!r || typeof r !== 'object' || typeof r.pattern !== 'string') continue;
    let re;
    try {
      re = new RegExp(r.pattern);
    } catch (e) {
      logEvt('norender-compile-skip', { pattern: r.pattern, err: e && e.message });
      continue;
    }
    const code = parseInt(r.statusCode, 10);
    out.push({
      id: r.id,
      pattern: r.pattern,
      re,
      statusCode: NO_RENDER_STATUS.indexOf(code) > -1 ? code : NO_RENDER_DEFAULT_STATUS,
    });
  }
  return out;
}
// First no-render rule whose regex matches the normalized URL, or null. Checked
// before the cache read in requestReceived, so it wins over everything. Cheap
// early-out when none are configured (the common case).
function matchNoRender(url) {
  if (compiledNoRender.length === 0) return null;
  for (const r of compiledNoRender) {
    if (r.re.test(url)) return { statusCode: r.statusCode };
  }
  return null;
}
// The effective policy for a specific URL: a matching regex rule wins, else the
// status-class policy. Returns { cache, ttlMs, onExpiry } or null (no rule and no
// policy-managed class — e.g. a 5xx that never reaches here).
function resolveForUrl(url, code) {
  const r = matchRule(url);
  if (r) return r;
  const cls = classOf(code);
  return cls ? effectivePolicy()[cls] : null;
}

// Best-effort: pull the override object from Redis into the in-process copy.
function loadPolicy() {
  if (!enabled || !client) return Promise.resolve();
  if (policyInFlight) return policyInFlight;
  policyInFlight = Promise.resolve()
    .then(() => client.get(policyKey()))
    .then((raw) => {
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          if (parsed.classes || parsed.rules || parsed.noRenderRules) {
            // New shape: { classes: {...}, rules: [...], noRenderRules: [...] }.
            policyOverrides =
              parsed.classes && typeof parsed.classes === 'object'
                ? parsed.classes
                : {};
            compiledRules = compileRules(parsed.rules);
            compiledNoRender = compileNoRenderRules(parsed.noRenderRules);
          } else {
            // Legacy shape: a bare class map { '2xx': {...}, ... }.
            policyOverrides = parsed;
            compiledRules = [];
            compiledNoRender = [];
          }
        } else {
          policyOverrides = {};
          compiledRules = [];
          compiledNoRender = [];
        }
      } else {
        policyOverrides = {};
        compiledRules = [];
        compiledNoRender = [];
      }
      policyLoadedAt = Date.now();
      policyInFlight = null;
    })
    .catch(() => {
      // keep the last-known policy on a read/parse error
      policyLoadedAt = Date.now();
      policyInFlight = null;
    });
  return policyInFlight;
}
// Shape the effective policy + defaults for the dashboard (hours, not ms).
function policyToApi() {
  const eff = effectivePolicy();
  const def = policyDefaults();
  const hrs = (ms) => Math.round((ms / HOUR_MS) * 100) / 100;
  const policy = {};
  const defaults = {};
  for (const cls of ['2xx', '3xx', '4xx']) {
    policy[cls] = {
      cache: eff[cls].cache,
      ttlHours: hrs(eff[cls].ttlMs),
      onExpiry: eff[cls].onExpiry,
      custom: classOverridden(cls),
    };
    defaults[cls] = {
      cache: true,
      ttlHours: hrs(def[cls].ttlMs),
      onExpiry: def[cls].onExpiry,
    };
  }
  const rules = compiledRules.map((r) => ({
    id: r.id,
    pattern: r.pattern,
    cache: r.cache,
    ttlHours: hrs(r.ttlMs),
    onExpiry: r.onExpiry,
  }));
  const noRenderRules = compiledNoRender.map((r) => ({
    id: r.id,
    pattern: r.pattern,
    statusCode: r.statusCode,
  }));
  return { policy, defaults, rules, noRenderRules };
}
async function getPolicy() {
  if (!enabled || !client) return { enabled: false };
  await loadPolicy();
  return Object.assign({ enabled: true }, policyToApi());
}
// Validate + persist the override object to Redis (the dashboard is the durable
// store and the caller; this is the runtime copy). Returns the new effective view.
async function setPolicy(input) {
  if (!enabled || !client) throw new Error('cache disabled');
  const inObj = input && typeof input === 'object' ? input : {};
  const overrides = {};
  for (const cls of ['2xx', '3xx', '4xx']) {
    const v = inObj[cls];
    if (!v || typeof v !== 'object') continue; // omitted -> keep default
    const cache = !(
      v.cache === false ||
      v.cache === 'false' ||
      v.cache === 0 ||
      v.cache === '0'
    );
    if (!cache) {
      overrides[cls] = { cache: false };
      continue;
    }
    const hrs = Number(v.ttlHours);
    if (!Number.isFinite(hrs) || hrs <= 0) {
      const e = new Error(`ttlHours for ${cls} must be a positive number`);
      e.code = 'INVALID';
      throw e;
    }
    if (hrs > 87600) {
      const e = new Error(`ttlHours for ${cls} is too large (max 87600)`);
      e.code = 'INVALID';
      throw e;
    }
    const onExpiry =
      ['refresh', 'drop', 'keep'].indexOf(v.onExpiry) > -1
        ? v.onExpiry
        : 'refresh';
    overrides[cls] = { cache: true, ttlHours: hrs, onExpiry };
  }
  // --- URL-regex rules (validate, then conflict-check over the cached set) ---
  const rawRules = Array.isArray(inObj.rules) ? inObj.rules : [];
  if (rawRules.length > 50) {
    const e = new Error('too many rules (max 50)');
    e.code = 'INVALID';
    throw e;
  }
  const rules = [];
  const seenPatterns = new Set();
  for (const r of rawRules) {
    if (!r || typeof r !== 'object') continue;
    const pattern = typeof r.pattern === 'string' ? r.pattern : '';
    if (!pattern) {
      const e = new Error('a rule is missing its pattern');
      e.code = 'INVALID';
      throw e;
    }
    if (pattern.length > 200) {
      const e = new Error('rule pattern is too long (max 200 chars)');
      e.code = 'INVALID';
      throw e;
    }
    try {
      // validate it compiles as a JS RegExp (the runtime matcher)
      new RegExp(pattern); // eslint-disable-line no-new
    } catch (re) {
      const e = new Error(`invalid regex "${pattern}": ${re.message}`);
      e.code = 'INVALID';
      throw e;
    }
    if (seenPatterns.has(pattern)) {
      const e = new Error(`duplicate rule pattern: ${pattern}`);
      e.code = 'INVALID';
      throw e;
    }
    seenPatterns.add(pattern);
    const rcache = !(
      r.cache === false ||
      r.cache === 'false' ||
      r.cache === 0 ||
      r.cache === '0'
    );
    const id =
      typeof r.id === 'string' && r.id
        ? r.id
        : crypto.randomBytes(8).toString('hex');
    if (!rcache) {
      rules.push({ id, pattern, cache: false });
      continue;
    }
    const hrs = Number(r.ttlHours);
    if (!Number.isFinite(hrs) || hrs <= 0) {
      const e = new Error(`ttlHours for rule "${pattern}" must be positive`);
      e.code = 'INVALID';
      throw e;
    }
    if (hrs > 87600) {
      const e = new Error(
        `ttlHours for rule "${pattern}" is too large (max 87600)`,
      );
      e.code = 'INVALID';
      throw e;
    }
    const onExpiry =
      ['refresh', 'drop', 'keep'].indexOf(r.onExpiry) > -1
        ? r.onExpiry
        : 'refresh';
    rules.push({ id, pattern, cache: true, ttlHours: hrs, onExpiry });
  }
  if (rules.length > 1) await assertNoRuleConflicts(rules);

  // --- no-render rules: regex -> fixed status code, never render/cache/serve ---
  const rawNoRender = Array.isArray(inObj.noRenderRules)
    ? inObj.noRenderRules
    : [];
  if (rawNoRender.length > 50) {
    const e = new Error('too many no-render rules (max 50)');
    e.code = 'INVALID';
    throw e;
  }
  const noRenderRules = [];
  const seenNoRender = new Set();
  for (const r of rawNoRender) {
    if (!r || typeof r !== 'object') continue;
    const pattern = typeof r.pattern === 'string' ? r.pattern : '';
    if (!pattern) {
      const e = new Error('a no-render rule is missing its pattern');
      e.code = 'INVALID';
      throw e;
    }
    if (pattern.length > 200) {
      const e = new Error('no-render rule pattern is too long (max 200 chars)');
      e.code = 'INVALID';
      throw e;
    }
    try {
      new RegExp(pattern); // eslint-disable-line no-new
    } catch (re) {
      const e = new Error(`invalid no-render regex "${pattern}": ${re.message}`);
      e.code = 'INVALID';
      throw e;
    }
    if (seenNoRender.has(pattern)) {
      const e = new Error(`duplicate no-render rule pattern: ${pattern}`);
      e.code = 'INVALID';
      throw e;
    }
    seenNoRender.add(pattern);
    const code = parseInt(r.statusCode, 10);
    if (NO_RENDER_STATUS.indexOf(code) === -1) {
      const e = new Error(
        `no-render statusCode for "${pattern}" must be one of ${NO_RENDER_STATUS.join(', ')}`,
      );
      e.code = 'INVALID';
      throw e;
    }
    const id =
      typeof r.id === 'string' && r.id
        ? r.id
        : crypto.randomBytes(8).toString('hex');
    noRenderRules.push({ id, pattern, statusCode: code });
  }

  const persisted = { classes: overrides, rules, noRenderRules };
  await Promise.resolve().then(() =>
    client.set(policyKey(), JSON.stringify(persisted)),
  );
  policyOverrides = overrides;
  compiledRules = compileRules(rules);
  compiledNoRender = compileNoRenderRules(noRenderRules);
  policyLoadedAt = Date.now();
  return Object.assign({ enabled: true }, policyToApi());
}

// Effective-settings signature of a rule, for conflict comparison.
function ruleSig(r) {
  return r.cache === false
    ? 'nocache'
    : `${Math.round(Number(r.ttlHours) * HOUR_MS)}|${r.onExpiry}`;
}
// Reject if any currently-cached URL is matched by two rules with DIFFERING
// effective settings (first-match-wins handles benign/identical overlap). Scans
// the memoized list snapshot; best-effort if the snapshot can't be read.
async function assertNoRuleConflicts(rules) {
  const compiled = rules.map((r) => {
    let re = null;
    try {
      re = new RegExp(r.pattern);
    } catch (e) {
      re = null;
    }
    return { rule: r, re, sig: ruleSig(r) };
  });
  let snap;
  try {
    snap = await getListSnapshot();
  } catch (e) {
    return; // can't read the cache set -> skip the scan (validation still ran)
  }
  for (const row of snap) {
    let first = null;
    for (const c of compiled) {
      if (!c.re || !c.re.test(row.url)) continue;
      if (first === null) {
        first = c;
      } else if (c.sig !== first.sig) {
        const e = new Error(
          `rule "${c.rule.pattern}" conflicts with "${first.rule.pattern}": both match ${row.url} with different settings`,
        );
        e.code = 'INVALID';
        throw e;
      }
    }
  }
}

// Count + sample how many currently-cached pages a regex matches, plus existing
// rules that overlap it (UI hint). Compiles the pattern as a JS RegExp.
async function previewPattern(opts) {
  if (!enabled || !client) return { enabled: false };
  const o = opts || {};
  const pattern = typeof o.pattern === 'string' ? o.pattern : '';
  if (!pattern) {
    const e = new Error('pattern is required');
    e.code = 'INVALID';
    throw e;
  }
  if (pattern.length > 200) {
    const e = new Error('pattern is too long (max 200 chars)');
    e.code = 'INVALID';
    throw e;
  }
  let re;
  try {
    re = new RegExp(pattern);
  } catch (err) {
    const e = new Error(`invalid regex: ${err.message}`);
    e.code = 'INVALID';
    throw e;
  }
  const limit = Math.min(Math.max(1, parseInt(o.limit, 10) || 10), 50);
  const snap = await getListSnapshot();
  const matched = snap.filter((row) => re.test(row.url));
  const sample = matched
    .slice()
    .sort((a, b) => (b.storedAt || 0) - (a.storedAt || 0))
    .slice(0, limit)
    .map((r) => ({ url: r.url, status: r.status, storedAt: r.storedAt }));
  // existing rules that also match at least one of the matched URLs (overlap hint)
  const overlap = new Set();
  for (const r of compiledRules) {
    if (matched.some((row) => r.re.test(row.url))) overlap.add(r.pattern);
  }
  return {
    enabled: true,
    total: snap.length,
    matched: matched.length,
    sample,
    conflictsWith: [...overlap],
  };
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

  // Admin policy: a no-cache status class OR a matching no-cache URL rule means
  // this response is never stored (rule overrides class).
  const policyRes = resolveForUrl(p.url, code);
  if (policyRes && policyRes.cache === false)
    return { ok: false, reason: 'policyNoCache' };

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
// Lazy-evict predicate for the read path: an entry is expired iff its class is
// cached with the 'drop' action and older than its TTL. 'refresh'/'keep' never
// expire on read (refresh re-renders in place; keep persists). Generalizes the
// old 4xx-only rule — by default only 4xx is 'drop', so behavior is unchanged
// until an admin tunes the policy.
function isExpiredByPolicy(url, code, storedAtMs) {
  if (storedAtMs == null) return false;
  const p = resolveForUrl(url, code);
  if (!p) return false; // not policy-managed (no rule, no class) -> never expire
  if (!p.cache) return true; // no-cache rule/class -> drop any leftover on read
  if (p.onExpiry !== 'drop') return false; // refresh/keep never expire on read
  return Date.now() - storedAtMs > p.ttlMs;
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
// TTL, so there a 4xx is reaped lazily on read/status via isExpiredByPolicy instead.
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
        // Spaces has no PX, so reap an expired entry here (treat as a miss).
        if (isExpiredByPolicy(url, code, storedAt)) {
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
    if (entry && isExpiredByPolicy(url, entry.statusCode, entry.storedAt)) {
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
  incrMetric(
    'cache_ms',
    req.prerender.url,
    Date.now() - (req.prerender._cacheStart || Date.now()),
  );
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

// Release the single-flight lock this request acquired in requestReceived, without
// writing anything. The server calls this when it sheds a render at capacity (the
// 429 path, which never reaches beforeSend) so a retry / another instance can render
// immediately instead of waiting out the lock TTL. No-op unless we own the lock and
// single-flight is on. Best-effort.
function releaseLockForRequest(req) {
  const p = req && req.prerender;
  if (!enabled || !client || !p) return Promise.resolve();
  if (p._cacheLockOwner === true && config.singleFlight) {
    return safeReleaseLock(lockKey(p.url), p.renderId).catch(() => {});
  }
  return Promise.resolve();
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
      if (
        storedAt != null &&
        isExpiredByPolicy(normalizedUrl, code, storedAt)
      ) {
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
  const exclude = o.exclude || new Set();
  const now = o.now || Date.now();
  const eff = effectivePolicy();
  // Refresh interval per class: a stored override wins; otherwise the caller's
  // value (the refresher's env) or the default. Only classes whose expiry action
  // is 'refresh' are re-rendered at all — 'drop'/'keep'/'nocache' are skipped.
  const ttl2xx = classOverridden('2xx')
    ? eff['2xx'].ttlMs
    : o.refreshTtlMs || eff['2xx'].ttlMs;
  const ttl3xx = classOverridden('3xx')
    ? eff['3xx'].ttlMs
    : o.redirectTtlMs || eff['3xx'].ttlMs;
  // Scan more than `limit` so fresh/excluded/non-refresh entries at the head don't
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
    // A matching URL rule overrides the class: only refresh-action rules are
    // re-rendered, on the rule's own interval.
    const rule = matchRule(url);
    if (rule) {
      if (!rule.cache || rule.onExpiry !== 'refresh') continue;
      if (storedAt == null || now - storedAt > rule.ttlMs) due.push(url);
      continue;
    }
    const code = codes[i] != null ? parseInt(codes[i], 10) : null;
    const cls = classOf(code);
    // Only 'refresh'-action classes are re-rendered (unknown class -> treat like
    // 2xx, preserving the prior behavior for entries with no recorded status).
    if (cls && (!eff[cls].cache || eff[cls].onExpiry !== 'refresh')) continue;
    // 2xx/unknown use the 2xx interval, 3xx the 3xx interval; a 4xx only reaches
    // here if an admin set its action to 'refresh', so use its own effective TTL.
    const ttl =
      cls === '3xx' ? ttl3xx : cls === '4xx' ? eff['4xx'].ttlMs : ttl2xx;
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
    await Promise.resolve()
      .then(() => client.hdel(queueAttemptsKey(), u))
      .catch(() => {});
    return false;
  }
  const p = Number.isFinite(priority) ? priority : 2;
  await Promise.resolve()
    .then(() => client.zadd(queueKey(), 'NX', queueScore(p), u))
    .catch(() => {});
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
    statusCounts: {}, // HTTP code -> how many cached pages carry it
  };
}
function accum(agg, storedAt, ageMs, code) {
  agg.count++;
  agg.sumAge += ageMs;
  if (agg.oldest === null || storedAt < agg.oldest) agg.oldest = storedAt;
  if (agg.newest === null || storedAt > agg.newest) agg.newest = storedAt;
  agg.buckets[bucketOf(ageMs)]++;
  // Tally by status code (skip entries with no recorded status).
  if (code != null) agg.statusCounts[code] = (agg.statusCounts[code] || 0) + 1;
}
function finalize(agg) {
  return {
    count: agg.count,
    avgAgeMs: agg.count ? Math.round(agg.sumAge / agg.count) : 0,
    oldestStoredAt: agg.oldest,
    newestStoredAt: agg.newest,
    buckets: agg.buckets,
    statusCounts: agg.statusCounts,
  };
}

async function computeStatsByDomain() {
  const rows = await client.zrange(indexKey(), 0, -1, 'WITHSCORES');
  const entries = parseZsetWithScores(rows || []);
  // One HGETALL of the parallel status HASH so the coverage view can break the
  // cache down by HTTP code (e.g. 200 = N, 301 = N, 404 = N) per-domain + global.
  const statusMap =
    (await Promise.resolve()
      .then(() => client.hgetall(statusKey()))
      .catch(() => ({}))) || {};
  const now = Date.now();
  const g = newAgg();
  const map = new Map();
  for (const e of entries) {
    const host = hostOf(e.url);
    const age = now - e.storedAt;
    const raw = statusMap[e.url];
    const parsed = raw != null ? parseInt(raw, 10) : null;
    const code = parsed != null && !Number.isNaN(parsed) ? parsed : null;
    let d = map.get(host);
    if (!d) {
      d = newAgg();
      map.set(host, d);
    }
    accum(d, e.storedAt, age, code);
    accum(g, e.storedAt, age, code);
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

// --- searchable / paginated cache listing (backs the dashboard Cache page) ---

// Match an HTTP status code against a class ('2xx'|'3xx'|'4xx'|'5xx') or an exact
// code (e.g. '404'). Returns false for a null code (status never recorded).
function matchStatus(code, filter) {
  if (code == null) return false;
  if (/^[2345]xx$/.test(filter)) {
    return Math.floor(code / 100) === parseInt(filter[0], 10);
  }
  const exact = parseInt(filter, 10);
  return !Number.isNaN(exact) && code === exact;
}

// True if at least one of q/status/domain is a non-empty filter. A filtered bulk
// delete REQUIRES this (an all-empty filter would match the whole cache — use the
// dedicated flush for that).
function hasActiveFilter(o) {
  return (
    String((o && o.q) || '').trim() !== '' ||
    String((o && o.status) || '').trim() !== '' ||
    String((o && o.domain) || '').trim() !== '' ||
    String((o && o.pattern) || '').trim() !== ''
  );
}

// Filter snapshot rows by q (case-insensitive URL substring) / domain (exact host)
// / status (class or exact code) / pattern (JS regex over the full URL — used by
// the dashboard's no-render purge-on-save). Shared by list() and removeMatching()
// so the "what you see" and "what gets cleared" sets are computed identically. A
// bad regex matches nothing (rather than throwing and clearing everything).
function applyFilters(rows, o) {
  const q = ((o && o.q) || '').toString().toLowerCase();
  const domain = ((o && o.domain) || '').toString().toLowerCase();
  const statusFilter = ((o && o.status) || '').toString();
  const pattern = ((o && o.pattern) || '').toString().trim();
  let out = rows;
  if (q) out = out.filter((r) => r.url.toLowerCase().indexOf(q) > -1);
  if (domain) out = out.filter((r) => r.domain === domain);
  if (statusFilter)
    out = out.filter((r) => matchStatus(r.status, statusFilter));
  if (pattern) {
    let re = null;
    try {
      re = new RegExp(pattern);
    } catch (e) {
      re = null;
    }
    out = re ? out.filter((r) => re.test(r.url)) : [];
  }
  return out;
}

// Null both in-process memos so the next read recomputes from the live index.
function invalidateMemos() {
  listSnapshotCache = null;
  listSnapshotCachedAt = 0;
  statsByDomainCache = null;
  statsByDomainCachedAt = 0;
}

// Evict one already-normalized URL (body + index + status) and clear its
// queue-attempt counter. Best-effort.
function evictOne(url) {
  return evict(url).then(() =>
    Promise.resolve()
      .then(() => client.hdel(queueAttemptsKey(), url))
      .catch(() => {}),
  );
}

// Join the index ZSET (url -> storedAt) with the status HASH (url -> code) into a
// flat [{url, storedAt, status, domain}]. Expired 4xx are dropped here so a stale
// error past CACHE_4XX_TTL_MS never appears in the listing — without per-row
// write-amplifying eviction (real eviction still happens lazily on the next
// status()/getBody() for that URL, or on remove/flush). One ZRANGE + one HGETALL.
async function computeListSnapshot() {
  const rows = await client.zrange(indexKey(), 0, -1, 'WITHSCORES');
  const entries = parseZsetWithScores(rows || []);
  const statusMap =
    (await Promise.resolve()
      .then(() => client.hgetall(statusKey()))
      .catch(() => ({}))) || {};
  const out = [];
  for (const e of entries) {
    const raw = statusMap[e.url];
    const code = raw != null ? parseInt(raw, 10) : null;
    const status = code != null && !Number.isNaN(code) ? code : null;
    if (isExpiredByPolicy(e.url, status, e.storedAt)) continue;
    out.push({
      url: e.url,
      storedAt: e.storedAt,
      status,
      domain: hostOf(e.url),
    });
  }
  return out;
}

// Memoized (TTL) + in-flight-deduped snapshot, mirroring statsByDomain.
function getListSnapshot() {
  const now = Date.now();
  if (
    listSnapshotCache &&
    now - listSnapshotCachedAt < config.statsCacheTtlMs
  ) {
    return Promise.resolve(listSnapshotCache);
  }
  if (listSnapshotInFlight) return listSnapshotInFlight;
  listSnapshotInFlight = computeListSnapshot()
    .then((snap) => {
      listSnapshotCache = snap;
      listSnapshotCachedAt = Date.now();
      listSnapshotInFlight = null;
      return snap;
    })
    .catch((e) => {
      listSnapshotInFlight = null;
      throw e;
    });
  return listSnapshotInFlight;
}

// Filter (q substring / domain / status class|code) + sort + paginate the snapshot
// in Node. limit defaults to 50, hard-capped at 200. Returns one page + the
// filtered total. Cache disabled -> { enabled: false } (like stats/statsByDomain).
async function list(opts) {
  if (!enabled || !client) return { enabled: false };
  const o = opts || {};
  const q = (o.q || '').toString().toLowerCase();
  const statusFilter = (o.status || '').toString();
  const domain = (o.domain || '').toString().toLowerCase();
  const sort =
    ['storedAt', 'url', 'status'].indexOf(o.sort) > -1 ? o.sort : 'storedAt';
  const dir = o.dir === 'asc' ? 1 : -1; // default newest-first (storedAt desc)
  const offset = Math.max(0, parseInt(o.offset, 10) || 0);
  const limit = Math.min(Math.max(1, parseInt(o.limit, 10) || 50), 200);

  const snap = await getListSnapshot();
  let rows = applyFilters(snap, { q, domain, status: statusFilter });

  const total = rows.length;
  rows = rows.slice().sort((a, b) => {
    let cmp;
    if (sort === 'url') cmp = a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
    else if (sort === 'status') cmp = (a.status || 0) - (b.status || 0);
    else cmp = (a.storedAt || 0) - (b.storedAt || 0);
    if (cmp === 0) cmp = (a.storedAt || 0) - (b.storedAt || 0); // stable tiebreak
    return cmp * dir;
  });

  return {
    enabled: true,
    computedAt: listSnapshotCachedAt,
    total,
    offset,
    limit,
    results: rows.slice(offset, offset + limit),
  };
}

// Delete one or more specific cached pages. Each URL is normalized the SAME way
// the write path keys it (util.getUrl), then evicted (body + index + status) and
// its queue-attempt counter cleared. Best-effort per URL. Both the list and the
// per-domain stats memos are invalidated so the next read reflects the deletion
// immediately (no up-to-TTL window where a deleted page still shows).
async function remove(urls) {
  if (!enabled || !client) throw new Error('cache disabled');
  const items = Array.isArray(urls) ? urls : [];
  let removed = 0;
  for (const raw of items) {
    const url = util.getUrl(raw);
    if (!url) continue; // skip empty / malformed
    try {
      // eslint-disable-next-line no-await-in-loop
      await evictOne(url);
      removed += 1;
    } catch (e) {
      /* best-effort per URL */
    }
  }
  invalidateMemos();
  return { removed };
}

// Bulk-delete every cached page matching a filter (q / status / domain) — backs
// the dashboard's admin-only "clear filtered results" action. A broad filter can
// match a huge slice (e.g. all 2xx), so the eviction runs in the BACKGROUND and
// this acks immediately with the matched count — same reason flush() is async (a
// synchronous bulk delete would exceed the dashboard's upstream timeout -> 502).
// Throws if no filter is active (that would match the whole cache; use flush).
async function removeMatching(filter) {
  if (!enabled || !client) throw new Error('cache disabled');
  if (!hasActiveFilter(filter)) {
    const err = new Error('a filter (q, status, domain, or pattern) is required');
    err.code = 'NO_FILTER';
    throw err;
  }
  const snap = await getListSnapshot();
  const urls = applyFilters(snap, filter).map((r) => r.url);

  // Fire-and-forget eviction; the terminal .catch keeps it from becoming an
  // unhandled rejection. Memos are invalidated up front (so a follow-up read
  // recomputes off the shrinking index) and again at the end (final truth).
  invalidateMemos();
  (async () => {
    for (const url of urls) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await evictOne(url);
      } catch (e) {
        /* best-effort per URL */
      }
    }
    invalidateMemos();
    logEvt('remove-matching-done', { matched: urls.length });
  })().catch((e) => logEvt('remove-matching-error', { err: e && e.message }));

  return { matched: urls.length, started: true };
}

// --- render/fallback metrics (persistent Redis counters, per-domain) ---
function incrMetric(field, url, n = 1) {
  if (!enabled || !client) return Promise.resolve();
  // best-effort; never blocks/breaks a render. Returns the promise for tests.
  return Promise.resolve()
    .then(() => client.hincrby(metricsKey(), `${field}|${hostOf(url)}`, n))
    .catch(() => {});
}

// Record a fallback FAILURE event in a capped Redis list (newest-first). Best-effort
// — never blocks/breaks a render. Drives the dashboard's "Fallbacks" analysis log.
//   trigger = the status that made us try the SaaS (429 capacity / 5xx render error /
//             504 timeout)
//   reason  = why the SaaS fallback itself failed (saas_5xx / saas_429 / timeout /
//             network / empty / config / unknown)
function recordFallbackFailure(info) {
  if (!enabled || !client) return Promise.resolve();
  const o = info || {};
  const url = o.url ? String(o.url) : '';
  const trigger = parseInt(o.trigger, 10);
  const evt = {
    id: crypto.randomBytes(8).toString('hex'),
    at: Date.now(),
    url,
    host: hostOf(url),
    trigger: Number.isNaN(trigger) ? null : trigger,
    reason: o.reason ? String(o.reason) : 'unknown',
  };
  return Promise.resolve()
    .then(() => client.lpush(fallbackKey(), JSON.stringify(evt)))
    .then(() => client.ltrim(fallbackKey(), 0, Math.max(0, config.fallbackLogMax - 1)))
    .catch(() => {});
}

// Recent fallback-failure events, newest-first: { enabled, events: [...] }.
function fallbackFailures(opts) {
  if (!enabled || !client) return Promise.resolve({ enabled: false });
  const o = opts || {};
  const limit = Math.min(Math.max(1, parseInt(o.limit, 10) || 200), 5000);
  return Promise.resolve()
    .then(() => client.lrange(fallbackKey(), 0, limit - 1))
    .then((rows) => ({
      enabled: true,
      events: (rows || [])
        .map((r) => {
          try {
            return JSON.parse(r);
          } catch (e) {
            return null;
          }
        })
        .filter(Boolean),
    }))
    .catch(() => ({ enabled: true, events: [] }));
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
  const summary = {
    store: config.store,
    bodies: 0,
    structuralKeys: 0,
    metricsLabels: 0,
  };

  if (o.cache) {
    if (config.store === 'spaces') {
      summary.bodies = await objectStore
        .deleteAllUnderPrefix(`${config.spaces.prefix}v1/html/`)
        .catch(() => 0);
    } else {
      summary.bodies = await scanDel(`${config.keyPrefix}:v1:html:*`);
    }
    // Structural keys: the refresh index, per-URL status, work queue + attempts.
    for (const key of [
      indexKey(),
      statusKey(),
      queueKey(),
      queueAttemptsKey(),
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const n = await Promise.resolve()
        .then(() => client.del(key))
        .catch(() => 0);
      summary.structuralKeys += Number(n) || 0;
    }
    // Single-flight locks are short-TTL, but clear any in-flight ones too.
    summary.structuralKeys += await scanDel(`${config.keyPrefix}:v1:lock:*`);
    // Drop the in-process memos so the next read recomputes from the now-empty
    // index instead of serving ghost entries until the TTL lapses.
    statsByDomainCache = null;
    statsByDomainCachedAt = 0;
    listSnapshotCache = null;
    listSnapshotCachedAt = 0;
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
    // Load the admin cache policy and keep it in sync. Settings live durably in
    // the dashboard's MySQL and are pushed into Redis; re-reading on a timer lets
    // all instances converge and self-heals a Redis restart once the dashboard
    // re-pushes. unref() so it never holds the process open.
    loadPolicy();
    if (!policyTimer) {
      policyTimer = setInterval(() => {
        loadPolicy();
      }, config.policyTtlMs);
      if (policyTimer.unref) policyTimer.unref();
    }
    util.log(
      `[redisCache] enabled, store=${config.store}, prefix=${config.keyPrefix}`,
    );
  },

  // READ + single-flight (runs before Chrome). Auth/whitelist run first.
  requestReceived: (req, res, next) => {
    if (!enabled || !client) return next();

    const p = req.prerender;

    // No-render rules have the HIGHEST precedence — a matching URL is never
    // rendered, cached, or served from cache. Short-circuit with the configured
    // status code and an empty body (mirrors serveFromCache's res.send: no Chrome
    // tab is opened, no single-flight lock is taken, and the in-flight slot is
    // released by the same finish() path as a cache hit). Checked before no-store
    // / bypass and the cache read so it's a hard block across every env.
    const nr = matchNoRender(p.url);
    if (nr) {
      p._noRender = true;
      res.setHeader('X-Prerender-No-Render', '1');
      logEvt('no-render', { url: p.url, status: nr.statusCode });
      return res.send(nr.statusCode, '');
    }

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
    if (p._noRender) return next(); // no-render short-circuit; never persist
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

    // A body TTL (PX) is set only when the effective expiry action is 'drop' (by
    // default just 4xx; a URL rule can override). 'refresh'/'keep' persist (no PX).
    const policyRes = resolveForUrl(p.url, check.code);
    const ttlMs =
      policyRes && policyRes.cache && policyRes.onExpiry === 'drop'
        ? policyRes.ttlMs
        : 0;
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
  list,
  remove,
  removeMatching,
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
  recordFallbackFailure,
  fallbackFailures,
  flush,
  getPolicy,
  setPolicy,
  previewPattern,
  releaseLockForRequest,

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
  _setPolicyForTests: (o) => {
    policyOverrides = o || {};
    policyLoadedAt = Date.now();
  },
  _setRulesForTests: (rules) => {
    compiledRules = compileRules(rules || []);
    policyLoadedAt = Date.now();
  },
  _setNoRenderRulesForTests: (rules) => {
    compiledNoRender = compileNoRenderRules(rules || []);
    policyLoadedAt = Date.now();
  },
  _reset: () => {
    client = null;
    objectStore = null;
    enabled = false;
    config = null;
    statsByDomainCache = null;
    statsByDomainCachedAt = 0;
    statsByDomainInFlight = null;
    listSnapshotCache = null;
    listSnapshotCachedAt = 0;
    listSnapshotInFlight = null;
    policyOverrides = {};
    policyLoadedAt = 0;
    policyInFlight = null;
    compiledRules = [];
    compiledNoRender = [];
    if (policyTimer) {
      clearInterval(policyTimer);
      policyTimer = null;
    }
  },
};
