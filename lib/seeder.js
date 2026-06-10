// In-server sitemap seeder (scheduled instances only).
//
// Replaces the external Python cache-manager's last job: periodically expand the
// ADMIN-MANAGED sitemap list (dashboard "Sitemaps" page -> POST /cache/sitemaps;
// there is no env-based list) and produce render work for the queue:
//   - uncached pages            -> priority 0 (P_NEW)
//   - cached pages whose sitemap <lastmod> is newer than the cached copy
//                               -> priority 1 (P_REFRESH)
// Time-based refresh deliberately stays with lib/refresher.js (seed_lastmod
// semantics), so the two never double-render the same URL; 4xx pages are never
// re-enqueued (the server TTL-evicts them, after which they reappear as new).
//
// A pure producer: no Chrome slots, no loopback renders — the refresher is the
// sole queue consumer. Diff + enqueue go through redisCache in-process.
//
// Multi-instance: several scheduled instances may run this loop, but exactly one
// scan happens per interval cluster-wide — a Redis lastScanAt gate plus a scan
// lock (SET NX PX, renewed at natural checkpoints, compare-and-del released).
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const util = require('./util.js');
const redisCache = require('./plugins/redisCache.js');

// Queue priorities (manager.py parity: P_NEW=0, P_REFRESH=1; the refresher
// requeues failures at 2).
const P_NEW = 0;
const P_REFRESH = 1;

function num(v, d) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? d : n;
}

function parseConfig() {
  return {
    // How often a cluster-wide scan is due (manager parity: RECONCILE_INTERVAL_SEC=600).
    intervalMs: num(process.env.SEEDER_INTERVAL_MS, 600000),
    // How often each instance checks the gate.
    tickMs: num(process.env.SEEDER_TICK_MS, 60000),
    // Pause between sitemap fetches so a cold scan never bursts the upstream
    // sitemap API (manager parity: SITEMAP_FETCH_COOLDOWN_SEC=1.0).
    cooldownMs: num(process.env.SEEDER_FETCH_COOLDOWN_MS, 1000),
    // Scan-lock TTL. Renewed after every fetch and every diff batch, so it only
    // has to outlive one checkpoint (~fetch timeout + cooldown), not the scan.
    lockTtlMs: num(process.env.SEEDER_LOCK_TTL_MS, 120000),
    fetchTimeoutMs: num(process.env.SEEDER_FETCH_TIMEOUT_MS, 30000),
    // Sitemap-index recursion depth cap (manager parity).
    maxDepth: num(process.env.SEEDER_MAX_DEPTH, 4),
    // URLs per cache-status diff / enqueue batch (manager parity: STATUS_BATCH).
    statusBatch: num(process.env.SEEDER_STATUS_BATCH, 500),
  };
}

// --- module state ---
let cfg = null;
let server = null;
let stopped = true;
let timer = null;
let fetchFn = null; // (url) -> Promise<string xml>
let statusFn = null; // (urls) -> Promise<[{cached,storedAt,status}, ...]>
let enqueueFn = null; // (urls, priority) -> Promise<addedCount>
let listFn = null; // () -> Promise<[{id,url,enabled}, ...]>
let gateGetFn = null; // () -> Promise<ms|null>
let gateSetFn = null; // (ms) -> Promise
let lockFn = null; // (token, ttlMs) -> Promise<bool>
let renewFn = null; // (token, ttlMs) -> Promise<bool>
let releaseFn = null; // (token) -> Promise
let recordFn = null; // (id, patch) -> Promise
let pruneFn = null; // (ids) -> Promise
let nowFn = Date.now;
let sleepFn = null;

// Run a (possibly sync, possibly injected) dep and swallow its failure — every
// coordination op is best-effort; only fetch/diff/enqueue failures matter.
function safely(fn) {
  return Promise.resolve()
    .then(fn)
    .catch(() => {});
}

function aborted() {
  const e = new Error('scan aborted (shutdown)');
  e.code = 'ABORTED';
  return e;
}

function shuttingDown() {
  return stopped || (server && server.isShuttingDown);
}

// --- sitemap parsing (port of the cache-manager's sitemap.py) ----------------

// W3C/ISO-8601 <lastmod> -> epoch ms, tolerantly. Naive datetimes are treated
// as UTC (Python parity — JS would otherwise parse them as LOCAL time).
function parseLastmodMs(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  let t;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    t = Date.parse(s + 'T00:00:00Z'); // date-only -> UTC midnight
  } else if (/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(s)) {
    t = Date.parse(s); // explicit zone/offset
  } else {
    t = Date.parse(s + 'Z'); // naive -> UTC
  }
  return Number.isNaN(t) ? null : t;
}

