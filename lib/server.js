const util = require('./util.js');
const validUrl = require('valid-url');
const { v4: uuidv4 } = require('uuid');
const fallback = require('./plugins/fallback');
const redisCache = require('./plugins/redisCache');

// Rejection sentinel for a render shed at the concurrency cap (429 or capacity
// fallback). onRequest's catch recognizes it and skips finish()/_send because the
// shed path has already sent the response.
const CAPACITY_SHED = Symbol('capacity-shed');

// Parse an integer env var, falling back to `def` (with a log) on a missing or
// non-numeric value. A `||`-style default lets a typo like "90s" slip through as
// NaN — which the watchdog reads as "disabled", silently turning OFF a safety
// mechanism. Fail loud-and-safe instead.
function intEnv(name, def) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return def;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) {
    util.log(`warning: ${name}="${raw}" is not an integer; using ${def}`);
    return def;
  }
  return n;
}

const WAIT_AFTER_LAST_REQUEST = process.env.WAIT_AFTER_LAST_REQUEST || 500;

const PAGE_DONE_CHECK_INTERVAL = process.env.PAGE_DONE_CHECK_INTERVAL || 500;

const PAGE_LOAD_TIMEOUT = process.env.PAGE_LOAD_TIMEOUT || 20 * 1000;

const FOLLOW_REDIRECTS = process.env.FOLLOW_REDIRECTS || false;

const LOG_REQUESTS = process.env.LOG_REQUESTS || false;

const CAPTURE_CONSOLE_LOG = process.env.CAPTURE_CONSOLE_LOG || false;

const ENABLE_SERVICE_WORKER = process.env.ENABLE_SERVICE_WORKER || false;

//try to restart the browser only if there are zero requests in flight
const BROWSER_TRY_RESTART_PERIOD =
  process.env.BROWSER_TRY_RESTART_PERIOD || 600000;

// Stall watchdog. finish()'s recycle and browserForceRestart's drain-then-
// recycle both depend on in-flight reaching zero — which never happens under
// continuous (refresher) load. So a wedged Chrome — isBrowserConnected flipped
// false without a kill (the force-restart deadlock), or a half-dead Chrome whose
// tab-opens keep resetting (ECONNRESET) while isBrowserConnected stays true —
// can never be recycled while the box is busy, and every render 504s forever.
// The watchdog breaks that: if we have render(s) in flight (so we ARE trying to
// use Chrome) yet no tab has opened successfully for STALL_MS, force a restart
// regardless of in-flight count. STALL_MS=0 disables it. NB: the watchdog's
// liveness signal is a successful tab OPEN — it catches a wedged/unreachable
// browser, not a reachable browser whose every page-load hangs (those still
// surface as the usual per-render page-load timeouts).
const BROWSER_WATCHDOG_PERIOD = intEnv('BROWSER_WATCHDOG_PERIOD', 15000);
const BROWSER_WATCHDOG_STALL_MS = intEnv('BROWSER_WATCHDOG_STALL_MS', 90000);
// If the watchdog has to restart this many times within the window below
// (without Chrome staying healthy long enough to age the window out), the HOST
// is likely poisoned (OOM, debug-port exhaustion) and restarting Chrome in place
// won't help — exit so the platform replaces the box instead of thrashing one
// forever. 0 disables the escalation (restart in place indefinitely).
const BROWSER_WATCHDOG_MAX_RESTARTS = intEnv('BROWSER_WATCHDOG_MAX_RESTARTS', 5);
const BROWSER_WATCHDOG_RESTART_WINDOW_MS = 600000; // 10 min

const BROWSER_DEBUGGING_PORT = process.env.BROWSER_DEBUGGING_PORT || 9222;

const TIMEOUT_STATUS_CODE = process.env.TIMEOUT_STATUS_CODE;
const RENDERING_ERROR_STATUS_CODE =
  process.env.RENDERING_ERROR_STATUS_CODE || 504;

const PARSE_SHADOW_DOM = process.env.PARSE_SHADOW_DOM || false;

