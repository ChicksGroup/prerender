const fs = require('fs');
const path = require('path');
const http = require('http');
const util = require('./util');
const basename = path.basename;
const server = require('./server');
const express = require('express');
const app = express();
const bodyParser = require('body-parser');
const compression = require('compression');
const redisCache = require('./plugins/redisCache');
const sitemapProxy = require('./sitemapProxy');

// Shared-secret check for the /cache/* routes. They are plain Express routes
// (registered before the catch-all), so they bypass the render plugin pipeline
// and need their own auth. Allows all when PRERENDER_AUTH_TOKEN is unset.
function cacheAuthOk(req) {
  const expected = process.env.PRERENDER_AUTH_TOKEN;
  if (!expected) return true;
  return req.headers['x-prerender-token'] === expected;
}

exports = module.exports = (
  options = {
    logRequests: process.env.PRERENDER_LOG_REQUESTS === 'true',
  },
) => {
  const parsedOptions = Object.assign(
    {},
    {
      port: options.port || process.env.PORT || 3000,
    },
    options,
  );

  server.init(options);
  server.onRequest = server.onRequest.bind(server);

  app.disable('x-powered-by');
  app.use(compression());

  // Liveness: the process is up and serving HTTP. Registered before the
  // catch-all so it isn't treated as a URL to render.
  app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

  // Readiness: the browser is connected and we're not draining for shutdown.
  // The platform health check points here so draining/unhealthy instances are
  // pulled from rotation.
  app.get('/ready', (req, res) => {
    const ready = server.isReady();
    res.status(ready ? 200 : 503).json({
      ready,
      browserConnected: server.isBrowserConnected === true,
      shuttingDown: !!server.isShuttingDown,
      inFlight: server.browserRequestsInFlight
        ? server.browserRequestsInFlight.size
        : null,
    });
  });

  // --- cache introspection (token-protected; drives the cache-manager) ---
  // Batch lookup: which of these URLs are cached, and when were they stored.
  app.post('/cache/status', bodyParser.json({ limit: '8mb' }), (req, res) => {
    if (!cacheAuthOk(req)) return res.sendStatus(403);
    const urls = req.body && req.body.urls;
    if (!Array.isArray(urls))
      return res.status(400).json({ error: 'body.urls must be an array' });
    redisCache
      .status(urls)
      .then((results) => res.json({ results }))
      .catch((e) => res.status(503).json({ error: e.message }));
  });

  // Producer endpoint: seed/refresh URLs land here at a priority (0 = highest);
  // the in-server refresher consumes them at capacity. The in-server seeder
  // (lib/seeder.js) produces in-process; this HTTP route remains for ad-hoc /
  // external producers.
  app.post('/cache/enqueue', bodyParser.json({ limit: '8mb' }), (req, res) => {
    if (!cacheAuthOk(req)) return res.sendStatus(403);
    const urls = req.body && req.body.urls;
    const priority = parseInt(req.body && req.body.priority, 10);
    if (!Array.isArray(urls))
      return res.status(400).json({ error: 'body.urls must be an array' });
    redisCache
      .enqueue(urls, Number.isNaN(priority) ? 1 : priority)
      .then((enqueued) => res.json({ enqueued }))
      .catch((e) => res.status(503).json({ error: e.message }));
  });

  // Oldest cached entries (refresh candidates). ?limit=N&olderThanMs=M
  app.get('/cache/stale', (req, res) => {
    if (!cacheAuthOk(req)) return res.sendStatus(403);
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 10000);
    const olderThanMs = parseInt(req.query.olderThanMs, 10) || 0;
    redisCache
      .stale({ limit, olderThanMs })
      .then((results) => res.json({ results }))
      .catch((e) => res.status(503).json({ error: e.message }));
  });

  // Cache coverage / age summary for observability.
  app.get('/cache/stats', (req, res) => {
    if (!cacheAuthOk(req)) return res.sendStatus(403);
    Promise.all([redisCache.stats(), redisCache.queueDepth()])
      .then(([s, queueDepth]) => res.json(Object.assign({}, s, { queueDepth })))
      .catch((e) => res.status(503).json({ error: e.message }));
  });

  // On-demand reaper: evict expired-by-policy entries (e.g. 4xx past their drop
  // TTL) the lazy paths haven't cleared. fromStart=true => scan from the head (not
  // the auto-reaper's resume cursor), and maxScan defaults index-covering, so
  // looping until { reaped:0 } is a correct full-drain that also reaches ghosts
  // buried behind a wall of never-refreshed live entries (a small maxScan would
  // re-scan only the head each pass and never reach them). Cluster-locked
  // server-side; a concurrent call returns { skipped:true }. The scheduled
  // refresher runs the resume-paging variant (small maxScan + cursor) on a timer.
  app.post('/cache/reap', bodyParser.json(), (req, res) => {
    if (!cacheAuthOk(req)) return res.sendStatus(403);
    const b = req.body || {};
    const num = (v) => (v == null ? undefined : parseInt(v, 10) || undefined);
    redisCache
      .reapExpired({
        // default high so one looped drain covers the whole index (the scan still
        // stops at end-of-index); maxEvict still bounds deletions per call.
        maxScan: num(b.maxScan != null ? b.maxScan : req.query.maxScan) || 5000000,
        maxEvict: num(b.maxEvict != null ? b.maxEvict : req.query.maxEvict),
        fromStart: true,
      })
      .then((r) => res.json(r))
      .catch((e) => res.status(503).json({ error: e.message }));
  });

  // Per-domain stats (count/avg-age/oldest/newest + age buckets). ?limit=N caps
  // the domains array (0 = all). Memoized server-side (STATS_CACHE_TTL_MS).
  app.get('/cache/stats/domains', (req, res) => {
    if (!cacheAuthOk(req)) return res.sendStatus(403);
    const limit = Math.min(parseInt(req.query.limit, 10) || 0, 5000);
    redisCache
      .statsByDomain()
      .then((s) =>
        res.json(
          limit && s.domains
            ? Object.assign({}, s, { domains: s.domains.slice(0, limit) })
            : s,
        ),
      )
      .catch((e) => res.status(503).json({ error: e.message }));
  });

  // Searchable / paginated listing of cached pages (backs the dashboard Cache page).
  // ?q=&status=2xx|3xx|4xx|404&domain=&sort=storedAt|url|status&dir=asc|desc&offset=0&limit=50
  // (limit is clamped to 200 inside list()).
  app.get('/cache/list', (req, res) => {
    if (!cacheAuthOk(req)) return res.sendStatus(403);
    redisCache
      .list({
        q: (req.query.q || '').toString(),
        status: (req.query.status || '').toString(),
        domain: (req.query.domain || '').toString(),
        sort: (req.query.sort || 'storedAt').toString(),
        dir: (req.query.dir || 'desc').toString(),
        offset: parseInt(req.query.offset, 10) || 0,
        limit: parseInt(req.query.limit, 10) || 50,
      })
      .then((out) => res.json(out))
      .catch((e) => res.status(503).json({ error: e.message }));
  });

  // Delete one or more specific cached pages. Body: { urls: [...] }. The dashboard's
  // per-page "delete" calls this server-side (never a browser); token-protected.
  app.post('/cache/remove', bodyParser.json({ limit: '8mb' }), (req, res) => {
    if (!cacheAuthOk(req)) return res.sendStatus(403);
    const urls = req.body && req.body.urls;
    if (!Array.isArray(urls) || urls.length === 0)
      return res
        .status(400)
        .json({ error: 'body.urls must be a non-empty array' });
    redisCache
      .remove(urls)
      .then((out) => res.json(out))
      .catch((e) => res.status(503).json({ error: e.message }));
  });

  // Bulk-delete every cached page matching a filter. Body: { q, status, domain,
  // pattern } (same filters as /cache/list, plus a JS-regex `pattern` over the full
  // URL — used by the dashboard's no-render purge-on-save). At least one must be set
  // (an empty filter would match the whole cache — use /cache/flush for that).
  // Eviction runs in the BACKGROUND (a broad filter can match a lot) -> 202 +
  // { matched, started }.
  app.post('/cache/remove-matching', bodyParser.json(), (req, res) => {
    if (!cacheAuthOk(req)) return res.sendStatus(403);
    const filter = {
      q: (req.body && req.body.q ? req.body.q : '').toString(),
      status: (req.body && req.body.status ? req.body.status : '').toString(),
      domain: (req.body && req.body.domain ? req.body.domain : '').toString(),
      pattern: (req.body && req.body.pattern ? req.body.pattern : '').toString(),
    };
    redisCache
      .removeMatching(filter)
      .then((out) => res.status(202).json(Object.assign({ ok: true }, out)))
      .catch((e) =>
        e && e.code === 'NO_FILTER'
          ? res.status(400).json({ error: e.message })
          : res.status(503).json({ error: e.message }),
      );
  });

  // Recent fallback EVENTS (capped ring buffer): which pages fell back to the SaaS,
  // whether the fallback was served or failed (and why), and when. ?limit=N (default
  // 200). The dashboard's "Fallbacks" page ingests these into MySQL for durable analysis.
  app.get('/cache/fallback-events', (req, res) => {
    if (!cacheAuthOk(req)) return res.sendStatus(403);
    redisCache
      .fallbackEvents({ limit: req.query && req.query.limit })
      .then((p) => res.json(p))
      .catch((e) => res.status(503).json({ error: e.message }));
  });

  // Per-class cache policy (TTL + expiry action). The dashboard "TTLs" page is the
  // durable owner (MySQL) and pushes here; the fork reads policyKey on a timer.
  app.get('/cache/policy', (req, res) => {
    if (!cacheAuthOk(req)) return res.sendStatus(403);
    redisCache
      .getPolicy()
      .then((p) => res.json(p))
      .catch((e) => res.status(503).json({ error: e.message }));
  });

  // Body: { '2xx': {cache,ttlHours,onExpiry}, '3xx': {...}, '4xx': {...},
  // rules: [{pattern,cache,ttlHours,onExpiry}], noRenderRules: [{pattern,statusCode}] }.
  // Validation errors -> 400; cache disabled -> 503.
  app.post('/cache/policy', bodyParser.json(), (req, res) => {
    if (!cacheAuthOk(req)) return res.sendStatus(403);
    redisCache
      .setPolicy(req.body || {})
      .then((p) => res.json(p))
      .catch((e) =>
        // Only our own validation errors are 400; anything else (cache disabled,
        // Redis write failure) is a 503.
        res
          .status(e && e.code === 'INVALID' ? 400 : 503)
          .json({ error: e.message }),
      );
  });

  // Preview a candidate URL-regex rule: how many currently-cached pages match,
  // a small sample, and which existing rules overlap. Body: { pattern, limit }.
  app.post('/cache/policy/preview', bodyParser.json(), (req, res) => {
    if (!cacheAuthOk(req)) return res.sendStatus(403);
    redisCache
      .previewPattern({
        pattern: req.body && req.body.pattern,
        limit: req.body && req.body.limit,
      })
      .then((p) => res.json(p))
      .catch((e) =>
        res
          .status(e && e.code === 'INVALID' ? 400 : 503)
          .json({ error: e.message }),
      );
  });

  // Admin-managed sitemap list (the in-server seeder's single source of truth).
  // The dashboard "Sitemaps" page is the durable owner (MySQL) and pushes here;
  // scheduled instances scan it (lib/seeder.js). GET also reports per-sitemap
  // scan results for the dashboard.
  app.get('/cache/sitemaps', (req, res) => {
    if (!cacheAuthOk(req)) return res.sendStatus(403);
    redisCache
      .getSitemaps()
      .then((p) => res.json(p))
      .catch((e) => res.status(503).json({ error: e.message }));
  });

  // Body: { sitemaps: [{id,url,enabled}] } — full-document replace.
  // Validation errors -> 400; cache disabled / Redis failure -> 503.
  // 1mb limit: a maximal VALID document (50 urls x 2048 chars) tops 100kb,
  // so the bodyParser default would 413 it.
  app.post('/cache/sitemaps', bodyParser.json({ limit: '1mb' }), (req, res) => {
    if (!cacheAuthOk(req)) return res.sendStatus(403);
    redisCache
      .setSitemaps(req.body || {})
      .then((p) => res.json(p))
      .catch((e) =>
        res
          .status(e && e.code === 'INVALID' ? 400 : 503)
          .json({ error: e.message }),
      );
  });

  // Admin: flush cached content and/or metrics so the system can start fresh.
  // Token-protected like the other /cache/* routes; the dashboard's admin
  // "clear cache" / "reset stats" actions call this server-side (never a browser).
  //   { scope: 'cache' }   -> wipe all bodies + index/status/queue/locks
  //   { scope: 'metrics' } -> wipe the per-label render/fallback counters
  //   { scope: 'all' }     -> both
  app.post('/cache/flush', bodyParser.json(), (req, res) => {
    if (!cacheAuthOk(req)) return res.sendStatus(403);
    const scope = (req.body && req.body.scope) || '';
    const cache = scope === 'cache' || scope === 'all';
    const metrics = scope === 'metrics' || scope === 'all';
    if (!cache && !metrics)
      return res
        .status(400)
        .json({ error: "scope must be 'cache', 'metrics', or 'all'" });
    // A cache flush deletes the whole body store; a large Spaces bucket takes far
    // longer than an HTTP request should block, and a synchronous wait trips the
    // caller's upstream timeout (php-fpm/nginx) -> 502. So when the cache is in
    // scope, run it in the BACKGROUND and ack immediately (202) — it's idempotent
    // and safe to re-run. Metrics-only is instant, so do it synchronously and
    // return the counts.
    if (cache) {
      redisCache
        .flush({ cache: true, metrics })
        .then((s) => util.log('[cache/flush] done', JSON.stringify(s)))
        .catch((e) => util.log('[cache/flush] error', e && e.message));
      return res.status(202).json({ ok: true, scope, started: true });
    }
    redisCache
      .flush({ cache: false, metrics: true })
      .then((summary) => res.json(Object.assign({ ok: true, scope }, summary)))
      .catch((e) => res.status(503).json({ error: e.message }));
  });

  // Render/fallback counters (global + per-domain), persistent in Redis.
  app.get('/cache/metrics', (req, res) => {
    if (!cacheAuthOk(req)) return res.sendStatus(403);
    // ?all=1 returns every deployment label's metrics in one response (scans the
    // shared Redis), so the dashboard can ingest on-demand + scheduled at once.
    const all = req.query.all === '1' || req.query.all === 'true';
    const p = all ? redisCache.metricsAllLabels() : redisCache.metrics();
    p.then((m) => res.json(m)).catch((e) =>
      res.status(503).json({ error: e.message }),
    );
  });

  // Sitemap proxy (public, fetch+rewrite; replaces the standalone sitemap service).
  // Registered before the catch-all so these paths aren't treated as URLs to render.
  if (sitemapProxy.enabled()) {
    app.get('/sitemap_index.xml', sitemapProxy.index);
    app.get(/^\/sitemap\/sitemap-(\d+)\.xml$/, (req, res) =>
      sitemapProxy.page(req, res, parseInt(req.params[0], 10)),
    );
  }

  app.get('*', server.onRequest);

  //dont check content-type and just always try to parse body as json
  app.post('*', bodyParser.json({ type: () => true }), server.onRequest);

  // Capture the http.Server handle so graceful shutdown can stop accepting
  // new connections while in-flight renders drain.
  server.httpServer = app.listen(parsedOptions, () =>
    util.log(
      `Prerender server accepting requests on port ${parsedOptions.port}`,
    ),
  );

  // Optional self-driving cache refresher (dedicated instances only). Pulls
  // stale entries and re-renders them when this box has spare Chrome capacity.
  if ((process.env.REFRESHER_MODE || '') === 'true') {
    require('./refresher').start(server, parsedOptions.port);
    // Sitemap seeder: scheduled instances only, and only when there is a cache
    // to diff against. A pure producer (no port — it never renders itself).
    if ((process.env.CACHE_ENABLED || 'false') === 'true') {
      require('./seeder').start(server);
    }
  }

  return server;
};

fs.readdirSync(__dirname + '/plugins').forEach((filename) => {
  if (!/\.js$/.test(filename)) return;

  var name = basename(filename, '.js');

  function load() {
    return require('./plugins/' + name);
  }

  Object.defineProperty(exports, name, {
    value: load,
  });
});
