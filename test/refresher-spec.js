const assert = require('assert');
const sinon = require('sinon');
const refresher = require('../lib/refresher');

// A fake server exposing just what the refresher reads: the concurrency cap and
// the in-flight Map (its size is the live load signal).
function makeServer(max, inFlight) {
  const m = new Map();
  for (let i = 0; i < (inFlight || 0); i += 1) m.set('r' + i, 'u');
  return {
    options: { maxConcurrentRenders: max },
    browserRequestsInFlight: m,
    isShuttingDown: false,
  };
}

// A render that never settles, so launched URLs stay "in progress" for assertions.
function pendingRender() {
  return new Promise(() => {});
}

describe('refresher', function () {
  afterEach(function () {
    refresher.stop();
    delete process.env.REFRESHER_CONCURRENCY;
  });

  it('launches up to REFRESHER_CONCURRENCY and no more', async function () {
    process.env.REFRESHER_CONCURRENCY = '2';
    const calls = [];
    const render = (url) => {
      calls.push(url);
      return pendingRender();
    };
    const due = ({ limit, exclude }) =>
      Promise.resolve(
        ['a', 'b', 'c', 'd'].filter((u) => !exclude.has(u)).slice(0, limit),
      );
    refresher.start(makeServer(0), 3000, {
      render,
      dueForRefresh: due,
      manual: true,
    });

    await refresher._tickOnce();
    assert.equal(refresher._inProgress().size, 2); // capped at concurrency
    assert.deepEqual(calls.sort(), ['a', 'b']);
  });

  it('respects box capacity (maxConcurrentRenders - inFlight)', async function () {
    process.env.REFRESHER_CONCURRENCY = '10';
    const due = ({ limit }) =>
      Promise.resolve(['a', 'b', 'c', 'd', 'e'].slice(0, limit));
    // box max 4 with 3 already in flight -> only 1 free slot
    refresher.start(makeServer(4, 3), 3000, {
      render: pendingRender,
      dueForRefresh: due,
      manual: true,
    });
    await refresher._tickOnce();
    assert.equal(refresher._inProgress().size, 1);
  });

  it('forwards in-progress URLs as the exclude set', async function () {
    process.env.REFRESHER_CONCURRENCY = '4';
    let lastExclude = null;
    const due = ({ limit, exclude }) => {
      lastExclude = exclude;
      return Promise.resolve(
        ['a', 'b'].filter((u) => !exclude.has(u)).slice(0, limit),
      );
    };
    refresher.start(makeServer(0), 3000, {
      render: pendingRender,
      dueForRefresh: due,
      manual: true,
    });
    await refresher._tickOnce(); // launches a, b
    assert.equal(refresher._inProgress().size, 2);
    await refresher._tickOnce(); // a, b excluded -> nothing new
    assert.ok(lastExclude.has('a') && lastExclude.has('b'));
    assert.equal(refresher._inProgress().size, 2);
  });

  it('removes a URL from in-progress once its render settles', async function () {
    process.env.REFRESHER_CONCURRENCY = '2';
    let resolveRender;
    const render = () =>
      new Promise((res) => {
        resolveRender = res;
      });
    const due = ({ limit, exclude }) =>
      Promise.resolve(['a'].filter((u) => !exclude.has(u)).slice(0, limit));
    refresher.start(makeServer(0), 3000, {
      render,
      dueForRefresh: due,
      manual: true,
    });
    await refresher._tickOnce();
    assert.deepEqual([...refresher._inProgress()], ['a']);
    resolveRender(200);
    await new Promise((r) => setImmediate(r)); // flush the launch .then chain
    assert.equal(refresher._inProgress().size, 0);
  });

  it('does nothing while shutting down', async function () {
    const srv = makeServer(0);
    srv.isShuttingDown = true;
    refresher.start(srv, 3000, {
      render: () => Promise.resolve(200),
      dueForRefresh: () => Promise.resolve(['a', 'b']),
      manual: true,
    });
    const r = await refresher._tickOnce();
    assert.equal(refresher._inProgress().size, 0);
    assert.ok(r.stopped);
  });
});