// Max number of concurrent renders before we shed load. 0 = unlimited.
const MAX_CONCURRENT_RENDERS = parseInt(
  process.env.MAX_CONCURRENT_RENDERS || '0',
  10,
);
// Retry-After (seconds) sent with the 429 when at capacity.
const OVERLOAD_RETRY_AFTER = process.env.OVERLOAD_RETRY_AFTER || '2';
// How long to wait for in-flight renders to drain on SIGTERM/SIGINT.
const SHUTDOWN_DRAIN_TIMEOUT_MS = parseInt(
  process.env.SHUTDOWN_DRAIN_TIMEOUT_MS || '20000',
  10,
);

const server = {};

server.init = function (options) {
  this.plugins = this.plugins || [];
  this.options = options || {};

  this.options.waitAfterLastRequest =
    this.options.waitAfterLastRequest || WAIT_AFTER_LAST_REQUEST;
  this.options.pageDoneCheckInterval =
    this.options.pageDoneCheckInterval || PAGE_DONE_CHECK_INTERVAL;
  this.options.pageLoadTimeout =
    this.options.pageLoadTimeout || PAGE_LOAD_TIMEOUT;
  this.options.followRedirects =
    this.options.followRedirects || FOLLOW_REDIRECTS;
  this.options.logRequests = this.options.logRequests || LOG_REQUESTS;
  this.options.captureConsoleLog =
    this.options.captureConsoleLog || CAPTURE_CONSOLE_LOG;
  this.options.enableServiceWorker =
    this.options.enableServiceWorker || ENABLE_SERVICE_WORKER;
  this.options.pdfOptions = this.options.pdfOptions || {
    printBackground: true,
  };
  this.options.browserDebuggingPort =
    this.options.browserDebuggingPort || BROWSER_DEBUGGING_PORT;
  this.options.timeoutStatusCode =
    this.options.timeoutStatusCode || TIMEOUT_STATUS_CODE;
  this.options.renderErrorStatusCode =
    this.options.renderErrorStatusCode || RENDERING_ERROR_STATUS_CODE;
  this.options.parseShadowDom = this.options.parseShadowDom || PARSE_SHADOW_DOM;
  this.options.browserTryRestartPeriod =
    this.options.browserTryRestartPeriod || BROWSER_TRY_RESTART_PERIOD;
  this.options.maxConcurrentRenders =
    this.options.maxConcurrentRenders || MAX_CONCURRENT_RENDERS;
  this.options.overloadRetryAfter =
    this.options.overloadRetryAfter || OVERLOAD_RETRY_AFTER;
  this.options.shutdownDrainTimeout =
    this.options.shutdownDrainTimeout || SHUTDOWN_DRAIN_TIMEOUT_MS;
  // != null (not ||) so an explicit 0 — which DISABLES the watchdog — survives.
  this.options.browserWatchdogPeriod =
    this.options.browserWatchdogPeriod != null
      ? this.options.browserWatchdogPeriod
      : BROWSER_WATCHDOG_PERIOD;
  this.options.browserWatchdogStallMs =
    this.options.browserWatchdogStallMs != null
      ? this.options.browserWatchdogStallMs
      : BROWSER_WATCHDOG_STALL_MS;
  this.options.browserWatchdogMaxRestarts =
    this.options.browserWatchdogMaxRestarts != null
      ? this.options.browserWatchdogMaxRestarts
      : BROWSER_WATCHDOG_MAX_RESTARTS;

  // Allow the container/deployment to point at its Chrome binary and pass
  // container-required flags (e.g. --no-sandbox, --disable-dev-shm-usage)
  // without code changes.
  if (!this.options.chromeLocation && process.env.CHROME_LOCATION) {
    this.options.chromeLocation = process.env.CHROME_LOCATION;
  }
  if (!this.options.extraChromeFlags && process.env.EXTRA_CHROME_FLAGS) {
    this.options.extraChromeFlags =
      process.env.EXTRA_CHROME_FLAGS.trim().split(/\s+/);
  }
  // Optional forward proxy for Chrome's own outbound requests (the page's
  // subresource fetches). Pointing this at a caching proxy (e.g. Squid) lets
  // immutable, content-hashed JS/CSS bundles be served from cache across
  // renders instead of re-fetched from the CDN every time — each render uses a
  // fresh, cold Chrome context, so without this every bundle is re-downloaded
  // per render. chrome.js turns this into Chrome's --proxy-server flag.
  if (!this.options.proxyServer && process.env.PROXY_SERVER) {
    this.options.proxyServer = process.env.PROXY_SERVER;
  }

  this.browser = require('./browsers/chrome');

  return this;
};