// Gunzip when the URL or the magic bytes say so; on a corrupt stream fall back
// to the raw bytes (Python parity).
function maybeGunzip(buf, url) {
  const looksGz =
    /\.gz$/i.test(url) ||
    (buf && buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b);
  if (!looksGz) return buf;
  try {
    return zlib.gunzipSync(buf);
  } catch (e) {
    return buf;
  }
}

function xmlUnescape(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&amp;/g, '&'); // ampersand last so &amp;lt; -> &lt;
}

// Sitemaps are simple, well-formed XML, so a tolerant regex pass is enough (no
// XML dep — same approach as sitemapProxy.parseSitemapLocs, which only handles
// <sitemap> blocks; the seeder also needs <url> blocks, hence its own parser).
// Unknown roots are treated as a urlset (Python parity).
function parseSitemap(xml) {
  const entries = [];
  if (/<sitemapindex\b/i.test(xml)) {
    const blockRe = /<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi;
    let m;
    while ((m = blockRe.exec(xml)) !== null) {
      const loc = /<loc>\s*([\s\S]*?)\s*<\/loc>/i.exec(m[1]);
      if (loc) entries.push({ loc: xmlUnescape(loc[1].trim()), lastmodMs: null });
    }
    return { kind: 'index', entries };
  }
  const blockRe = /<url\b[^>]*>([\s\S]*?)<\/url>/gi;
  let m;
  while ((m = blockRe.exec(xml)) !== null) {
    const block = m[1];
    const loc = /<loc>\s*([\s\S]*?)\s*<\/loc>/i.exec(block);
    if (!loc) continue;
    const lm = /<lastmod>\s*([\s\S]*?)\s*<\/lastmod>/i.exec(block);
    entries.push({
      loc: xmlUnescape(loc[1].trim()),
      lastmodMs: lm ? parseLastmodMs(lm[1]) : null,
    });
  }
  return { kind: 'urlset', entries };
}

// --- fetching -----------------------------------------------------------------
// Self-contained on purpose: sitemapProxy's cachedFetch stores utf8 text (would
// corrupt .gz bodies) and its parser has no urlset support. When the configured
// sitemap URLs are the public proxy-served ones, its 6h Redis cache still
// shields the upstream API on the serving side — same as the Python manager.

// GET as a Buffer. Follows up to `redirectsLeft` redirects (urllib parity).
function fetchBuffer(url, timeoutMs, redirectsLeft) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(new Error('bad sitemap url'));
    }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(
      url,
      {
        method: 'GET',
        headers: {
          Accept: 'application/xml,text/xml,*/*',
          'Accept-Encoding': 'identity',
          'User-Agent': 'ChicksPrerenderSeeder/1.0',
        },
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
          let next;
          try {
            next = new URL(res.headers.location, url).toString();
          } catch (e) {
            return reject(new Error('bad redirect location'));
          }
          return resolve(fetchBuffer(next, timeoutMs, redirectsLeft - 1));
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new Error('sitemap HTTP ' + res.statusCode));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      },
    );
    req.setTimeout(timeoutMs, () =>
      req.destroy(new Error('sitemap fetch timeout')),
    );
    req.on('error', reject);
    req.end();
  });
}

function defaultFetch(url) {
  return fetchBuffer(url, cfg.fetchTimeoutMs, 3).then((buf) =>
    maybeGunzip(buf, url).toString('utf8'),
  );
}

// --- expansion (port of sitemap.collect) ---------------------------------------

// Expand one configured sitemap (possibly an index) into a deduped entry list.
// Each configured sitemap is scanned separately (per-sitemap dashboard status);
// a child shared BETWEEN two configured sitemaps is fetched once per sitemap,
// which the proxy's cache absorbs — overlapping entries dedup at enqueue (NX).
async function collect(rootUrl, hooks) {
  const seen = new Set();
  const pages = new Map(); // loc -> entry (dedup across sub-sitemaps, last wins)
  const stack = [{ url: rootUrl, depth: 0 }];
  let childErrors = 0;

  while (stack.length) {
    if (shuttingDown()) throw aborted();
    const { url, depth } = stack.pop();
    if (seen.has(url) || depth > cfg.maxDepth) continue;
    seen.add(url);

    let doc = null;
    let err = null;
    try {
      doc = parseSitemap(await fetchFn(url));
    } catch (e) {
      err = e || new Error('sitemap fetch failed');
    }
    await safely(() => hooks.afterFetch()); // lock renewal checkpoint

    if (err) {
      // The ROOT failing means the whole sitemap is unreadable — surface it as
      // this sitemap's lastError (the Python manager silently returned an empty
      // list here; recording it is a deliberate improvement). A broken CHILD is
      // skipped, but we still cool down — an error may mean the origin is
      // struggling.
      if (depth === 0) throw err;
      childErrors += 1;
      util.log(
        '[seeder]',
        JSON.stringify({ evt: 'child-skip', url, err: err.message }),
      );
    } else if (doc.kind === 'index') {
      for (const e of doc.entries) stack.push({ url: e.loc, depth: depth + 1 });
    } else {
      for (const e of doc.entries) pages.set(e.loc, e);
    }
    if (cfg.cooldownMs > 0 && stack.length) await sleepFn(cfg.cooldownMs);
  }
  return { entries: Array.from(pages.values()), childErrors };
}