describe('refresher queue consumption', function () {
  afterEach(function () {
    refresher.stop();
    delete process.env.REFRESHER_CONCURRENCY;
  });

  it('drains the queue first, then tops up with time-based refresh', async function () {
    process.env.REFRESHER_CONCURRENCY = '4';
    const launched = [];
    const clearAttempt = sinon.spy();
    refresher.start(makeServer(0), 3000, {
      render: (u) => {
        launched.push(u);
        return Promise.resolve(200);
      },
      dequeue: (n) => Promise.resolve(['q1', 'q2'].slice(0, n)),
      dueForRefresh: () => Promise.resolve(['r1']),
      clearAttempt,
      manual: true,
    });
    await refresher._tickOnce();
    await new Promise((r) => setImmediate(r)); // let renders settle
    assert.deepEqual(launched.sort(), ['q1', 'q2', 'r1']);
    assert(clearAttempt.calledWith('q1')); // queue items clear their retry counter
    assert(clearAttempt.calledWith('q2'));
    assert(!clearAttempt.calledWith('r1')); // refresh items don't touch the queue
  });

  it('requeues a queue item whose render fails', async function () {
    process.env.REFRESHER_CONCURRENCY = '4';
    const requeue = sinon.spy();
    refresher.start(makeServer(0), 3000, {
      render: () => Promise.reject(new Error('boom')),
      dequeue: (n) => Promise.resolve(['q1'].slice(0, n)),
      dueForRefresh: () => Promise.resolve([]),
      requeue,
      manual: true,
    });
    await refresher._tickOnce();
    await new Promise((r) => setImmediate(r));
    assert(requeue.calledWith('q1'));
  });

  it('requeues a queue item that comes back 5xx', async function () {
    process.env.REFRESHER_CONCURRENCY = '4';
    const requeue = sinon.spy();
    const clearAttempt = sinon.spy();
    refresher.start(makeServer(0), 3000, {
      render: () => Promise.resolve(504),
      dequeue: (n) => Promise.resolve(['q1'].slice(0, n)),
      dueForRefresh: () => Promise.resolve([]),
      requeue,
      clearAttempt,
      manual: true,
    });
    await refresher._tickOnce();
    await new Promise((r) => setImmediate(r));
    assert(requeue.calledWith('q1'));
    assert(!clearAttempt.calledWith('q1'));
  });
});