server.start = function () {
  util.log('Starting Prerender');
  this.isBrowserConnected = false;
  this.isShuttingDown = false;
  this.isRestartingBrowser = false;
  // Seed the health clock so the watchdog never fires before the first connect.
  this.lastBrowserOk = new Date().getTime();
  this.startPrerender()
    .then(() => {
      // App Platform (and most orchestrators) send SIGTERM on deploy/scale-down;
      // SIGINT covers local Ctrl-C. Both drain gracefully.
      process.on('SIGTERM', () => this.shutdown());
      process.on('SIGINT', () => this.shutdown());
      this.startBrowserWatchdog();
    })
    .catch(() => {
      if (process.exit) {
        process.exit();
      }
    });
};

// Readiness signal for load balancers / health checks: the browser is
// connected and we are not in the middle of a graceful shutdown.
server.isReady = function () {
  return this.isBrowserConnected === true && !this.isShuttingDown;
};

// Graceful shutdown: stop accepting new work, drain in-flight renders, then
// kill Chrome and exit. Idempotent.
server.shutdown = function () {
  if (this.isShuttingDown) return;
  this.isShuttingDown = true;
  util.log('Shutdown signal received, draining in-flight requests');

  // Stop the stall watchdog so it can't fire a restart mid-drain.
  if (this.browserWatchdogTimer) {
    clearInterval(this.browserWatchdogTimer);
    this.browserWatchdogTimer = null;
  }

  // Stop the refresher loop from launching new renders (best-effort; a no-op
  // when it never started). In-flight loopback renders drain below.
  try {
    require('./refresher').stop();
  } catch (e) {
    /* refresher not present; ignore */
  }

  // Stop the sitemap seeder too: an in-progress scan aborts at its next
  // checkpoint and releases its scan lock (best-effort; no-op if never started).
  try {
    require('./seeder').stop();
  } catch (e) {
    /* seeder not present; ignore */
  }

  // Stop accepting new connections (readiness already fails via isReady()).
  if (this.httpServer && typeof this.httpServer.close === 'function') {
    try {
      this.httpServer.close();
    } catch (e) {
      util.log('warning: error closing http server', e);
    }
  }

  const drainStart = new Date().getTime();
  const drainTimeout =
    this.options.shutdownDrainTimeout || SHUTDOWN_DRAIN_TIMEOUT_MS;

  const finalize = () => {
    this.killBrowser();
    setTimeout(() => {
      util.log('Stopping Prerender');
      process.exit(0);
    }, 500);
  };

  const checkDrained = () => {
    const inFlight = this.browserRequestsInFlight
      ? this.browserRequestsInFlight.size
      : 0;

    if (inFlight === 0) {
      util.log('Drain complete, stopping browser');
      return finalize();
    }

    if (new Date().getTime() - drainStart > drainTimeout) {
      util.log(
        `Drain timeout reached with ${inFlight} request(s) still in flight, forcing shutdown`,
      );
      return finalize();
    }

    setTimeout(checkDrained, 250);
  };

  checkDrained();
};

server.startPrerender = function () {
  return new Promise((resolve, reject) => {
    this.spawnBrowser()
      .then(() => {
        this.listenForBrowserClose();
        return this.connectToBrowser();
      })
      .then(() => {
        this.browserRequestsInFlight = new Map();
        this.lastRestart = new Date().getTime();
        this.isBrowserConnected = true;
        // A fresh connection is proof Chrome works: refresh the health clock and
        // clear the relaunch guard so the watchdog re-arms for the next stall.
        this.lastBrowserOk = this.lastRestart;
        this.isRestartingBrowser = false;
        util.log(`Started ${this.browser.name}: ${this.browser.version}`);
        return this.firePluginEvent('connectedToBrowser', { server });
      })
      .then(() => resolve())
      .catch((err) => {
        util.log(err);
        util.log(
          `Failed to start and/or connect to ${this.browser.name}. Please make sure ${this.browser.name} is running`,
        );
        this.killBrowser();
        reject();
      });
  });
};

