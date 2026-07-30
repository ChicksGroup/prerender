// Deep liveness for the platform's health check (DO App Platform `health_check`).
//
// Why this exists: the shallow "the process is up" answer is not useful for this
// service, because the way it actually breaks in production is SILENT. Every
// background loop is either a self-rescheduling setTimeout chain or an interval
// guarded by a re-entrancy latch, so a single promise that never settles removes
// that loop permanently — no crash, no stack trace, no missed-tick log. Express
// keeps answering, Chrome keeps idling, and the crawl work just stops until
// somebody notices and restarts the instance.
//
// So each loop publishes its own heartbeat (refresher.health / seeder.health) and
// this module aggregates them into one verdict the platform can act on. A failing
// probe means "restart me": every condition below is one a fresh process fixes.
// Conditions a restart CANNOT fix — Redis being down, above all — are reported
// but never fatal, because failing on those would restart every instance at once
// and turn a dependency outage into an outage of our own.
//
// Roles: the on-demand tier runs neither the refresher nor the seeder, so their
// checks report armed:false there and are skipped. The same endpoint therefore
// serves both tiers with no per-tier configuration.
const refresher = require('./refresher');
const seeder = require('./seeder');
const redisCache = require('./plugins/redisCache');

// Escape hatch: HEALTH_DEEP=false reverts /health to a bare liveness 200 without
// a rollback, in case a threshold turns out to be wrong in production and the
// probe starts restarting healthy boxes. The knob is deliberately fail-safe —
// only the exact string 'false' turns the deep checks off.
function deepEnabled() {
  return (process.env.HEALTH_DEEP || 'true') !== 'false';
}

function requireRedis() {
  return (process.env.HEALTH_REQUIRE_REDIS || 'false') === 'true';
}

function role() {
  return (process.env.REFRESHER_MODE || '') === 'true'
    ? 'scheduled'
    : 'on-demand';
}

// Chrome. Same predicate as /ready (connected + not draining): a disconnected
// browser 504s every render, and the in-process self-heal — onClose -> relaunch,
// or the stall watchdog — either recovers within seconds or exits the process on
// its own. This check is the backstop for the case where neither happens.
function browserCheck(server) {
  const connected = server.isBrowserConnected === true;
  const shuttingDown = !!server.isShuttingDown;
  return {
    armed: true,
    ok: connected && !shuttingDown,
    failing: connected
      ? shuttingDown
        ? ['shutting-down']
        : []
      : ['browser-disconnected'],
    connected,
    shuttingDown,
    restarting: !!server.isRestartingBrowser,
    inFlight: server.browserRequestsInFlight
      ? server.browserRequestsInFlight.size
      : null,
  };
}

function redisCheck() {
  let c;
  try {
    c = redisCache.health();
  } catch (e) {
    c = {
      enabled: false,
      status: null,
      connected: false,
      error: e && e.message,
    };
  }
  // Not armed when the cache is off (dev / a tier running without Redis).
  const armed = !!c.enabled;
  const down = armed && !c.connected;
  return Object.assign({}, c, {
    armed,
    // Advisory unless HEALTH_REQUIRE_REDIS: see the module header.
    ok: !down || !requireRedis(),
    degraded: down,
    failing: down && requireRedis() ? ['redis-disconnected'] : [],
  });
}

// Full report. `now` is injectable so the thresholds are testable without timers.
function report(server, now) {
  const t = now || Date.now();
  const base = {
    status: 'ok',
    ok: true,
    role: role(),
    pid: process.pid,
    uptimeMs: Math.round(process.uptime() * 1000),
    deep: deepEnabled(),
  };
  if (!deepEnabled()) return Object.assign(base, { failing: [], checks: {} });

  const checks = {
    browser: browserCheck(server),
    refresher: refresher.health(t),
    seeder: seeder.health(t),
    redis: redisCheck(),
  };

  // A check that isn't armed on this instance contributes nothing either way.
  const failing = [];
  for (const name of Object.keys(checks)) {
    const c = checks[name];
    if (!c || !c.armed) continue;
    for (const reason of c.failing || []) failing.push(`${name}.${reason}`);
  }

  const ok = failing.length === 0;
  return Object.assign(base, {
    ok,
    status: ok ? 'ok' : 'unhealthy',
    failing,
    checks,
  });
}

// Unauthenticated view. The platform probe can't send the shared token (DO's
// health_check has no header support), and only the status code matters to it —
// so callers without the token get the verdict and the machine-readable reasons,
// but none of the operational detail (cached URLs in flight, queue/scan state).
function summarize(full) {
  return {
    status: full.status,
    ok: full.ok,
    failing: full.failing || [],
  };
}

module.exports = { report, summarize, deepEnabled };