describe('refresher failure cooldown', function () {
  afterEach(function () {
    refresher.stop();
    delete process.env.REFRESHER_CONCURRENCY;
    delete process.env.REFRESHER_FAIL_COOLDOWN_MS;
  });

  const flush = () => new Promise((r) => setImmediate(r));

  it('parks a refresh URL that 504s and advances to healthy work next tick', async function () {
    process.env.REFRESHER_CONCURRENCY = '1';
    const rendered = [];
    const render = (u) => {
      rendered.push(u);
      return Promise.resolve(u === 'broken' ? 504 : 200);
    };
    // oldest-first: 'broken' would be picked every tick without the cooldown.
    const due = ({ limit, exclude }) =>
      Promise.resolve(['broken', 'good'].filter((u) => !exclude.has(u)).slice(0, limit));
    refresher.start(makeServer(0), 3000, { render, dueForRefresh: due, manual: true });

    await refresher._tickOnce(); // picks 'broken', renders 504
    await flush();
    assert.ok(refresher._failedUntil().has('broken'), 'broken URL is parked');

    await refresher._tickOnce(); // 'broken' excluded -> picks 'good'
    await flush();
    assert.deepEqual(rendered, ['broken', 'good']); // did NOT crashloop on 'broken'
  });

  it('parks a refresh URL whose render throws', async function () {
    process.env.REFRESHER_CONCURRENCY = '1';
    const due = ({ limit, exclude }) =>
      Promise.resolve(['x'].filter((u) => !exclude.has(u)).slice(0, limit));
    refresher.start(makeServer(0), 3000, {
      render: () => Promise.reject(new Error('boom')),
      dueForRefresh: due,
      manual: true,
    });
    await refresher._tickOnce();
    await flush();
    assert.ok(refresher._failedUntil().has('x'));
  });

  it('does NOT park a URL shed for backpressure (429/503)', async function () {
    process.env.REFRESHER_CONCURRENCY = '1';
    const due = ({ limit, exclude }) =>
      Promise.resolve(['x'].filter((u) => !exclude.has(u)).slice(0, limit));
    refresher.start(makeServer(0), 3000, {
      render: () => Promise.resolve(429),
      dueForRefresh: due,
      manual: true,
    });
    await refresher._tickOnce();
    await flush();
    assert.equal(refresher._failedUntil().has('x'), false);
  });

  it('a successful render clears a prior failure cooldown', async function () {
    process.env.REFRESHER_CONCURRENCY = '2';
    let val = 504;
    let q = ['x'];
    // Drive 'x' through the QUEUE (dequeue ignores the cooldown), so we can fail
    // it then succeed it and observe the cooldown being cleared.
    refresher.start(makeServer(0), 3000, {
      render: () => Promise.resolve(val),
      dequeue: (n) => Promise.resolve(q.slice(0, n)),
      dueForRefresh: () => Promise.resolve([]),
      requeue: () => {},
      clearAttempt: () => {},
      manual: true,
    });
    await refresher._tickOnce(); // queue 'x' -> 504 -> parked
    await flush();
    assert.ok(refresher._failedUntil().has('x'));

    val = 200;
    q = ['x'];
    await refresher._tickOnce(); // queue 'x' -> 200 -> clears parking
    await flush();
    assert.equal(refresher._failedUntil().has('x'), false);
  });

  it('normalizes a render the server flagged as failed (x-prerender-504-reason) to 504', function () {
    const c = refresher._classifyLoopbackStatus;
    // a page-load timeout with TIMEOUT_STATUS_CODE unset comes back 200 + reason
    assert.equal(c(200, { 'x-prerender-504-reason': 'page load timed out' }), 504);
    // already-5xx (TIMEOUT_STATUS_CODE=504 set) passes through unchanged
    assert.equal(c(504, { 'x-prerender-504-reason': 'page load timed out' }), 504);
    // healthy renders and backpressure are untouched
    assert.equal(c(200, {}), 200);
    assert.equal(c(301, {}), 301);
    assert.equal(c(429, {}), 429);
    assert.equal(c(503, {}), 503);
  });

  it('does not park anything when the cooldown is disabled (0)', async function () {
    process.env.REFRESHER_CONCURRENCY = '1';
    process.env.REFRESHER_FAIL_COOLDOWN_MS = '0';
    const due = ({ limit, exclude }) =>
      Promise.resolve(['x'].filter((u) => !exclude.has(u)).slice(0, limit));
    refresher.start(makeServer(0), 3000, {
      render: () => Promise.resolve(504),
      dueForRefresh: due,
      manual: true,
    });
    await refresher._tickOnce();
    await flush();
    assert.equal(refresher._failedUntil().size, 0);
  });
});

