const assert = require('assert');
const sinon = require('sinon');
const server = require('../lib/server');
const browserForceRestart = require('../lib/plugins/browserForceRestart');

// The stall watchdog force-restarts a wedged Chrome that finish()'s
// idle-only recycle can never reach under continuous load. We test the
// decision (browserAppearsStuck), the action + escalation
// (runBrowserWatchdogOnce), and the timer wiring (startBrowserWatchdog)
// directly against the server singleton — no Express/Chrome boot needed.
describe('server browser stall watchdog', function () {
  const STALL = 90000;
  let sandbox, now, saved;

  // Snapshot every singleton field these tests mutate, so nothing leaks into
  // other specs that share the require('../lib/server') singleton.
  const KEYS = [
    'isShuttingDown',
    'isRestartingBrowser',
    'lastBrowserOk',
    'lastRestart',
    'browserRequestsInFlight',
    'browserWatchdogTimer',
    'watchdogWindowStart',
    'watchdogRestartsInWindow',
    'isBrowserConnected',
    'browser',
    'plugins',
    'options',
  ];

  function inFlight(n) {
    server.browserRequestsInFlight = new Map();
    for (let i = 0; i < n; i += 1) {
      server.browserRequestsInFlight.set('r' + i, 'https://x/' + i);
    }
  }

  beforeEach(function () {
    sandbox = sinon.createSandbox();
    saved = {};
    KEYS.forEach((k) => {
      saved[k] = server[k];
    });
    server.init({ browserWatchdogStallMs: STALL, browserWatchdogPeriod: 15000 });
    now = 1_000_000_000_000;
    server.isShuttingDown = false;
    server.isRestartingBrowser = false;
    server.lastBrowserOk = now; // healthy: a tab just opened
    server.browserWatchdogTimer = null;
    server.watchdogWindowStart = 0;
    server.watchdogRestartsInWindow = 0;
    inFlight(2); // we ARE trying to render
  });

  afterEach(function () {
    if (server.browserWatchdogTimer) clearInterval(server.browserWatchdogTimer);
    sandbox.restore();
    KEYS.forEach((k) => {
      server[k] = saved[k];
    });
  });

  describe('browserAppearsStuck', function () {
    it('is NOT stuck while tabs are opening (fresh health clock)', function () {
      server.lastBrowserOk = now - 1000; // 1s ago — well inside the window
      assert.strictEqual(server.browserAppearsStuck(now), false);
    });

    it('IS stuck when no tab has opened for longer than the stall window', function () {
      server.lastBrowserOk = now - (STALL + 1);
      assert.strictEqual(server.browserAppearsStuck(now), true);
    });

    it('un-sticks once a tab opens again (lastBrowserOk advances)', function () {
      server.lastBrowserOk = now - (STALL + 1);
      assert.strictEqual(server.browserAppearsStuck(now), true);
      server.lastBrowserOk = now; // a tab just opened
      assert.strictEqual(server.browserAppearsStuck(now), false);
    });

    it('is NOT stuck when nothing is in flight (an idle box has a stale clock)', function () {
      server.lastBrowserOk = now - 10 * STALL;
      inFlight(0);
      assert.strictEqual(server.browserAppearsStuck(now), false);
    });

    it('is NOT stuck while a relaunch is already underway', function () {
      server.lastBrowserOk = now - 10 * STALL;
      server.isRestartingBrowser = true;
      assert.strictEqual(server.browserAppearsStuck(now), false);
    });

    it('is NOT stuck while shutting down', function () {
      server.lastBrowserOk = now - 10 * STALL;
      server.isShuttingDown = true;
      assert.strictEqual(server.browserAppearsStuck(now), false);
    });

    it('is disabled when the stall window is 0', function () {
      server.init({ browserWatchdogStallMs: 0, browserWatchdogPeriod: 15000 });
      server.lastBrowserOk = now - 10 * STALL;
      inFlight(2);
      assert.strictEqual(server.browserAppearsStuck(now), false);
    });
  });

  describe('runBrowserWatchdogOnce', function () {
    it('restarts a stuck browser and reports it acted', function () {
      const restart = sandbox.stub(server, 'restartBrowser');
      server.lastBrowserOk = now - (STALL + 1);
      assert.strictEqual(server.runBrowserWatchdogOnce(now), true);
      assert.strictEqual(restart.calledOnce, true);
    });

    it('does nothing when the browser is healthy', function () {
      const restart = sandbox.stub(server, 'restartBrowser');
      server.lastBrowserOk = now - 1000;
      assert.strictEqual(server.runBrowserWatchdogOnce(now), false);
      assert.strictEqual(restart.called, false);
    });

    it('defaults `now` to the wall clock when called with no argument', function () {
      const restart = sandbox.stub(server, 'restartBrowser');
      server.lastBrowserOk = 0; // ancient relative to the real clock
      assert.strictEqual(server.runBrowserWatchdogOnce(), true);
      assert.strictEqual(restart.calledOnce, true);
    });

    it('escalates to process exit after too many restarts in the window', function () {
      const restart = sandbox.stub(server, 'restartBrowser'); // stub leaves isRestartingBrowser false
      const exit = sandbox.stub(server, '_exitProcess');
      server.lastBrowserOk = now - (STALL + 1);
      // max default is 5: calls 1..5 restart, the 6th escalates.
      for (let i = 0; i < 5; i += 1) {
        server.runBrowserWatchdogOnce(now + i * 1000);
      }
      assert.strictEqual(restart.callCount, 5);
      assert.strictEqual(exit.called, false);
      server.runBrowserWatchdogOnce(now + 5000);
      assert.strictEqual(restart.callCount, 5, 'no further restart once escalating');
      assert.strictEqual(exit.calledOnceWithExactly(1), true);
    });

    it('does not escalate when restarts are spread beyond the window', function () {
      const restart = sandbox.stub(server, 'restartBrowser');
      const exit = sandbox.stub(server, '_exitProcess');
      server.lastBrowserOk = now - (STALL + 1);
      const farApart = 700000; // > 10-min window, so each resets the counter
      for (let i = 0; i < 8; i += 1) {
        server.runBrowserWatchdogOnce(now + i * farApart);
      }
      assert.strictEqual(exit.called, false);
      assert.strictEqual(restart.callCount, 8);
    });
  });

  describe('startBrowserWatchdog', function () {
    it('arms a timer when enabled and is idempotent', function () {
      server.startBrowserWatchdog();
      const first = server.browserWatchdogTimer;
      assert.ok(first, 'a timer was armed');
      server.startBrowserWatchdog();
      assert.strictEqual(server.browserWatchdogTimer, first, 'no second timer');
    });

    it('does not arm a timer when the stall window is 0', function () {
      server.init({ browserWatchdogStallMs: 0, browserWatchdogPeriod: 15000 });
      server.browserWatchdogTimer = null;
      server.startBrowserWatchdog();
      assert.strictEqual(server.browserWatchdogTimer, null);
    });

    it('does not arm a timer when the period is 0', function () {
      server.init({ browserWatchdogStallMs: STALL, browserWatchdogPeriod: 0 });
      server.browserWatchdogTimer = null;
      server.startBrowserWatchdog();
      assert.strictEqual(server.browserWatchdogTimer, null);
    });

    it('the armed interval actually fires runBrowserWatchdogOnce (this-bound)', function () {
      const clock = sandbox.useFakeTimers(now);
      const restart = sandbox.stub(server, 'restartBrowser');
      server.lastBrowserOk = now - (STALL + 1); // wedged
      inFlight(1);
      server.startBrowserWatchdog(); // period 15000
      clock.tick(15001);
      assert.strictEqual(restart.calledOnce, true);
    });
  });
});