server.addRequestToInFlight = function (req) {
  this.browserRequestsInFlight.set(req.prerender.reqId, req.prerender.url);
};

server.removeRequestFromInFlight = function (req) {
  this.browserRequestsInFlight.delete(req.prerender.reqId);
};

server.isAnyRequestInFlight = function () {
  return this.browserRequestsInFlight.size !== 0;
};

server.isThisTheOnlyInFlightRequest = function (req) {
  return (
    this.browserRequestsInFlight.size === 1 &&
    this.browserRequestsInFlight.has(req.prerender.reqId)
  );
};

server.spawnBrowser = function () {
  util.log(`Starting ${this.browser.name}`);
  return this.browser.spawn(this.options);
};

server.killBrowser = function () {
  util.log(`Stopping ${this.browser.name}`);
  this.isBrowserClosing = true;
  this.browser.kill();
};

server.restartBrowser = function () {
  this.isBrowserConnected = false;
  // Mark a relaunch underway so the watchdog won't fire again until this kill ->
  // onClose -> startPrerender cycle reconnects (which clears the flag). Cleared
  // on a successful reconnect; a failed relaunch exits the process (onClose).
  this.isRestartingBrowser = true;
  this.browserRestarts = (this.browserRestarts || 0) + 1;
  util.log(
    `Restarting ${this.browser.name} (restart #${this.browserRestarts})`,
  );
  this.browser.kill();
};

server.connectToBrowser = function () {
  return this.browser.connect();
};

server.listenForBrowserClose = function () {
  let start = new Date().getTime();

  this.isBrowserClosing = false;

  this.browser.onClose(() => {
    this.isBrowserConnected = false;
    if (this.isBrowserClosing) {
      util.log(`Stopped ${this.browser.name}`);
      return;
    }

    util.log(
      `${this.browser.name} connection closed... restarting ${this.browser.name}`,
    );
    // Whether this close was watchdog/finish-initiated or a spontaneous crash,
    // a relaunch is now underway — hold the watchdog off until it reconnects.
    this.isRestartingBrowser = true;

    if (new Date().getTime() - start < 1000) {
      util.log(
        `${this.browser.name} died immediately after restart... stopping Prerender`,
      );
      return process.exit();
    }

    // Self-heal: if the relaunch can't spawn/connect, don't wedge the server
    // into serving 504s forever (isBrowserConnected would stay false with no
    // retry) — exit so the platform restarts a clean process, like boot does.
    this.startPrerender().catch(() => {
      util.log(
        `Could not relaunch ${this.browser.name} after restart; exiting so the platform starts a clean process`,
      );
      process.exit(1);
    });
  });
};

server.waitForBrowserToConnect = function () {
  return new Promise((resolve, reject) => {
    var checks = 0;

    let check = () => {
      if (++checks > 100) {
        return reject(`Timed out waiting for ${this.browser.name} connection`);
      }

      if (!this.isBrowserConnected) {
        return setTimeout(check, 200);
      }

      resolve();
    };

    check();
  });
};

// --- stall watchdog ---------------------------------------------------------
// True if Chrome appears wedged: render(s) are in flight (we ARE trying to use
// it) but no tab has opened successfully for longer than the stall window. Pure
// (takes `now`) so the decision is unit-testable without timers.
server.browserAppearsStuck = function (now) {
  const stall = this.options && this.options.browserWatchdogStallMs;
  if (!stall || stall <= 0) return false; // disabled
  if (this.isShuttingDown) return false;
  if (this.isRestartingBrowser) return false; // a relaunch is already underway
  if (!this.isAnyRequestInFlight()) return false; // idle -> a stale clock is fine
  return now - (this.lastBrowserOk || 0) > stall;
};

// Indirection so tests can assert escalation without killing the test runner.
server._exitProcess = function (code) {
  if (process.exit) process.exit(code);
};