// --- classification (port of reconcile.classify, seed_lastmod mode) ------------

// rows = redisCache.status() results, index-aligned with entries.
function classify(entries, rows) {
  const newUrls = [];
  const refreshUrls = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const row = rows && rows[i];
    if (!row || !row.cached) {
      newUrls.push(e.loc);
      continue;
    }
    // 4xx: cached but never re-rendered by us. The server TTL-evicts these
    // (status() reaps expired ones and reports cached:false), after which the
    // URL lands in newUrls above and gets its one re-seed.
    const status = row.status;
    if (status != null && status >= 400 && status < 500) continue;
    // seed_lastmod: only content changes the sitemap declares (strictly newer
    // <lastmod>) — or an unreadable storedAt — trigger a refresh. Time-based
    // staleness is the refresher's job.
    const lastmodChanged =
      e.lastmodMs != null && row.storedAt != null && e.lastmodMs > row.storedAt;
    if (row.storedAt == null || lastmodChanged) refreshUrls.push(e.loc);
  }
  return { newUrls, refreshUrls };
}

// --- scan ----------------------------------------------------------------------

async function scanSitemap(sm, token) {
  const t0 = nowFn();
  try {
    const { entries, childErrors } = await collect(sm.url, {
      afterFetch: () => renewFn(token, cfg.lockTtlMs),
    });
    let enqueuedNew = 0;
    let enqueuedRefresh = 0;
    for (let i = 0; i < entries.length; i += cfg.statusBatch) {
      if (shuttingDown()) throw aborted();
      const batch = entries.slice(i, i + cfg.statusBatch);
      const rows = await statusFn(batch.map((e) => e.loc));
      const picked = classify(batch, rows);
      if (picked.newUrls.length)
        enqueuedNew += Number(await enqueueFn(picked.newUrls, P_NEW)) || 0;
      if (picked.refreshUrls.length)
        enqueuedRefresh +=
          Number(await enqueueFn(picked.refreshUrls, P_REFRESH)) || 0;
      await safely(() => renewFn(token, cfg.lockTtlMs));
    }
    const ms = nowFn() - t0;
    await safely(() =>
      recordFn(sm.id, {
        lastScanAt: t0,
        lastDurationMs: ms,
        urlsFound: entries.length,
        enqueuedNew,
        enqueuedRefresh,
        lastError: null,
        lastErrorAt: null,
      }),
    );
    util.log(
      '[seeder]',
      JSON.stringify({
        evt: 'sitemap-scan',
        id: sm.id,
        url: sm.url,
        urls: entries.length,
        childErrors,
        enqueuedNew,
        enqueuedRefresh,
        ms,
      }),
    );
    return { ok: true, urlsFound: entries.length, enqueuedNew, enqueuedRefresh };
  } catch (e) {
    await safely(() =>
      recordFn(sm.id, {
        lastError: (e && e.message) || 'scan failed',
        lastErrorAt: nowFn(),
      }),
    );
    util.log(
      '[seeder]',
      JSON.stringify({
        evt: 'sitemap-error',
        id: sm.id,
        url: sm.url,
        err: e && e.message,
      }),
    );
    return { ok: false, aborted: !!(e && e.code === 'ABORTED') };
  }
}

