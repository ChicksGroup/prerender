// In-server cache refresher (REFRESHER_MODE).
//
// A background loop that, whenever this instance has a free Chrome slot, pulls
// the next stale cached entry and re-renders it — replacing the external worker
// that used to push `/render?...&bypassCache=true` at a guessed fixed rate.
//
// - WHAT is due is decided in-process by redisCache.dueForRefresh() (status-aware,
//   index-driven; no sitemap needed). Seeding NEW urls is the in-server sitemap
//   seeder's job (lib/seeder.js), which produces into the queue we drain first.
// - HOW we render is a loopback GET to our own /render?...&bypassCache=true, so the
//   full pipeline (auth, whitelist, single-flight, render, cache write, fallback)
//   is reused with zero duplication.
// - Capacity is read straight off server.browserRequestsInFlight, so we fill spare
//   capacity precisely and yield to live traffic (a raced 429 just retries later).
//
// With REFRESHER_ADAPTIVE=true an in-process controller (see below) auto-tunes the
// effective concurrency toward maximum render throughput instead of a fixed value.
//
// Intended for a DEDICATED instance only (REFRESHER_MODE=true) — never the
// autoscaled on-demand tier.
const http = require('http');
const os = require('os');
const fs = require('fs');
const util = require('./util.js');
const redisCache = require('./plugins/redisCache.js');

function num(v, d) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? d : n;
}
function fnum(v, d) {
  const n = parseFloat(v);
  return Number.isNaN(n) ? d : n;
}

// After settling at a peak, re-probe upward every N evaluation windows in case
// capacity has freed up.
const REPROBE_WINDOWS = 6;

function parseConfig() {
  const maxRenders = num(process.env.MAX_CONCURRENT_RENDERS, 0);
  const concurrency = num(
    process.env.REFRESHER_CONCURRENCY,
    maxRenders > 0 ? maxRenders : 4,
  );
  let minConcurrency = num(process.env.REFRESHER_MIN_CONCURRENCY, 1);
  if (minConcurrency < 1) minConcurrency = 1;
  if (minConcurrency > concurrency) minConcurrency = concurrency;
  const requestTimeoutMs = num(process.env.REFRESHER_REQUEST_TIMEOUT_MS, 75000);
  // Cross-instance claim TTL. It MUST outlive the render — if it expired mid-render
  // another box could claim and double-render the same URL — so the default and
  // floor are derived from the loopback request timeout rather than a bare constant
  // that could silently drift below it when an operator raises the timeout. 0 = off.
  let claimTtlMs = num(process.env.REFRESHER_CLAIM_TTL_MS, requestTimeoutMs + 60000);
  if (claimTtlMs > 0 && claimTtlMs <= requestTimeoutMs) {
    util.log(
      `[refresher] REFRESHER_CLAIM_TTL_MS (${claimTtlMs}) must exceed ` +
        `REFRESHER_REQUEST_TIMEOUT_MS (${requestTimeoutMs}); using ${requestTimeoutMs + 60000}`,
    );
    claimTtlMs = requestTimeoutMs + 60000;
  }
  return {
    concurrency: concurrency, // static value, and the CEILING in adaptive mode
    refreshTtlMs: num(process.env.REFRESHER_REFRESH_TTL_MS, 86400000), // 2xx: 24h
    redirectTtlMs: num(process.env.REFRESHER_REDIRECT_TTL_MS, 604800000), // 3xx: 7d
    // How many index entries dueForRefresh may scan per tick while paging past
    // (and reaping) expired ghosts to find genuinely-due work. Bounds the cost of
    // a recovery pass when the oldest end is clogged with un-evicted dead entries.
    maxScan: num(process.env.REFRESHER_MAX_SCAN, 5000),
    idleIntervalMs: num(process.env.REFRESHER_IDLE_INTERVAL_MS, 60000),
    tickMs: num(process.env.REFRESHER_TICK_MS, 1000),
    // How long a URL whose refresh just FAILED (render timeout / 5xx / transport
    // error) is parked before it's eligible for a time-based refresh again. A
    // failed render writes nothing to the cache, so the index keeps its old
    // score and dueForRefresh would otherwise re-select the same broken URL
    // every tick — crashlooping on it while healthy due work behind it starves.
    // 0 disables the damper. Backpressure (429/503) is NOT a failure here.
    failCooldownMs: num(process.env.REFRESHER_FAIL_COOLDOWN_MS, 600000), // 10 min
    // Cross-instance dedupe: per-URL refresh claim TTL so two scheduled boxes
    // don't render the same time-based refresh at once (the work queue already
    // dedupes via ZPOPMIN; the index path didn't). Derived above. 0 disables.
    claimTtlMs: claimTtlMs,
    // Over-fetch factor: ask dueForRefresh for this many × the free slots so we
    // can skip URLs another box already claimed and still fill our slots. Set it
    // >= the number of scheduled instances so a busy cluster doesn't under-fill.
    claimOverfetch: Math.max(1, num(process.env.REFRESHER_CLAIM_OVERFETCH, 3)),
    requestTimeoutMs: requestTimeoutMs,
    token: process.env.PRERENDER_AUTH_TOKEN || '',
    // Adaptive concurrency.
    adaptive: (process.env.REFRESHER_ADAPTIVE || '') === 'true',
    minConcurrency: minConcurrency,
    adaptIntervalMs: num(process.env.REFRESHER_ADAPT_INTERVAL_MS, 10000),
    backoffFactor: fnum(process.env.REFRESHER_BACKOFF_FACTOR, 0.5),
    throughputMargin: fnum(process.env.REFRESHER_THROUGHPUT_MARGIN, 0.1),
    vcpus: num(process.env.REFRESHER_VCPUS, 0), // 0 = auto-detect (display only)
    // A render slower than this counts as a backoff signal for the adaptive
    // controller, even if it returned 200 (a near-timeout render means we're
    // over-subscribed). Defaults to 80% of the server's page-load timeout.
    slowMs: num(
      process.env.REFRESHER_SLOW_MS,
      Math.round(num(process.env.PAGE_LOAD_TIMEOUT, 20000) * 0.8),
    ),
  };
}

