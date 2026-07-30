const assert = require('assert');
const server = require('../lib/server');
const health = require('../lib/health');
const refresher = require('../lib/refresher');
const seeder = require('../lib/seeder');
const redisCache = require('../lib/plugins/redisCache');

// /ready delegates to server.isReady(); test that logic directly so we don't
// need to boot Express/Chrome.
describe('server readiness (isReady)', function () {
  let originalConnected, originalShutdown;

  beforeEach(function () {
    originalConnected = server.isBrowserConnected;
    originalShutdown = server.isShuttingDown;
  });

  afterEach(function () {
    server.isBrowserConnected = originalConnected;
    server.isShuttingDown = originalShutdown;
  });

  it('is ready when the browser is connected and not shutting down', function () {
    server.isBrowserConnected = true;
    server.isShuttingDown = false;
    assert.strictEqual(server.isReady(), true);
  });

  it('is not ready when the browser is not connected', function () {
    server.isBrowserConnected = false;
    server.isShuttingDown = false;
    assert.strictEqual(server.isReady(), false);
  });

  it('is not ready while shutting down', function () {
    server.isBrowserConnected = true;
    server.isShuttingDown = true;
    assert.strictEqual(server.isReady(), false);
  });
});

// --- refresher deep liveness -------------------------------------------------
// A fake server exposing just what the refresher reads.
function makeServer(max, inFlight) {
  const m = new Map();
  for (let i = 0; i < (inFlight || 0); i += 1) m.set('r' + i, 'u');
  return {
    options: { maxConcurrentRenders: max },
    browserRequestsInFlight: m,
    isShuttingDown: false,
  };
}

function pendingRender() {
  return new Promise(() => {});
}

describe('refresher.health', function () {
  let clock;
  const now = () => clock;

  beforeEach(function () {
    clock = 1000000;
  });

  afterEach(function () {
    refresher.stop();
    delete process.env.REFRESHER_CONCURRENCY;
    delete process.env.HEALTH_REFRESHER_RENDER_STALL_MS;
    delete process.env.HEALTH_REFRESHER_LATCH_STALL_MS;
  });

  it('is not armed before start (the on-demand tier never runs it)', function () {
    refresher.stop();
    assert.strictEqual(refresher.health(clock).armed, false);
  });

  it('is not armed once stopped for shutdown', function () {
    refresher.start(makeServer(0), 3000, { manual: true, now });
    assert.strictEqual(refresher.health(clock).armed, true);
    refresher.stop();
    assert.strictEqual(refresher.health(clock).armed, false);
  });

  it('is healthy immediately after start (heartbeat seeded before the first tick)', function () {
    refresher.start(makeServer(0), 3000, { manual: true, now });
    const h = refresher.health(clock);
    assert.strictEqual(h.ok, true);
    assert.strictEqual(h.tickAgeMs, 0);
    assert.deepStrictEqual(h.failing, []);
  });

  it('reports tick-stalled once the loop stops re-arming itself', function () {
    refresher.start(makeServer(0), 3000, { manual: true, now });
    const stall = refresher.health(clock).thresholds.tickStallMs;
    clock += stall; // exactly at the threshold is still fine
    assert.strictEqual(refresher.health(clock).ok, true);
    clock += 1;
    const h = refresher.health(clock);
    assert.strictEqual(h.ok, false);
    assert.deepStrictEqual(h.failing, ['tick-stalled']);
  });

  it('a tick clears a stale heartbeat', async function () {
    refresher.start(makeServer(0), 3000, {
      manual: true,
      now,
      render: pendingRender,
      dueForRefresh: () => Promise.resolve([]),
      dequeue: () => Promise.resolve([]),
    });
    clock += refresher.health(clock).thresholds.tickStallMs + 1;
    assert.strictEqual(refresher.health(clock).ok, false);
    await refresher._tickOnce();
    assert.strictEqual(refresher.health(clock).ok, true);
  });

  it('counts renders that outlived their timeout, but only a full starve fails', async function () {
    process.env.REFRESHER_CONCURRENCY = '2';
    process.env.HEALTH_REFRESHER_RENDER_STALL_MS = '5000';
    let n = 0;
    refresher.start(makeServer(0), 3000, {
      manual: true,
      now,
      render: pendingRender,
      dequeue: () => Promise.resolve([]),
      // one fresh URL per tick, so we wedge exactly one slot at a time
      dueForRefresh: () => Promise.resolve(['u' + n++]),
      claim: () => Promise.resolve(true),
    });

    await refresher._tickOnce(); // u0 in flight, never settles
    clock += 6000;
    let h = refresher.health(clock);
    assert.strictEqual(h.stuckRenders, 1);
    assert.strictEqual(h.oldestInFlightMs, 6000);
    // 1 of 2 slots wedged: degraded, but the box is still doing work
    assert.strictEqual(h.ok, true);

    await refresher._tickOnce(); // u1 in flight too -> no slots left, ever
    clock += 6000;
    h = refresher.health(clock);
    assert.strictEqual(h.stuckRenders, 2);
    assert.strictEqual(h.ok, false);
    assert.deepStrictEqual(h.failing, ['capacity-starved']);
  });

  it('a settled render gives its slot back and clears the stuck count', async function () {
    process.env.REFRESHER_CONCURRENCY = '1';
    process.env.HEALTH_REFRESHER_RENDER_STALL_MS = '5000';
    let resolveRender;
    refresher.start(makeServer(0), 3000, {
      manual: true,
      now,
      render: () => new Promise((r) => (resolveRender = r)),
      dequeue: () => Promise.resolve([]),
      dueForRefresh: () => Promise.resolve(['u0']),
      claim: () => Promise.resolve(true),
      release: () => Promise.resolve(),
    });

    await refresher._tickOnce();
    clock += 6000;
    assert.strictEqual(refresher.health(clock).ok, false);

    resolveRender(200);
    // let launch()'s .then chain drain
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
    const h = refresher.health(clock);
    assert.strictEqual(h.stuckRenders, 0);
    assert.strictEqual(h.inFlight, 0);
    assert.strictEqual(h.ok, true);
  });

  it('reports a producer latch that never released', function () {
    process.env.HEALTH_REFRESHER_LATCH_STALL_MS = '10000';
    refresher.start(makeServer(0), 3000, { manual: true, now });
    refresher._setLatchForTests('produce', clock);
    clock += 10001;
    const h = refresher.health(clock);
    assert.strictEqual(h.ok, false);
    assert.deepStrictEqual(h.failing, ['producer-stalled']);
    refresher._setLatchForTests('produce', 0);
    assert.strictEqual(refresher.health(clock).ok, true);
  });

  it('reports a reaper latch that never released', function () {
    process.env.HEALTH_REFRESHER_LATCH_STALL_MS = '10000';
    refresher.start(makeServer(0), 3000, { manual: true, now });
    refresher._setLatchForTests('reap', clock);
    clock += 10001;
    assert.deepStrictEqual(refresher.health(clock).failing, ['reaper-stalled']);
    refresher._setLatchForTests('reap', 0);
  });
});

