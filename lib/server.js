const util = require('./util.js');
const validUrl = require('valid-url');
const { v4: uuidv4 } = require('uuid');

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

  this.browser = require('./browsers/chrome');

  return this;
};

server.start = function () {
  util.log('Starting Prerender');
  this.isBrowserConnected = false;
  this.isShuttingDown = false;
  this.startPrerender()
    .then(() => {
      // App Platform (and most orchestrators) send SIGTERM on deploy/scale-down;
      // SIGINT covers local Ctrl-C. Both drain gracefully.
      process.on('SIGTERM', () => this.shutdown());
      process.on('SIGINT', () => this.shutdown());
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

    if (new Date().getTime() - start < 1000) {
      util.log(
        `${this.browser.name} died immediately after restart... stopping Prerender`,
      );
      return process.exit();
    }

    this.startPrerender();
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

  // Concurrency cap: shed load with 429 + Retry-After rather than letting
  // Chrome OOM/crash under a crawl spike. Googlebot honors 429+Retry-After by
  // backing off and retrying. 0 = unlimited (backward compatible).
  const maxConcurrent = this.options.maxConcurrentRenders || 0;
  if (maxConcurrent > 0 && this.browserRequestsInFlight.size >= maxConcurrent) {
    util.log(
      `at capacity (${this.browserRequestsInFlight.size}/${maxConcurrent}), returning 429 for`,
      req.prerender.url,
    );
    res.setHeader('Retry-After', this.options.overloadRetryAfter || '2');
    return res.sendStatus(429);
  }

  this.addRequestToInFlight(req);

  this.firePluginEvent('requestReceived', req, res)
    .then(() => {
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

      return this.firePluginEvent('tabCreated', req, res);
    })
    .then(() => {
      req.prerender.startLoadingUrl = new Date();
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

module.exports = server;