// --- module state ---
let cfg = null;
let server = null;
let port = null;
let renderFn = null; // (url) -> Promise<statusCode>
let dueFn = null; // (opts) -> Promise<string[]> (time-based refresh from the index)
let dequeueFn = null; // (n) -> Promise<string[]> (manager-produced work queue)
let requeueFn = null; // (url) -> Promise (re-enqueue a failed queue item)
let clearAttemptFn = null; // (url) -> Promise (clear retry counter on success)
let claimFn = null; // (url, ttlMs) -> Promise<bool> (cross-instance refresh claim)
let releaseFn = null; // (url) -> Promise (release our refresh claim)
let extendFn = null; // (url, ttlMs) -> Promise (hold a failed url's claim)
let instanceToken = null; // identifies this box's claims (hostname:pid:gen)
let startGen = 0; // per-start nonce so a stale release can't match a new claim
let nowFn = Date.now;
let timer = null;
let adaptTimer = null;
let stopped = true;
const inProgress = new Set();
// url -> epoch ms when a failed URL may be refreshed again (see failCooldownMs).
const failedUntil = new Map();

// --- adaptive controller state ---
let limit = 0; // effective concurrency in adaptive mode
let mode = 'probe'; // 'probe' (trying a higher limit) | 'hold' (settled at a peak)
let baseThroughput = 0; // throughput before the last probe step (renders/sec)
let fromLimit = 0; // limit to revert to if a probe regresses
let holdCount = 0;
let winStart = 0;
let winCompleted = 0;
let winFailed = 0;
let cpuVCpus = 0;
let lastCpu = null; // { usage(usec), at(ms) }