// --- seeder deep liveness ----------------------------------------------------
describe('seeder.health', function () {
  let clock;
  const now = () => clock;

  function deps(overrides) {
    return Object.assign(
      {
        manual: true,
        now,
        fetch: () => Promise.reject(new Error('no fetch stubbed')),
        status: (urls) => Promise.resolve(urls.map(() => ({ cached: false }))),
        enqueue: (urls) => Promise.resolve(urls.length),
        getSitemapList: () => Promise.resolve([]),
        getLastScanAt: () => Promise.resolve(null),
        setLastScanAt: () => Promise.resolve(),
        acquireLock: () => Promise.resolve(true),
        renewLock: () => Promise.resolve(true),
        releaseLock: () => Promise.resolve(),
        recordStatus: () => Promise.resolve(),
        pruneStatuses: () => Promise.resolve(),
        sleep: () => Promise.resolve(),
      },
      overrides || {},
    );
  }

  beforeEach(function () {
    clock = 2000000;
  });

  afterEach(function () {
    seeder.stop();
    delete process.env.HEALTH_SEEDER_STALL_MS;
  });

  it('is not armed before start', function () {
    seeder.stop();
    assert.strictEqual(seeder.health(clock).armed, false);
  });

  it('is healthy immediately after start', function () {
    seeder.start({ isShuttingDown: false }, deps());
    const h = seeder.health(clock);
    assert.strictEqual(h.ok, true);
    assert.strictEqual(h.beatAgeMs, 0);
    assert.strictEqual(h.scanning, false);
  });

  it('reports tick-stalled once the loop stops re-arming itself', function () {
    process.env.HEALTH_SEEDER_STALL_MS = '30000';
    seeder.start({ isShuttingDown: false }, deps());
    clock += 30001;
    const h = seeder.health(clock);
    assert.strictEqual(h.ok, false);
    assert.deepStrictEqual(h.failing, ['tick-stalled']);
  });

  it('a long but ADVANCING scan keeps the heartbeat fresh', async function () {
    process.env.HEALTH_SEEDER_STALL_MS = '30000';
    // Each fetch burns 20s of wall clock — under the threshold on its own, but
    // three of them in one scan is 60s, well past it in total.
    let i = 0;
    seeder.start(
      { isShuttingDown: false },
      deps({
        getSitemapList: () =>
          Promise.resolve([
            { id: 1, url: 'https://a/s.xml', enabled: true },
            { id: 2, url: 'https://b/s.xml', enabled: true },
            { id: 3, url: 'https://c/s.xml', enabled: true },
          ]),
        fetch: () => {
          clock += 20000;
          return Promise.resolve(
            `<urlset><url><loc>https://x/p${i++}</loc></url></urlset>`,
          );
        },
      }),
    );
    await seeder._tickOnce();
    const h = seeder.health(clock);
    assert.strictEqual(h.ok, true);
    assert.ok(h.beatAgeMs <= 30000);
  });

  it('a scan wedged inside one fetch does go stale', async function () {
    process.env.HEALTH_SEEDER_STALL_MS = '30000';
    seeder.start(
      { isShuttingDown: false },
      deps({
        getSitemapList: () =>
          Promise.resolve([{ id: 1, url: 'https://a/s.xml', enabled: true }]),
        fetch: () => new Promise(() => {}), // never settles
      }),
    );
    seeder._tickOnce(); // deliberately not awaited: it never resolves
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
    clock += 30001;
    const h = seeder.health(clock);
    assert.strictEqual(h.ok, false);
    assert.deepStrictEqual(h.failing, ['tick-stalled']);
    assert.strictEqual(h.scanning, true);
  });
});