// One watchdog evaluation: restart a wedged browser (or, if restarts aren't
// helping, exit for replacement). Returns whether it acted.
server.runBrowserWatchdogOnce = function (now) {
  const t = now || new Date().getTime();
  if (!this.browserAppearsStuck(t)) return false;
  const inFlight = this.browserRequestsInFlight
    ? this.browserRequestsInFlight.size
    : 0;
  const sinceOk = t - (this.lastBrowserOk || 0);

  // Rolling-window restart counter. A window that's aged out (Chrome stayed
  // healthy long enough) resets the count, so only SUSTAINED wedging escalates.
  if (
    !this.watchdogWindowStart ||
    t - this.watchdogWindowStart > BROWSER_WATCHDOG_RESTART_WINDOW_MS
  ) {
    this.watchdogWindowStart = t;
    this.watchdogRestartsInWindow = 0;
  }
  this.watchdogRestartsInWindow = (this.watchdogRestartsInWindow || 0) + 1;

  const max = this.options.browserWatchdogMaxRestarts;
  if (max > 0 && this.watchdogRestartsInWindow > max) {
    util.log(
      `Browser watchdog: ${this.watchdogRestartsInWindow} restarts within ` +
        `${BROWSER_WATCHDOG_RESTART_WINDOW_MS}ms — host appears unrecoverable, ` +
        `exiting so the platform replaces this box`,
    );
    this._exitProcess(1);
    return true;
  }

  util.log(
    `Browser watchdog: no successful tab open in ${sinceOk}ms with ` +
      `${inFlight} request(s) in flight — forcing a restart ` +
      `(#${this.watchdogRestartsInWindow} this window)`,
  );
  this.restartBrowser();
  return true;
};

// Start the periodic watchdog (idempotent; unref'd so it never holds the
// process open). A zero period or stall disables it.
server.startBrowserWatchdog = function () {
  const period = this.options && this.options.browserWatchdogPeriod;
  const stall = this.options && this.options.browserWatchdogStallMs;
  if (!period || period <= 0 || !stall || stall <= 0) return;
  if (this.browserWatchdogTimer) return;
  this.browserWatchdogTimer = setInterval(
    () => this.runBrowserWatchdogOnce(new Date().getTime()),
    period,
  );
  if (this.browserWatchdogTimer.unref) this.browserWatchdogTimer.unref();
  util.log(
    `Browser stall watchdog armed (period=${period}ms, stall=${stall}ms)`,
  );
};

server.use = function (plugin) {
  this.plugins.push(plugin);
  if (typeof plugin.init === 'function') plugin.init(this);
};