// A render the server flagged as failed (x-prerender-504-reason — e.g. a page
// LOAD TIMEOUT, which unless TIMEOUT_STATUS_CODE=504 is set otherwise comes back
// as a misleading 200) is normalized to a 504 so the failure cooldown, the
// adaptive controller, and the queue all treat it as the failure it was — not a
// success that re-selects the broken URL next tick. (NB: this catches Chrome-level
// failures and timeouts; a 200 that's silently store-skipped for content reasons
// — dirtyRender / empty / tooSmall, the [[prerender-dirtyrender-stale-cache]]
// class — has no such header and is NOT parked. Out of scope here.)
function classifyLoopbackStatus(status, headers) {
  const failed = headers && headers['x-prerender-504-reason'];
  if (failed && !(status >= 500)) return 504;
  return status;
}

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
        res.on('end', () =>
          resolve(classifyLoopbackStatus(res.statusCode, res.headers)),
        );
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

// Park a failed URL so THIS box's dueForRefresh skips it until the cooldown
// elapses; a real result clears any prior parking. A render is a FAILURE worth
// parking when it timed out / 5xx'd / threw — NOT when it was shed for
// backpressure (429/503), which says "the box was busy", not "this URL is
// broken". This is the per-instance layer; cross-instance, a failed render also
// HOLDS its Redis refresh claim for the cooldown (see launch), so other boxes
// skip it too while cross-instance dedupe is on.
function noteFailure(url) {
  if (!cfg || cfg.failCooldownMs <= 0) return;
  failedUntil.set(url, nowFn() + cfg.failCooldownMs);
  // One line per park so an operator can see WHICH urls are persistently broken
  // (a healthy url never lands here; a broken one reappears ~every cooldown).
  util.log('[refresher]', JSON.stringify({ evt: 'parked', url: url, cooldownMs: cfg.failCooldownMs }));
}
function clearFailure(url) {
  if (failedUntil.size) failedUntil.delete(url);
}

function launch(url, source) {
  if (inProgress.has(url)) {
    // Already rendering this URL on this box (e.g. it arrived via both the queue
    // and the index this tick) — drop our redundant refresh claim so it doesn't
    // leak until its TTL.
    if (source === 'refresh' && cfg.claimTtlMs > 0) releaseFn(url);
    return;
  }
  inProgress.add(url);
  const t0 = Date.now();
  let failed = false;
  Promise.resolve()
    .then(() => renderFn(url))
    .then((status) => {
      const ms = Date.now() - t0;
      recordOutcome({ ok: true, status: status, latencyMs: ms });
      // Park a broken URL (timeout/5xx) so we don't re-select it every tick; a
      // real result (2xx/3xx/4xx) clears any prior cooldown. 429/503 are
      // backpressure, not the URL's fault, so leave its cooldown unchanged.
      if (status == null || (status >= 500 && status !== 503)) {
        failed = true;
        noteFailure(url);
      } else if (status !== 429 && status !== 503) {
        clearFailure(url);
      }
      // Queue items: a shed/failed render goes back on the queue; a real outcome
      // (2xx/3xx/4xx) is done, so clear its retry counter.
      if (source === 'queue') {
        if (status === 429 || status === 503 || (status != null && status >= 500)) {
          requeueFn(url);
        } else {
          clearAttemptFn(url);
        }
      }
      util.log('[refresher]', JSON.stringify({ evt: 'refresh', url: url, status: status, ms: ms, src: source }));
    })
    .catch((e) => {
      failed = true;
      recordOutcome({ ok: false, latencyMs: Date.now() - t0 });
      noteFailure(url); // a thrown render (transport error / timeout) is a failure
      if (source === 'queue') requeueFn(url);
      util.log('[refresher]', JSON.stringify({ evt: 'refresh-error', url: url, err: e && e.message, src: source }));
    })
    .then(() => {
      inProgress.delete(url);
      if (source !== 'refresh' || cfg.claimTtlMs <= 0) return;
      // A SUCCESS re-scored the index (won't be due again soon) -> release so it's
      // reclaimable. A FAILURE wrote nothing (still due, still at the head) -> HOLD
      // the claim for the cooldown so NO box retries it too soon; the claim doubles
      // as the cross-instance failure cooldown the per-instance set can't provide.
      if (failed && cfg.failCooldownMs > 0) {
        extendFn(url, cfg.failCooldownMs);
      } else {
        releaseFn(url);
      }
    });
}