// --- aggregate report --------------------------------------------------------
describe('health.report', function () {
  let fakeServer;

  beforeEach(function () {
    fakeServer = {
      isBrowserConnected: true,
      isShuttingDown: false,
      isRestartingBrowser: false,
      browserRequestsInFlight: new Map(),
    };
    refresher.stop();
    seeder.stop();
    redisCache._reset();
  });

  afterEach(function () {
    delete process.env.HEALTH_DEEP;
    delete process.env.HEALTH_REQUIRE_REDIS;
    delete process.env.REFRESHER_MODE;
    redisCache._reset();
  });

  it('is ok on an on-demand box with no loops armed', function () {
    const r = health.report(fakeServer);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.role, 'on-demand');
    assert.strictEqual(r.checks.refresher.armed, false);
    assert.strictEqual(r.checks.seeder.armed, false);
  });

  it('reports the scheduled role when REFRESHER_MODE is on', function () {
    process.env.REFRESHER_MODE = 'true';
    assert.strictEqual(health.report(fakeServer).role, 'scheduled');
  });

  it('fails when the browser is disconnected', function () {
    fakeServer.isBrowserConnected = false;
    const r = health.report(fakeServer);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 'unhealthy');
    assert.deepStrictEqual(r.failing, ['browser.browser-disconnected']);
  });

  it('fails while draining for shutdown', function () {
    fakeServer.isShuttingDown = true;
    assert.deepStrictEqual(health.report(fakeServer).failing, [
      'browser.shutting-down',
    ]);
  });

  it('namespaces a stalled loop reason under its check', function () {
    let clock = 5000000;
    refresher.start(makeServer(0), 3000, { manual: true, now: () => clock });
    clock += refresher.health(clock).thresholds.tickStallMs + 1;
    const r = health.report(fakeServer, clock);
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.failing, ['refresher.tick-stalled']);
    refresher.stop();
  });

  it('reports a disconnected Redis as degraded but not fatal', function () {
    redisCache._setEnabledForTests(true);
    redisCache._setClientForTests({ status: 'reconnecting' });
    const r = health.report(fakeServer);
    assert.strictEqual(r.checks.redis.degraded, true);
    assert.strictEqual(r.checks.redis.connected, false);
    assert.strictEqual(r.ok, true); // a restart cannot fix Redis
    assert.deepStrictEqual(r.failing, []);
  });

  it('fails on a disconnected Redis when HEALTH_REQUIRE_REDIS is set', function () {
    process.env.HEALTH_REQUIRE_REDIS = 'true';
    redisCache._setEnabledForTests(true);
    redisCache._setClientForTests({ status: 'reconnecting' });
    const r = health.report(fakeServer);
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.failing, ['redis.redis-disconnected']);
  });

  it('ignores Redis entirely when the cache is disabled', function () {
    redisCache._setEnabledForTests(false);
    const r = health.report(fakeServer);
    assert.strictEqual(r.checks.redis.armed, false);
    assert.strictEqual(r.ok, true);
  });

  it('HEALTH_DEEP=false degrades to a bare liveness 200', function () {
    process.env.HEALTH_DEEP = 'false';
    fakeServer.isBrowserConnected = false; // would otherwise fail
    const r = health.report(fakeServer);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.deep, false);
    assert.deepStrictEqual(r.checks, {});
  });

  it('the unauthenticated summary keeps the verdict and drops the detail', function () {
    fakeServer.isBrowserConnected = false;
    const s = health.summarize(health.report(fakeServer));
    assert.deepStrictEqual(s, {
      status: 'unhealthy',
      ok: false,
      failing: ['browser.browser-disconnected'],
    });
    assert.strictEqual(s.checks, undefined);
  });
});