describe('refresher adaptive concurrency', function () {
  function startAdaptive(min, max) {
    process.env.REFRESHER_ADAPTIVE = 'true';
    process.env.REFRESHER_MIN_CONCURRENCY = String(min);
    process.env.REFRESHER_CONCURRENCY = String(max);
    // now:()=>0 pins the initial window start; we pass explicit timestamps to _evaluate.
    refresher.start(makeServer(0), 3000, {
      render: () => Promise.resolve(200),
      dueForRefresh: () => Promise.resolve([]),
      now: () => 0,
      manual: true,
    });
  }
  // Run one evaluation window: N completed + M failed renders, then evaluate at `at`.
  function runWindow(at, completed, failed) {
    for (let i = 0; i < completed; i += 1) {
      refresher._recordOutcome({ ok: true, status: 200, latencyMs: 100 });
    }
    for (let i = 0; i < (failed || 0); i += 1) refresher._recordOutcome({ ok: false });
    refresher._evaluate(at);
  }

  afterEach(function () {
    refresher.stop();
    delete process.env.REFRESHER_ADAPTIVE;
    delete process.env.REFRESHER_MIN_CONCURRENCY;
    delete process.env.REFRESHER_CONCURRENCY;
  });

  it('climbs while throughput keeps improving', function () {
    startAdaptive(1, 6);
    assert.equal(refresher._getLimit(), 1);
    runWindow(10000, 5, 0); // 0.5/s > 0 -> climb
    assert.equal(refresher._getLimit(), 2);
    runWindow(20000, 30, 0); // 3.0/s > prev -> climb
    assert.equal(refresher._getLimit(), 3);
  });

  it('halves the limit on a render failure', function () {
    startAdaptive(1, 8);
    runWindow(10000, 10, 0); // -> 2
    runWindow(20000, 30, 0); // -> 3
    runWindow(30000, 50, 0); // -> 4
    assert.equal(refresher._getLimit(), 4);
    runWindow(40000, 5, 2); // failures -> floor(4 * 0.5) = 2
    assert.equal(refresher._getLimit(), 2);
  });

  it('steps back and holds when a higher limit does not improve throughput', function () {
    startAdaptive(1, 6);
    runWindow(10000, 10, 0); // 1.0/s -> climb to 2 (revert target = 1)
    assert.equal(refresher._getLimit(), 2);
    runWindow(20000, 10, 0); // still 1.0/s, no gain -> revert to 1, hold
    assert.equal(refresher._getLimit(), 1);
  });

  it('does not collapse the limit during an idle window', function () {
    startAdaptive(1, 6);
    runWindow(10000, 10, 0); // -> 2
    runWindow(20000, 30, 0); // -> 3
    assert.equal(refresher._getLimit(), 3);
    refresher._evaluate(30000); // no renders this window -> no signal, hold
    assert.equal(refresher._getLimit(), 3);
  });

  it('is a no-op (static limit) when REFRESHER_ADAPTIVE is off', function () {
    process.env.REFRESHER_CONCURRENCY = '5';
    refresher.start(makeServer(0), 3000, {
      render: () => Promise.resolve(200),
      dueForRefresh: () => Promise.resolve([]),
      manual: true,
    });
    assert.equal(refresher._getLimit(), 5);
    refresher._recordOutcome({ ok: false });
    refresher._evaluate(10000);
    assert.equal(refresher._getLimit(), 5); // unchanged
    delete process.env.REFRESHER_CONCURRENCY;
  });

  it('parses usage_usec from a cgroup v2 cpu.stat', function () {
    assert.equal(
      refresher._parseCpuStatV2('usage_usec 123456\nuser_usec 1\nsystem_usec 2\n'),
      123456,
    );
    assert.equal(refresher._parseCpuStatV2('no usage here'), null);
  });

  it('treats a slow render (near timeout) as a backoff signal', function () {
    startAdaptive(1, 8); // slowMs defaults to 0.8 * 20000 = 16000ms
    runWindow(10000, 10, 0); // fast renders (100ms) -> climb to 2
    runWindow(20000, 30, 0); // -> 3
    const before = refresher._getLimit();
    assert.ok(before >= 2);
    refresher._recordOutcome({ ok: true, status: 200, latencyMs: 50000 }); // slow 200
    refresher._evaluate(30000);
    assert.ok(refresher._getLimit() < before); // backed off despite the 200
  });
});
