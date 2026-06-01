// In-server cache refresher (REFRESHER_MODE).
//
// A background loop that, whenever this instance has a free Chrome slot, pulls
// the next stale cached entry and re-renders it — replacing the external worker
// that used to push `/render?...&bypassCache=true` at a guessed fixed rate.
//
// - WHAT is due is decided in-process by redisCache.dueForRefresh() (status-aware,
//   index-driven; no sitemap needed). Seeding NEW urls stays with the cache-manager.
// - HOW we render is a loopback GET to our own /render?...&bypassCache=true, so the
//   full pipeline (auth, whitelist, single-flight, render, cache write, fallback)
//   is reused with zero duplication.
// - Capacity is read straight off server.browserRequestsInFlight, so we fill spare
//   capacity precisely and yield to live traffic (a raced 429 just retries later).
//
// Intended for a DEDICATED instance only (REFRESHER_MODE=true) — never the
// autoscaled on-demand tier.
const http = require('http');
const util = require('./util.js');
const redisCache = require('./plugins/redisCache.js');

function num(v, d) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? d : n;
}

function parseConfig() {
  const maxRenders = num(process.env.MAX_CONCURRENT_RENDERS, 0);
  return {
    concurrency: num(
      process.env.REFRESHER_CONCURRENCY,
      maxRenders > 0 ? maxRenders : 4,
    ),
    refreshTtlMs: num(process.env.REFRESHER_REFRESH_TTL_MS, 86400000), // 2xx: 24h
    redirectTtlMs: num(process.env.REFRESHER_REDIRECT_TTL_MS, 604800000), // 3xx: 7d
    idleIntervalMs: num(process.env.REFRESHER_IDLE_INTERVAL_MS, 60000),
    tickMs: num(process.env.REFRESHER_TICK_MS, 1000),
    requestTimeoutMs: num(process.env.REFRESHER_REQUEST_TIMEOUT_MS, 75000),
    token: process.env.PRERENDER_AUTH_TOKEN || '',
  };
}

// --- module state ---
let cfg = null;
let server = null;
let port = null;
let renderFn = null; // (url) -> Promise<statusCode>
let dueFn = null; // (opts) -> Promise<string[]>
let timer = null;
let stopped = true;
const inProgress = new Set();

// Loopback render through our own HTTP pipeline (reuses everything). Resolves
// with the status code (incl. 429/503 — which just means "try again later").
function defaultRender(url) {
  return new Promise((resolve, reject) => {
    const path = '/render?url=' + encodeURIComponent(url) + '&bypassCache=true';
    const headers = {};
    if (cfg.token) headers['x-prerender-token'] = cfg.token;
    const req = http.request(
      { host: '127.0.0.1', port: port, path: path, method: 'GET', headers },
      (res) => {
        res.resume(); // drain + discard; we only care that it completed
        res.on('end', () => resolve(res.statusCode));
        res.on('error', reject);
      },
    );
    req.setTimeout(cfg.requestTimeoutMs, () =>
      req.destroy(new Error('refresher render timeout')),
    );
    req.on('error', reject);
    req.end();
  });
}

function launch(url) {
  if (inProgress.has(url)) return;
  inProgress.add(url);
  const t0 = Date.now();
  Promise.resolve()
    .then(() => renderFn(url))
    .then((status) =>
      util.log(
        '[refresher]',
        JSON.stringify({ evt: 'refresh', url: url, status: status, ms: Date.now() - t0 }),
      ),
    )
    .catch((e) =>
      util.log(
        '[refresher]',
        JSON.stringify({ evt: 'refresh-error', url: url, err: e && e.message }),
      ),
    )
    .then(() => inProgress.delete(url));
}

// How many renders we may start right now: bounded by both our own concurrency
// and the box's free Chrome slots (so we never trigger a self-inflicted 429).
function freeSlots() {
  const max = (server && server.options && server.options.maxConcurrentRenders) || 0;
  const inFlight =
    server && server.browserRequestsInFlight ? server.browserRequestsInFlight.size : 0;
  const freeOnBox = max > 0 ? max - inFlight : Infinity;
  return Math.min(freeOnBox, cfg.concurrency - inProgress.size);
}

// One pass: pull due URLs and launch up to the free-slot budget. Returns a small
// summary so the scheduler can pick the next delay. Does NOT schedule itself —
// this is the unit the tests drive directly.
function tickOnce() {
  if (stopped || (server && server.isShuttingDown)) {
    return Promise.resolve({ stopped: true });
  }
  const slots = freeSlots();
  if (slots <= 0) return Promise.resolve({ slots: 0, launched: 0 });
  return Promise.resolve()
    .then(() =>
      dueFn({
        limit: slots,
        exclude: inProgress,
        refreshTtlMs: cfg.refreshTtlMs,
        redirectTtlMs: cfg.redirectTtlMs,
      }),
    )
    .then((urls) => {
      const picked = (urls || []).slice(0, slots);
      picked.forEach(launch);
      return { launched: picked.length, idle: picked.length === 0 };
    });
}

function schedule(ms) {
  if (stopped) return;
  timer = setTimeout(tick, ms);
}

function tick() {
  timer = null;
  if (stopped || (server && server.isShuttingDown)) return stop();
  tickOnce()
    .then((r) => schedule(r && r.idle ? cfg.idleIntervalMs : cfg.tickMs))
    .catch((e) => {
      util.log('[refresher]', JSON.stringify({ evt: 'tick-error', err: e && e.message }));
      schedule(cfg.idleIntervalMs);
    });
}

// Start the loop. `deps` is a test seam: { render, dueForRefresh, manual }.
function start(srv, srvPort, deps) {
  deps = deps || {};
  cfg = parseConfig();
  server = srv;
  port = srvPort;
  renderFn = deps.render || defaultRender;
  dueFn = deps.dueForRefresh || ((o) => redisCache.dueForRefresh(o));
  stopped = false;
  inProgress.clear();
  util.log(
    '[refresher] started',
    JSON.stringify({
      concurrency: cfg.concurrency,
      refreshTtlMs: cfg.refreshTtlMs,
      redirectTtlMs: cfg.redirectTtlMs,
    }),
  );
  if (deps.manual) return; // tests drive tickOnce() themselves
  schedule(0);
}

// Stop launching new work and clear the timer. In-flight loopback renders keep
// running — server.shutdown()'s drain loop already waits for them (they're in
// browserRequestsInFlight). Idempotent and safe even if start() never ran.
function stop() {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

module.exports = {
  start,
  stop,
  // --- test seams ---
  _tickOnce: tickOnce,
  _inProgress: () => inProgress,
  _parseConfig: parseConfig,
};