// Effective concurrency: the adaptive limit, or the static configured value.
function getLimit() {
  return cfg && cfg.adaptive ? limit : cfg.concurrency;
}

// inProgress ∪ {URLs still in their post-failure cooldown}, pruning any whose
// cooldown has elapsed. Passed to dueForRefresh so a just-failed URL isn't
// re-selected until it's eligible again. Returns inProgress directly in the
// common (no failures) case to avoid an allocation per tick.
function activeExclude() {
  if (failedUntil.size === 0) return inProgress;
  const now = nowFn();
  const ex = new Set(inProgress);
  for (const [u, until] of failedUntil) {
    if (until > now) ex.add(u);
    else failedUntil.delete(u);
  }
  return ex;
}

// Claim up to `need` refresh URLs across instances, in index order, skipping any
// another box already holds — so two boxes never render the same URL at once.
// Sequential with early-stop so we never claim more than we'll render (an
// unrendered claim would needlessly block the other box until its TTL). With
// dedupe disabled it's a plain slice (no Redis calls).
function claimRefreshUrls(due, need) {
  if (cfg.claimTtlMs <= 0) return Promise.resolve(due.slice(0, need));
  const picked = [];
  let i = 0;
  const step = () => {
    if (picked.length >= need || i >= due.length) return Promise.resolve(picked);
    const url = due[i];
    i += 1;
    return Promise.resolve()
      .then(() => claimFn(url, cfg.claimTtlMs))
      .then((got) => {
        if (got) picked.push(url);
        return step();
      });
  };
  return step();
}

// How many renders we may start right now: bounded by both the effective limit
// and the box's free Chrome slots (so we never trigger a self-inflicted 429).
function freeSlots() {
  const max = (server && server.options && server.options.maxConcurrentRenders) || 0;
  const inFlight =
    server && server.browserRequestsInFlight ? server.browserRequestsInFlight.size : 0;
  const freeOnBox = max > 0 ? max - inFlight : Infinity;
  return Math.min(freeOnBox, getLimit() - inProgress.size);
}

// --- adaptive controller ----------------------------------------------------
// Throughput-gated AIMD. We hill-climb the concurrency while render throughput
// keeps improving and step back at the knee (before the crash zone); any render
// FAILURE (timeout / 5xx / Chrome-closed) halves the limit immediately. CPU% is
// only logged, never used as a control signal (a CPU-bound render WANTS ~100%).
function recordOutcome(o) {
  if (!cfg || !cfg.adaptive) return;
  const status = o && o.status;
  if (status === 429 || status === 503) return; // backpressure, not a render signal
  // A hard failure OR a near-timeout slow render both mean "over-subscribed".
  const failed = !o || o.ok === false || (status != null && status >= 500);
  const slow = cfg.slowMs > 0 && o && o.latencyMs > cfg.slowMs;
  if (failed || slow) winFailed += 1;
  else winCompleted += 1;
}

function evaluate(nowMs) {
  if (!cfg || !cfg.adaptive) return;
  // No renders happened this window -> no signal; just roll the window forward
  // (don't let idle periods collapse a hard-won limit).
  if (winCompleted === 0 && winFailed === 0) {
    winStart = nowMs;
    return;
  }
  const elapsed = Math.max(1, nowMs - winStart);
  const tput = (winCompleted * 1000) / elapsed; // renders/sec at the current limit
  const failed = winFailed;
  let next = limit;

  if (failed > 0) {
    next = Math.max(cfg.minConcurrency, Math.floor(limit * cfg.backoffFactor));
    mode = 'hold';
    holdCount = 0;
    baseThroughput = tput;
    fromLimit = next;
  } else if (mode === 'probe') {
    if (tput > baseThroughput * (1 + cfg.throughputMargin)) {
      // the higher limit helped -> keep climbing
      fromLimit = limit;
      baseThroughput = tput;
      next = Math.min(cfg.concurrency, limit + 1);
      if (next === limit) {
        mode = 'hold';
        holdCount = 0;
      }
    } else {
      // plateau / regression -> revert to the prior limit and hold (the knee)
      next = fromLimit;
      mode = 'hold';
      holdCount = 0;
      baseThroughput = tput;
    }
  } else {
    // hold: re-probe upward occasionally in case capacity freed up
    holdCount += 1;
    if (holdCount >= REPROBE_WINDOWS && limit < cfg.concurrency) {
      baseThroughput = tput;
      fromLimit = limit;
      next = Math.min(cfg.concurrency, limit + 1);
      mode = 'probe';
      holdCount = 0;
    }
  }

  const cpuPct = sampleCpu(nowMs);
  util.log(
    '[refresher]',
    JSON.stringify({
      evt: 'adapt',
      limit: next,
      mode: mode,
      throughputPerMin: Math.round(tput * 60),
      winCompleted: winCompleted,
      winFailed: failed,
      cpuPct: cpuPct,
    }),
  );
  limit = next;
  winStart = nowMs;
  winCompleted = 0;
  winFailed = 0;
}