server.onRequest = function (req, res) {
  req.prerender = util.getOptions(req);
  // Do not rename reqId!
  req.prerender.reqId = uuidv4();
  req.prerender.renderId = uuidv4();
  req.prerender.start = new Date();
  req.prerender.responseSent = false;
  req.server = this;

  util.log('getting', req.prerender.url);
  if (this.browserRequestsInFlight === undefined) {
    return res.sendStatus(503);
  }

  // Draining for shutdown: tell the LB we're unavailable so it routes away.
  if (this.isShuttingDown) {
    return res.sendStatus(503);
  }

  // Test aid (FALLBACK_FORCE): route everything to the SaaS fallback, skipping
  // the local render entirely — to verify the fallback + caching path.
  if (fallback.forced()) {
    util.log('forced fallback for', req.prerender.url);
    return this.serveFromFallback(req, res, 502);
  }

  // NB: the concurrency cap is NOT enforced here at intake. It is applied below,
  // only on a cache MISS, so cache hits (and capacity fallbacks) — which cost no
  // Chrome — are never shed with 429/fallback.
  this.firePluginEvent('requestReceived', req, res)
    .then(() => {
      // Reaching here means the cache MISSED: a hit / hit-wait / no-render rule
      // short-circuits requestReceived via res.send -> the catch below -> finish().
      // So this request needs an ACTUAL local render, and the concurrency cap
      // applies ONLY here. Shed load with 429 + Retry-After (Googlebot backs off
      // and retries) rather than letting Chrome OOM/crash under a crawl spike;
      // 0 = unlimited (backward compatible). The size check and the slot
      // reservation (addRequestToInFlight) are synchronous with no await between
      // them, so a burst of concurrent misses cannot all slip past the cap.
      const maxConcurrent = this.options.maxConcurrentRenders || 0;
      if (
        maxConcurrent > 0 &&
        this.browserRequestsInFlight.size >= maxConcurrent
      ) {
        util.log(
          `at capacity (${this.browserRequestsInFlight.size}/${maxConcurrent}) for`,
          req.prerender.url,
        );
        return this._shedAtCapacity(req, res);
      }
      this.addRequestToInFlight(req);

      if (!validUrl.isWebUri(encodeURI(req.prerender.url))) {
        util.log('invalid URL:', req.prerender.url);
        req.prerender.statusCode = 400;
        return Promise.reject();
      }

      req.prerender.startConnectingToBrowser = new Date();

      return this.firePluginEvent('connectingToBrowserStarted', req, res);
    })
    .then(() => this.waitForBrowserToConnect())
    .then(() => {
      req.prerender.startOpeningTab = new Date();

      //if there is a case where a page hangs, this will at least let us restart chrome
      setTimeout(() => {
        if (!req.prerender.responseSent) {
          util.log('response not sent for', req.prerender.url);
        }
        this.removeRequestFromInFlight(req);
      }, 60000);

      return this.browser.openTab(req.prerender);
    })
    .then((tab) => {
      req.prerender.endOpeningTab = new Date();
      req.prerender.tab = tab;
      // A tab opened -> Chrome's debug endpoint is reachable. This is the
      // watchdog's liveness signal: a slow PAGE never trips it, only a wedged
      // BROWSER (no tab opens at all) does.
      this.lastBrowserOk = req.prerender.endOpeningTab.getTime();

      return this.firePluginEvent('tabCreated', req, res);
    })
    .then(() => {
      req.prerender.startLoadingUrl = new Date();
      // Count an on-demand render attempt (per-domain, persistent metric).
      redisCache.incrMetric('renders', req.prerender.url);
      return this.browser.loadUrlThenWaitForPageLoadEvent(
        req.prerender.tab,
        req.prerender.url,
        () => this.firePluginEvent('tabNavigated', req, res),
      );
    })
    .then(() => {
      req.prerender.endLoadingUrl = new Date();

      if (req.prerender.javascript) {
        return this.browser.executeJavascript(
          req.prerender.tab,
          req.prerender.javascript,
        );
      } else {
        return Promise.resolve();
      }
    })
    .then(() => {
      return this.firePluginEvent('beforeParse', req, res);
    })
    .then(() => {
      req.prerender.startParse = new Date();

      if (req.prerender.renderType == 'png') {
        return this.browser.captureScreenshot(
          req.prerender.tab,
          'png',
          req.prerender.fullpage,
        );
      } else if (req.prerender.renderType == 'jpeg') {
        return this.browser.captureScreenshot(
          req.prerender.tab,
          'jpeg',
          req.prerender.fullpage,
        );
      } else if (req.prerender.renderType == 'pdf') {
        return this.browser.printToPDF(
          req.prerender.tab,
          this.options.pdfOptions,
        );
      } else if (req.prerender.renderType == 'har') {
        return this.browser.getHarFile(req.prerender.tab);
      } else {
        return this.browser.parseHtmlFromPage(req.prerender.tab);
      }
    })
    .then(() => {
      req.prerender.endParse = new Date();

      // Average render time: sum of render durations (paired with `renders`).
      if (req.prerender.startLoadingUrl) {
        redisCache.incrMetric(
          'render_ms',
          req.prerender.url,
          req.prerender.endParse - req.prerender.startLoadingUrl,
        );
      }

      req.prerender.statusCode = req.prerender.tab.prerender.statusCode;
      req.prerender.prerenderData = req.prerender.tab.prerender.prerenderData;
      req.prerender.content = req.prerender.tab.prerender.content;
      req.prerender.headers = req.prerender.tab.prerender.headers;

      return this.firePluginEvent('pageLoaded', req, res);
    })
    .then(() => {
      this.finish(req, res);
    })
    .catch((err) => {
      // A render shed at capacity already sent its response (429 / fallback) — do
      // NOT run finish()/_send, which would overwrite it with a render result.
      if (err === CAPACITY_SHED) return;
      if (err) util.log(err);
      req.prerender.startCatchError = new Date();
      this.finish(req, res);
    })
    .finally(() => {
      this.removeRequestFromInFlight(req);
    });
};