// One gate/lock/scan attempt. Cheap when nothing is due.
async function tickOnce() {
  if (shuttingDown()) return { stopped: true };
  const list = (await listFn()) || [];
  const active = list.filter((s) => s && s.enabled);
  if (active.length === 0) return { idle: true, reason: 'no-sitemaps' };
  const last = await gateGetFn();
  if (last != null && nowFn() - last < cfg.intervalMs)
    return { idle: true, reason: 'not-due' };
  const token = `${process.pid}-${nowFn()}-${Math.random().toString(36).slice(2)}`;
  if (!(await lockFn(token, cfg.lockTtlMs)))
    return { idle: true, reason: 'locked' };
  try {
    // Re-check under the lock: another instance may have stamped the gate
    // between our gate read and the lock acquire.
    const recheck = await gateGetFn();
    if (recheck != null && nowFn() - recheck < cfg.intervalMs)
      return { idle: true, reason: 'lost-race' };
    // Stamp at scan START so the gate holds even if we crash mid-scan and the
    // lock expires — a successor then waits out the interval instead of
    // immediately re-scanning (a crash costs at most one cycle).
    await gateSetFn(nowFn());
    // Statuses are pruned on every dashboard push too; this catches a list that
    // was restored/edited in Redis directly.
    await safely(() => pruneFn(list.map((s) => s.id)));
    const summary = {
      evt: 'scan',
      sitemaps: active.length,
      urlsFound: 0,
      enqueuedNew: 0,
      enqueuedRefresh: 0,
      errors: 0,
    };
    for (const sm of active) {
      if (shuttingDown()) {
        summary.aborted = true;
        break;
      }
      const r = await scanSitemap(sm, token);
      if (r.ok) {
        summary.urlsFound += r.urlsFound;
        summary.enqueuedNew += r.enqueuedNew;
        summary.enqueuedRefresh += r.enqueuedRefresh;
      } else {
        summary.errors += 1;
        if (r.aborted) {
          summary.aborted = true;
          break;
        }
      }
    }
    util.log('[seeder]', JSON.stringify(summary));
    return summary;
  } finally {
    await safely(() => releaseFn(token)); // compare-and-del: never a successor's
  }
}

// --- loop -----------------------------------------------------------------------

function schedule(ms) {
  if (stopped) return;
  timer = setTimeout(tick, ms);
}

function tick() {
  timer = null;
  if (shuttingDown()) return stop();
  tickOnce()
    .then(() => schedule(cfg.tickMs))
    .catch((e) => {
      util.log(
        '[seeder]',
        JSON.stringify({ evt: 'tick-error', err: e && e.message }),
      );
      schedule(cfg.tickMs);
    });
}

// Start the loop. `deps` is a test seam (manual:true -> tests drive tickOnce()).
function start(srv, deps) {
  deps = deps || {};
  cfg = parseConfig();
  server = srv;
  stopped = false;
  fetchFn = deps.fetch || defaultFetch;
  statusFn = deps.status || ((urls) => redisCache.status(urls));
  enqueueFn = deps.enqueue || ((urls, p) => redisCache.enqueue(urls, p));
  listFn = deps.getSitemapList || (() => redisCache.getSitemapList());
  gateGetFn = deps.getLastScanAt || (() => redisCache.getSitemapLastScanAt());
  gateSetFn = deps.setLastScanAt || ((ms) => redisCache.setSitemapLastScanAt(ms));
  lockFn = deps.acquireLock || ((t, ttl) => redisCache.acquireSeederLock(t, ttl));
  renewFn = deps.renewLock || ((t, ttl) => redisCache.renewSeederLock(t, ttl));
  releaseFn = deps.releaseLock || ((t) => redisCache.releaseSeederLock(t));
  recordFn =
    deps.recordStatus || ((id, patch) => redisCache.setSitemapScanStatus(id, patch));
  pruneFn = deps.pruneStatuses || ((ids) => redisCache.pruneSitemapStatuses(ids));
  nowFn = deps.now || Date.now;
  sleepFn = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  util.log(
    '[seeder] started',
    JSON.stringify({
      intervalMs: cfg.intervalMs,
      tickMs: cfg.tickMs,
      cooldownMs: cfg.cooldownMs,
      lockTtlMs: cfg.lockTtlMs,
      fetchTimeoutMs: cfg.fetchTimeoutMs,
      maxDepth: cfg.maxDepth,
      statusBatch: cfg.statusBatch,
    }),
  );
  if (deps.manual) return; // tests drive tickOnce() themselves
  schedule(0);
}

// Stop launching new scans and clear the timer. An in-progress scan aborts at
// its next checkpoint (shuttingDown() is consulted before every fetch and every
// diff batch) and releases the lock in tickOnce's finally. Idempotent.
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
  _scanSitemap: scanSitemap,
  _collect: collect,
  _classify: classify,
  _parseSitemap: parseSitemap,
  _parseLastmodMs: parseLastmodMs,
  _maybeGunzip: maybeGunzip,
  _parseConfig: parseConfig,
};