// The watchdog adds an isRestartingBrowser guard; browserForceRestart must
// respect it so it doesn't re-disconnect mid-relaunch.
describe('browserForceRestart honors an in-progress relaunch', function () {
  const ORIG = process.env.BROWSER_FORCE_RESTART_PERIOD;
  afterEach(function () {
    if (ORIG === undefined) delete process.env.BROWSER_FORCE_RESTART_PERIOD;
    else process.env.BROWSER_FORCE_RESTART_PERIOD = ORIG;
  });

  function fakeReq(srv) {
    return {
      server: srv,
      prerender: { reqId: 'a', url: 'https://x/' },
    };
  }

  it('does not disconnect while isRestartingBrowser is true', function (done) {
    const srv = {
      isRestartingBrowser: true,
      isBrowserConnected: true,
      lastRestart: 0, // ancient -> force-restart window long elapsed
      isThisTheOnlyInFlightRequest: () => false,
    };
    browserForceRestart.connectingToBrowserStarted(fakeReq(srv), {}, () => {
      assert.strictEqual(srv.isBrowserConnected, true, 'left connected');
      done();
    });
  });

  it('still disconnects normally when no relaunch is underway', function (done) {
    const srv = {
      isRestartingBrowser: false,
      isBrowserConnected: true,
      lastRestart: 0,
      isThisTheOnlyInFlightRequest: () => false,
    };
    browserForceRestart.connectingToBrowserStarted(fakeReq(srv), {}, () => {
      assert.strictEqual(srv.isBrowserConnected, false, 'disconnected for restart');
      done();
    });
  });
});