server.finish = function (req, res) {
  req.prerender.startFinish = new Date();
  const url = req.prerender.url;

  if (req.prerender.tab) {
    this.browser.closeTab(req.prerender.tab).catch((err) => {
      util.log(`error closing Chrome tab url=${url}, err=${err}`);
    });
  }

  req.prerender.responseSent = true;
  this.removeRequestFromInFlight(req);

  if (
    !this.isRestartingBrowser &&
    !this.isAnyRequestInFlight() &&
    new Date().getTime() - this.lastRestart >
      this.options.browserTryRestartPeriod
  ) {
    this.lastRestart = new Date().getTime();
    this.restartBrowser();
  }

  req.prerender.timeSpentConnectingToBrowser =
    (req.prerender.startOpeningTab || req.prerender.startFinish) -
      req.prerender.startConnectingToBrowser || 0;
  req.prerender.timeSpentOpeningTab =
    (req.prerender.endOpeningTab || req.prerender.startFinish) -
      req.prerender.startOpeningTab || 0;
  req.prerender.timeSpentLoadingUrl =
    (req.prerender.endLoadingUrl || req.prerender.startFinish) -
      req.prerender.startLoadingUrl || 0;
  req.prerender.timeSpentParsingPage =
    (req.prerender.endParse || req.prerender.startFinish) -
      req.prerender.startParse || 0;
  req.prerender.timeUntilError = 0;

  if (req.prerender.startCatchError) {
    req.prerender.timeUntilError =
      req.prerender.startCatchError - req.prerender.start;
  }

  this.firePluginEvent('beforeSend', req, res)
    .then(() => {
      this._send(req, res);
    })
    .catch(() => {
      this._send(req, res);
    });
};

server.firePluginEvent = function (methodName, req, res) {
  return new Promise((resolve, reject) => {
    let index = 0;
    let done = false;
    let next = null;
    let cancellationToken = null;
    var newRes = {};
    var args = [req, newRes];

    const url = req?.prerender?.url;
    util.debug(`Firing plugin event=${methodName}, url=${url}`);

    newRes.send = function (statusCode, content) {
      clearTimeout(cancellationToken);
      cancellationToken = null;

      if (statusCode) req.prerender.statusCode = statusCode;
      if (content) req.prerender.content = content;
      done = true;
      reject();
    };

    newRes.setHeader = function (key, value) {
      res.setHeader(key, value);
    };

    next = () => {
      clearTimeout(cancellationToken);
      cancellationToken = null;

      if (done) return;

      let layer = this.plugins[index++];
      if (!layer) {
        return resolve();
      }

      let method = layer[methodName];

      if (method) {
        try {
          cancellationToken = setTimeout(() => {
            util.log(
              `Plugin event ${methodName} timed out (10s), layer index: ${index}, url: ${req ? req.url : '-'}`,
            );
          }, 10000);

          method.apply(layer, args);
        } catch (e) {
          util.log(e);
          next();
        }
      } else {
        next();
      }
    };

    args.push(next);
    next();
  });
};