// --- cgroup CPU readout (best-effort, Linux-only; observability only) -------
function parseCpuStatV2(text) {
  const m = text && text.match(/usage_usec\s+(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}
function readUsageUsec() {
  try {
    const v2 = parseCpuStatV2(fs.readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8'));
    if (v2 != null) return v2;
  } catch (e) {
    /* not cgroup v2 */
  }
  try {
    const ns = parseInt(fs.readFileSync('/sys/fs/cgroup/cpuacct/cpuacct.usage', 'utf8').trim(), 10);
    if (!Number.isNaN(ns)) return Math.floor(ns / 1000); // ns -> us
  } catch (e) {
    /* not cgroup v1 */
  }
  return null;
}
function detectVCpus() {
  if (cfg && cfg.vcpus > 0) return cfg.vcpus;
  try {
    const parts = fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/);
    if (parts.length === 2 && parts[0] !== 'max') {
      const q = parseInt(parts[0], 10);
      const p = parseInt(parts[1], 10);
      if (q > 0 && p > 0) return q / p;
    }
  } catch (e) {
    /* fall through */
  }
  try {
    return os.cpus().length || 1;
  } catch (e) {
    return 1;
  }
}
// Utilization (% of the box's vCPUs) since the previous sample. null until a
// second sample exists, or when cgroup CPU accounting isn't available.
function sampleCpu(nowMs) {
  const usage = readUsageUsec();
  if (usage == null) return null;
  if (!cpuVCpus) cpuVCpus = detectVCpus();
  if (!lastCpu) {
    lastCpu = { usage: usage, at: nowMs };
    return null;
  }
  const dUsageMs = (usage - lastCpu.usage) / 1000; // CPU-ms consumed
  const dWallMs = nowMs - lastCpu.at;
  lastCpu = { usage: usage, at: nowMs };
  if (dWallMs <= 0 || cpuVCpus <= 0) return null;
  return Math.round((dUsageMs / (dWallMs * cpuVCpus)) * 100);
}

// --- loop -------------------------------------------------------------------
function tickOnce() {
  if (stopped || (server && server.isShuttingDown)) {
    return Promise.resolve({ stopped: true });
  }
  const slots = freeSlots();
  if (slots <= 0) return Promise.resolve({ slots: 0, launched: 0 });
  // Candidates seen this tick (queued + due, before claim filtering). Lets us tell
  // "nothing is due" (idle -> long sleep) from "due work existed but another box
  // already claimed it all" (retry at tickMs so we promptly grab what frees up).
  let candidates = 0;
  // Drain the manager-produced queue first (seed/refresh, priority-ordered),
  // then top up any remaining slots with time-based refresh from our own index.
  return Promise.resolve()
    .then(() => dequeueFn(slots))
    .then((queued) => {
      const items = (queued || []).map((u) => ({ url: u, source: 'queue' }));
      candidates += items.length;
      if (items.length >= slots) return items;
      const need = slots - items.length;
      return Promise.resolve()
        .then(() =>
          dueFn({
            // Over-fetch when dedupe is on so we can skip URLs another box is
            // already rendering and still fill our slots.
            limit: cfg.claimTtlMs > 0 ? need * cfg.claimOverfetch : need,
            exclude: activeExclude(),
            refreshTtlMs: cfg.refreshTtlMs,
            redirectTtlMs: cfg.redirectTtlMs,
            maxScan: cfg.maxScan,
          }),
        )
        .then((due) => {
          candidates += (due || []).length;
          return claimRefreshUrls(due || [], need);
        })
        .then((claimed) =>
          items.concat(claimed.map((u) => ({ url: u, source: 'refresh' }))),
        );
    })
    .then((items) => {
      const picked = items.slice(0, slots);
      picked.forEach((it) => launch(it.url, it.source));
      return { launched: picked.length, idle: picked.length === 0 && candidates === 0 };
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

// Start the loop. `deps` is a test seam: { render, dueForRefresh, now, manual }.
function start(srv, srvPort, deps) {
  deps = deps || {};
  cfg = parseConfig();
  server = srv;
  port = srvPort;
  renderFn = deps.render || defaultRender;
  dueFn = deps.dueForRefresh || ((o) => redisCache.dueForRefresh(o));
  dequeueFn = deps.dequeue || ((n) => redisCache.dequeue(n));
  requeueFn = deps.requeue || ((u) => redisCache.requeue(u));
  clearAttemptFn = deps.clearAttempt || ((u) => redisCache.clearAttempt(u));
  // Unique per box+process+start so a claim's compare-and-del/-pexpire only ever
  // touches our own claim — hostname disambiguates boxes, pid+gen disambiguates
  // restarts and in-process re-starts (so a late release from a prior incarnation
  // can't match a new incarnation's claim for the same URL).
  startGen += 1;
  instanceToken = deps.instanceToken || `${os.hostname()}:${process.pid}:${startGen}`;
  claimFn = deps.claim || ((u, ttl) => redisCache.claimRefresh(u, instanceToken, ttl));
  releaseFn = deps.release || ((u) => redisCache.releaseRefresh(u, instanceToken));
  extendFn = deps.extend || ((u, ttl) => redisCache.extendRefreshClaim(u, instanceToken, ttl));
  nowFn = deps.now || Date.now;
  stopped = false;
  inProgress.clear();
  failedUntil.clear();
  // (re)initialize the adaptive controller
  limit = cfg.minConcurrency;
  mode = 'probe';
  baseThroughput = 0;
  fromLimit = cfg.minConcurrency;
  holdCount = 0;
  winStart = nowFn();
  winCompleted = 0;
  winFailed = 0;
  cpuVCpus = 0;
  lastCpu = null;
  util.log(
    '[refresher] started',
    JSON.stringify({
      adaptive: cfg.adaptive,
      concurrency: cfg.concurrency,
      minConcurrency: cfg.minConcurrency,
      refreshTtlMs: cfg.refreshTtlMs,
      redirectTtlMs: cfg.redirectTtlMs,
    }),
  );
  if (deps.manual) return; // tests drive tickOnce()/evaluate() themselves
  if (cfg.adaptive) adaptTimer = setInterval(() => evaluate(nowFn()), cfg.adaptIntervalMs);
  schedule(0);
}

// Stop launching new work and clear timers. In-flight loopback renders keep
// running — server.shutdown()'s drain loop already waits for them (they're in
// browserRequestsInFlight). Idempotent and safe even if start() never ran.
function stop() {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (adaptTimer) {
    clearInterval(adaptTimer);
    adaptTimer = null;
  }
}

module.exports = {
  start,
  stop,
  // --- test seams ---
  _tickOnce: tickOnce,
  _inProgress: () => inProgress,
  _failedUntil: () => failedUntil,
  _classifyLoopbackStatus: classifyLoopbackStatus,
  _parseConfig: parseConfig,
  _recordOutcome: recordOutcome,
  _evaluate: evaluate,
  _getLimit: getLimit,
  _parseCpuStatV2: parseCpuStatV2,
};
