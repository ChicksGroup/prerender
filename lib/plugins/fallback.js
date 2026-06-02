// Fallback to a SaaS prerender (prerender.io) when our own render can't be
// served — capacity (429), render error (5xx), or timeout. The SaaS response is
// returned to the caller AND written to our cache (so the next request is a
// local hit — the cache self-heals). Gated by FALLBACK_ENABLED (+ a token).
//
// Triggered from two places:
//   - lib/server.js onRequest (the concurrency-cap 429, before Chrome runs)
//   - this plugin's beforeSend hook (render failures that reach finish())
// Register this plugin BEFORE redisCache so its beforeSend runs first and the
// cache then stores the fallback content.
const http = require('http');
const https = require('https');
const { URL } = require('url');
const util = require('../util.js');
const redisCache = require('./redisCache');

let cfg = null;

function parseConfig() {
  const codes = (process.env.FALLBACK_STATUS_CODES || '429,500,502,503,504')
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !Number.isNaN(n));
  return {
    enabled: (process.env.FALLBACK_ENABLED || 'false') === 'true',
    baseUrl: (
      process.env.FALLBACK_URL || 'https://service.prerender.io'
    ).replace(/\/$/, ''),
    token: process.env.FALLBACK_TOKEN || process.env.PRERENDER_IO_TOKEN || '',
    timeoutMs: parseInt(process.env.FALLBACK_TIMEOUT_MS || '25000', 10),
    statusCodes: new Set(codes),
    // Test aid: route EVERY request straight to the SaaS fallback (skip local
    // render). Verifies the fallback + caching path without inducing a failure.
    force: (process.env.FALLBACK_FORCE || 'false') === 'true',
  };
}

function enabled() {
  return !!(cfg && cfg.enabled && cfg.token);
}

function shouldFallback(statusCode) {
  return enabled() && cfg.statusCodes.has(parseInt(statusCode, 10));
}

// When true, onRequest routes everything to the fallback (testing only).
function forced() {
  return enabled() && cfg.force;
}

function logEvt(evt, data) {
  util.log('[fallback]', JSON.stringify(Object.assign({ evt }, data || {})));
}

// Real outbound fetch to the SaaS prerender (path-style: <base>/<targetUrl>).
// Returns { statusCode, headers, content } or null if the fallback also failed.
function realFetch(targetUrl) {
  return new Promise((resolve) => {
    let base;
    try {
      base = new URL(cfg.baseUrl);
    } catch (e) {
      return resolve({ error: true, reason: 'config' });
    }
    const lib = base.protocol === 'https:' ? https : http;
    const basePath = base.pathname === '/' ? '' : base.pathname;
    const options = {
      method: 'GET',
      hostname: base.hostname,
      port: base.port || (base.protocol === 'https:' ? 443 : 80),
      path: basePath + '/' + targetUrl,
      headers: {
        'X-Prerender-Token': cfg.token,
        'User-Agent': 'prerender-fallback',
      },
    };
    const req = lib.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const status = res.statusCode;
        // The fallback itself failed — don't serve/cache a SaaS error. Return a
        // reason (instead of bare null) so the failure log can say WHY.
        if (status >= 500)
          return resolve({ error: true, reason: 'saas_5xx', saasStatus: status });
        if (status === 429)
          return resolve({ error: true, reason: 'saas_429', saasStatus: status });
        const content = Buffer.concat(chunks).toString('utf8');
        const headers = {};
        if (res.headers['content-type'])
          headers['content-type'] = res.headers['content-type'];
        if (res.headers['location'])
          headers['location'] = res.headers['location'];
        // A redirect (3xx with a Location) is a valid prerender result even with an
        // empty body — persist the status + Location and serve it. Only a
        // NON-redirect with no body is a true 'empty' failure.
        if (status >= 300 && status < 400 && headers.location)
          return resolve({ statusCode: status, headers, content, redirect: true });
        if (!content)
          return resolve({ error: true, reason: 'empty', saasStatus: status });
        resolve({ statusCode: status, headers, content });
      });
    });
    req.setTimeout(cfg.timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', (e) =>
      resolve({ error: true, reason: e && e.message === 'timeout' ? 'timeout' : 'network' }),
    );
    req.end();
  });
}

let fetchImpl = realFetch;

function fetchFallback(targetUrl) {
  return Promise.resolve()
    .then(() => fetchImpl(targetUrl))
    .catch(() => null);
}

// Apply a successful fallback result onto req.prerender so the normal finish()
// path serves it and the cache plugin (running after this one) stores it.
function apply(req, res, result) {
  req.prerender.statusCode = result.statusCode;
  req.prerender.content = result.content;
  req.prerender.headers = result.headers;
  req.prerender._cacheBypass = true; // force the cache write of the fallback result
  req.prerender._fromFallback = true; // prevent re-entry
  try {
    res.setHeader('X-Prerender-Fallback', 'prerender.io');
  } catch (e) {
    /* headers may already be sent in odd cases */
  }
}

module.exports = {
  init: () => {
    cfg = parseConfig();
    if (cfg.enabled && !cfg.token) {
      util.log(
        'warning: FALLBACK_ENABLED but no FALLBACK_TOKEN set — fallback is inactive',
      );
    }
    util.log(
      `[fallback] ${enabled() ? 'enabled -> ' + cfg.baseUrl : 'disabled'}`,
    );
  },

  // Render-failure path: our render finished with a bad status -> try the SaaS.
  beforeSend: (req, res, next) => {
    if (!enabled() || req.prerender._fromFallback) return next();
    const code =
      parseInt(req.prerender.statusCode, 10) ||
      (req.server &&
        req.server.options &&
        req.server.options.renderErrorStatusCode) ||
      504;
    if (!cfg.statusCodes.has(code)) return next();

    return fetchFallback(req.prerender.url)
      .then((result) => {
        // Served = any non-error result (HTML with a body, OR a 3xx redirect whose
        // body is empty but carries a Location). Failures are {error:true, reason}.
        if (result && !result.error) {
          apply(req, res, result);
          redisCache.incrMetric('fallback_render', req.prerender.url);
          redisCache.recordFallbackEvent({
            url: req.prerender.url,
            trigger: code,
            outcome: 'served',
            status: result.statusCode,
          });
          logEvt('fallback-served', {
            url: req.prerender.url,
            after: code,
            status: result.statusCode,
          });
        } else {
          const reason = result && result.reason ? result.reason : 'unknown';
          redisCache.incrMetric('fallback_failed', req.prerender.url);
          redisCache.recordFallbackEvent({
            url: req.prerender.url,
            trigger: code,
            outcome: 'failed',
            reason,
          });
          logEvt('fallback-failed', { url: req.prerender.url, after: code, reason });
        }
        next();
      })
      .catch(() => next());
  },

  // helpers used by lib/server.js (capacity-429 path) and tests
  enabled,
  shouldFallback,
  forced,
  fetchFallback,
  apply,

  _setFetchForTests: (fn) => {
    fetchImpl = fn;
  },
  _setConfigForTests: (overrides) => {
    cfg = Object.assign(parseConfig(), overrides || {});
  },
  _reset: () => {
    cfg = null;
    fetchImpl = realFetch;
  },
};