server._send = function (req, res) {
  req.prerender.statusCode =
    parseInt(req.prerender.statusCode) || this.options.renderErrorStatusCode;

  let contentTypes = {
    jpeg: 'image/jpeg',
    png: 'image/png',
    pdf: 'application/pdf',
    har: 'application/json',
  };

  if (req.prerender.renderType == 'html') {
    Object.keys(req.prerender.headers || {}).forEach(function (header) {
      try {
        res.setHeader(header, req.prerender.headers[header].split('\n'));
      } catch (e) {
        util.log('warning: unable to set header:', header);
      }
    });
  }

  if (req.prerender.prerenderData) {
    res.setHeader('Content-Type', 'application/json');
  } else {
    res.setHeader(
      'Content-Type',
      contentTypes[req.prerender.renderType] || 'text/html;charset=UTF-8',
    );
  }

  if (!req.prerender.prerenderData) {
    if (req.prerender.content) {
      if (Buffer.isBuffer(req.prerender.content)) {
        res.setHeader('Content-Length', req.prerender.content.length);
      } else if (typeof req.prerender.content === 'string') {
        res.setHeader(
          'Content-Length',
          Buffer.byteLength(req.prerender.content, 'utf8'),
        );
      }
    }
  }

  //if the original server had a chunked encoding, we should remove it since we aren't sending a chunked response
  res.removeHeader('Transfer-Encoding');
  //if the original server wanted to keep the connection alive, let's close it
  res.removeHeader('Connection');

  res.removeHeader('Content-Encoding');

  if (req.prerender.statusCodeReason) {
    res.setHeader('x-prerender-504-reason', req.prerender.statusCodeReason);
  }
  // The cache refused to store this render (dirtyRender / empty / tooSmall / ...);
  // the refresher reads this to park such a URL instead of re-rendering it forever.
  if (req.prerender._cacheSkipReason) {
    res.setHeader('x-prerender-cache-skip', req.prerender._cacheSkipReason);
  }

  res.status(req.prerender.statusCode);

  if (req.prerender.prerenderData) {
    res.json({
      prerenderData: req.prerender.prerenderData,
      content: req.prerender.content,
    });
  }

  if (!req.prerender.prerenderData && req.prerender.content) {
    res.send(req.prerender.content);
  }

  if (!req.prerender.content) {
    res.end();
  }

  var ms = new Date().getTime() - req.prerender.start.getTime();
  util.log(
    'got',
    req.prerender.statusCode,
    'in',
    ms + 'ms',
    'for',
    req.prerender.url,
  );
};

// Capacity-path fallback: no Chrome slot is free, so proxy this request to the
// SaaS prerender, return that to the caller, and cache it (the cache write +
// lock release happen via the normal finish() -> beforeSend path). The
// render-failure fallback is handled by the fallback plugin's beforeSend hook.
server.serveFromFallback = function (req, res, attemptedStatus) {
  return fallback
    .fetchFallback(req.prerender.url)
    .then((result) => {
      // Served = any non-error result (HTML with a body, OR a 3xx redirect whose body
      // is empty but carries a Location). Failures are {error:true, reason}.
      if (result && !result.error) {
        fallback.apply(req, res, result);
        // Capacity-shed-to-fallback (the 429 path); forced path is test-only.
        if (attemptedStatus === 429)
          redisCache.incrMetric('fallback_capacity', req.prerender.url);
        redisCache.recordFallbackEvent({
          url: req.prerender.url,
          trigger: attemptedStatus,
          outcome: 'served',
          status: result.statusCode,
        });
        util.log(
          'served via fallback after',
          attemptedStatus,
          'for',
          req.prerender.url,
        );
        return this.finish(req, res);
      }
      redisCache.incrMetric('fallback_failed', req.prerender.url);
      redisCache.recordFallbackEvent({
        url: req.prerender.url,
        trigger: attemptedStatus,
        outcome: 'failed',
        reason: (result && result.reason) || 'unknown',
      });
      util.log(
        'fallback unavailable, returning',
        attemptedStatus,
        'for',
        req.prerender.url,
      );
      if (attemptedStatus === 429) {
        res.setHeader('Retry-After', this.options.overloadRetryAfter || '2');
      }
      return res.sendStatus(attemptedStatus);
    })
    .catch(() => res.sendStatus(attemptedStatus));
};

// A cache miss reached the render path while we're at the local concurrency cap.
// We will NOT render here, so first release any single-flight lock we acquired in
// requestReceived — otherwise it would sit until its TTL, blocking a retry or
// another instance (this matters on EVERY shed sub-path, including a fallback whose
// SaaS fetch fails and never reaches beforeSend). Then: if a SaaS fallback is
// configured the external prerenderer handles it (serveFromFallback also caches the
// result); otherwise shed with 429 + Retry-After. Either way reject with
// CAPACITY_SHED so onRequest skips the render chain and its catch skips finish()
// (the response has already been sent here).
server._shedAtCapacity = function (req, res) {
  return Promise.resolve(redisCache.releaseLockForRequest(req))
    .catch(() => {})
    .then(() => {
      if (fallback.enabled()) {
        return this.serveFromFallback(req, res, 429);
      }
      res.setHeader('Retry-After', this.options.overloadRetryAfter || '2');
      return res.sendStatus(429);
    })
    .then(() => Promise.reject(CAPACITY_SHED));
};

module.exports = server;
