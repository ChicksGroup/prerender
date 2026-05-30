const assert = require('assert');
const sinon = require('sinon');
const zlib = require('zlib');
const redisCache = require('../../lib/plugins/redisCache');

const URL = 'http://www.chicksgold.com/page?x=1';
const HTML_KEY = 'prerender:v1:html:' + URL;
const LOCK_KEY = 'prerender:v1:lock:' + URL;

function makeReq(over) {
  const base = {
    query: {},
    headers: {},
    prerender: {
      url: URL,
      renderType: 'html',
      statusCode: 200,
      content: '<html><head></head><body>hi</body></html>',
      headers: {},
      renderId: 'rid-1',
      start: new Date(),
      tab: { prerender: {} },
    },
  };
  if (over && over.prerender) {
    base.prerender = Object.assign(base.prerender, over.prerender);
    delete over.prerender;
  }
  return Object.assign(base, over || {});
}

function entryJson(over) {
  return JSON.stringify(
    Object.assign(
      {
        v: 1,
        statusCode: 200,
        headers: { 'content-type': 'text/html' },
        compressed: false,
        body: '<html>cached</html>',
      },
      over || {},
    ),
  );
}

describe('redisCache plugin', function () {
  let sandbox, client, res, next;

  beforeEach(function () {
    sandbox = sinon.createSandbox();
    client = {
      get: sandbox.stub(),
      set: sandbox.stub(),
      eval: sandbox.stub().resolves(1),
      zadd: sandbox.stub().resolves(1),
    };
    res = { send: sandbox.spy(), setHeader: sandbox.spy() };
    next = sandbox.spy();
    redisCache._reset();
    redisCache._setConfigForTests();
    redisCache._setEnabledForTests(true);
    redisCache._setClientForTests(client);
  });

  afterEach(function () {
    sandbox.restore();
    redisCache._reset();
  });

  describe('disabled', function () {
    it('is a no-op when not enabled', async function () {
      redisCache._setEnabledForTests(false);
      const req = makeReq();
      await redisCache.requestReceived(req, res, next);
      redisCache.beforeSend(req, res, next);
      assert(next.calledTwice);
      assert(client.get.notCalled);
      assert(client.set.notCalled);
    });
  });

  describe('read', function () {
    it('serves from cache on a hit and short-circuits', async function () {
      client.get.resolves(entryJson());
      const req = makeReq();
      await redisCache.requestReceived(req, res, next);

      assert(res.send.calledOnce);
      assert.equal(res.send.firstCall.args[0], 200);
      assert.equal(res.send.firstCall.args[1], '<html>cached</html>');
      assert(res.setHeader.calledWith('X-Prerender-Cache', 'HIT'));
      assert(next.notCalled);
      assert.equal(req.prerender._servedFromCache, true);
    });

    it('acquires the single-flight lock on a miss and renders through', async function () {
      client.get.resolves(null);
      client.set.resolves('OK'); // SET NX -> acquired
      const req = makeReq();
      await redisCache.requestReceived(req, res, next);

      assert(next.calledOnce);
      assert(res.send.notCalled);
      assert.equal(req.prerender._cacheLockOwner, true);
      const args = client.set.firstCall.args;
      assert.equal(args[0], LOCK_KEY);
      assert.equal(args[2], 'PX');
      assert.equal(args[4], 'NX');
    });

    it('waits for the entry when another renderer holds the lock', async function () {
      client.set.resolves(null); // NX failed -> not acquired
      client.get.onCall(0).resolves(null); // initial read: miss
      client.get.onCall(1).resolves(entryJson({ body: '<html>w</html>' })); // poll: hit
      const req = makeReq();
      await redisCache.requestReceived(req, res, next);

      assert(res.send.calledOnce);
      assert.equal(res.send.firstCall.args[1], '<html>w</html>');
      assert(res.setHeader.calledWith('X-Prerender-Cache', 'HIT-WAIT'));
      assert(next.notCalled);
    });

    it('renders through (no write) when the wait times out', async function () {
      redisCache._setConfigForTests({ waitMaxMs: 60, waitPollMs: 20 });
      client.set.resolves(null); // not acquired
      client.get.resolves(null); // entry never appears
      const req = makeReq();
      await redisCache.requestReceived(req, res, next);

      assert(next.calledOnce);
      assert(res.send.notCalled);
      assert.equal(req.prerender._cacheLockOwner, false);
    });

    it('degrades to live render when redis GET errors', async function () {
      client.get.rejects(new Error('redis down'));
      const req = makeReq();
      await redisCache.requestReceived(req, res, next);
      assert(next.calledOnce);
      assert(res.send.notCalled);
    });

    it('skips the cache read on bypass', async function () {
      const req = makeReq({ query: { bypassCache: 'true' } });
      await redisCache.requestReceived(req, res, next);
      assert(client.get.notCalled);
      assert(next.calledOnce);
      assert.equal(req.prerender._cacheBypass, true);
    });
  });

  describe('write', function () {
    it('stores a cacheable 200 and releases the lock', async function () {
      client.set.resolves('OK');
      const req = makeReq({ prerender: { _cacheLockOwner: true } });
      await redisCache.beforeSend(req, res, next);

      assert(client.set.calledOnce);
      assert.equal(client.set.firstCall.args[0], HTML_KEY);
      assert(client.eval.calledOnce); // lock released via Lua
      assert(next.calledOnce);
    });

    it('round-trips status + Location header for a 301', async function () {
      client.set.resolves('OK');
      const req = makeReq({
        prerender: {
          _cacheLockOwner: true,
          statusCode: 301,
          content: '<html></html>',
          headers: { Location: 'https://www.chicksgold.com/new' },
        },
      });
      await redisCache.beforeSend(req, res, next);

      assert(client.set.calledOnce);
      const stored = JSON.parse(client.set.firstCall.args[1]);
      assert.equal(stored.statusCode, 301);
      assert.equal(stored.headers.location, 'https://www.chicksgold.com/new');
    });

    it('does NOT store a timed-out render', async function () {
      const req = makeReq({
        prerender: {
          _cacheLockOwner: true,
          tab: { prerender: { timedout: true } },
        },
      });
      await redisCache.beforeSend(req, res, next);
      assert(client.set.notCalled);
      assert(next.calledOnce);
    });

    it('does NOT store a dirty render (5xx subresource)', async function () {
      const req = makeReq({
        prerender: {
          _cacheLockOwner: true,
          tab: { prerender: { dirtyRender: true } },
        },
      });
      await redisCache.beforeSend(req, res, next);
      assert(client.set.notCalled);
    });

    it('does NOT store a 5xx status', async function () {
      const req = makeReq({
        prerender: { _cacheLockOwner: true, statusCode: 504 },
      });
      await redisCache.beforeSend(req, res, next);
      assert(client.set.notCalled);
    });

    it('does NOT store empty content', async function () {
      const req = makeReq({
        prerender: { _cacheLockOwner: true, content: '' },
      });
      await redisCache.beforeSend(req, res, next);
      assert(client.set.notCalled);
    });

    it('overwrites on bypass even without lock ownership', async function () {
      client.set.resolves('OK');
      const req = makeReq({ prerender: { _cacheBypass: true } });
      await redisCache.beforeSend(req, res, next);
      assert(client.set.calledOnce);
      assert.equal(client.set.firstCall.args[0], HTML_KEY);
    });

    it('does not write when served from cache', async function () {
      const req = makeReq({ prerender: { _servedFromCache: true } });
      await redisCache.beforeSend(req, res, next);
      assert(client.set.notCalled);
      assert(next.calledOnce);
    });

    it('degrades when redis SET errors', async function () {
      client.set.rejects(new Error('redis down'));
      const req = makeReq({ prerender: { _cacheLockOwner: true } });
      await redisCache.beforeSend(req, res, next);
      assert(next.calledOnce); // no throw
    });
  });

  describe('serialization', function () {
    it('round-trips with compression on', async function () {
      redisCache._setConfigForTests({ compression: true });
      client.set.resolves('OK');
      const html = '<html><body>' + 'x'.repeat(5000) + '</body></html>';
      const req = makeReq({
        prerender: { _cacheLockOwner: true, content: html },
      });
      await redisCache.beforeSend(req, res, next);

      const stored = JSON.parse(client.set.firstCall.args[1]);
      assert.equal(stored.compressed, true);
      const body = zlib
        .gunzipSync(Buffer.from(stored.body, 'base64'))
        .toString('utf8');
      assert.equal(body, html);
    });

    it('uses the URL verbatim (incl. query string) in the key', async function () {
      client.get.resolves(null);
      client.set.resolves('OK');
      const req = makeReq();
      await redisCache.requestReceived(req, res, next);
      assert.equal(client.set.firstCall.args[0], LOCK_KEY);
    });
  });
});

describe('redisCache introspection & guards', function () {
  let sandbox, client, res, next;

  function makeFakeRedis() {
    const kv = new Map();
    const z = new Map(); // member -> score
    const h = new Map(); // hashKey -> Map(field -> number)
    const sortedAsc = () => [...z.entries()].sort((a, b) => a[1] - b[1]);
    const withScores = (pairs) => pairs.flatMap(([m, s]) => [m, String(s)]);
    return {
      _kv: kv,
      _z: z,
      _h: h,
      hincrby: (key, field, n) => {
        if (!h.has(key)) h.set(key, new Map());
        const m = h.get(key);
        m.set(field, (m.get(field) || 0) + Number(n));
        return Promise.resolve(m.get(field));
      },
      hgetall: (key) => {
        const m = h.get(key) || new Map();
        const o = {};
        for (const [f, v] of m) o[f] = String(v);
        return Promise.resolve(o);
      },
      exists: (k) => Promise.resolve(kv.has(k) ? 1 : 0),
      set: (k, v) => {
        kv.set(k, v);
        return Promise.resolve('OK');
      },
      zadd: (key, score, member) => {
        z.set(member, Number(score));
        return Promise.resolve(1);
      },
      zscore: (key, member) =>
        Promise.resolve(z.has(member) ? String(z.get(member)) : null),
      zcard: () => Promise.resolve(z.size),
      zrange: (key, start, stop, ws) => {
        const arr = sortedAsc();
        const slice = arr.slice(start, stop === -1 ? arr.length : stop + 1);
        return Promise.resolve(ws ? withScores(slice) : slice.map(([m]) => m));
      },
      zrevrange: (key, start, stop, ws) => {
        const arr = sortedAsc().reverse();
        const slice = arr.slice(start, stop === -1 ? arr.length : stop + 1);
        return Promise.resolve(ws ? withScores(slice) : slice.map(([m]) => m));
      },
      zrangebyscore: (key, min, max, ws, limitKw, offset, count) => {
        const minN = min === '-inf' ? -Infinity : Number(min);
        const maxN = max === '+inf' ? Infinity : Number(max);
        let arr = sortedAsc().filter(([, s]) => s >= minN && s <= maxN);
        if (limitKw === 'LIMIT') arr = arr.slice(offset, offset + count);
        return Promise.resolve(ws ? withScores(arr) : arr.map(([m]) => m));
      },
      eval: () => Promise.resolve(1),
    };
  }

  beforeEach(function () {
    sandbox = sinon.createSandbox();
    client = makeFakeRedis();
    res = { send: sandbox.spy(), setHeader: sandbox.spy() };
    next = sandbox.spy();
    redisCache._reset();
    redisCache._setConfigForTests();
    redisCache._setEnabledForTests(true);
    redisCache._setClientForTests(client);
  });

  afterEach(function () {
    sandbox.restore();
    redisCache._reset();
  });

  it('status() reports cached + storedAt for known/unknown URLs', async function () {
    const url = 'https://www.chicksx.com/';
    client._kv.set('prerender:v1:html:' + url, 'x');
    client._z.set(url, 1700000000000);
    const rows = await redisCache.status([
      url,
      'https://www.chicksx.com/missing',
    ]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].cached, true);
    assert.equal(rows[0].storedAt, 1700000000000);
    assert.equal(rows[1].cached, false);
    assert.equal(rows[1].storedAt, null);
  });

  it('stale() returns oldest entries first', async function () {
    client._z.set('https://a/', 100);
    client._z.set('https://b/', 300);
    client._z.set('https://c/', 200);
    const rows = await redisCache.stale({ limit: 2 });
    assert.deepEqual(
      rows.map((r) => r.url),
      ['https://a/', 'https://c/'],
    );
    assert.equal(rows[0].storedAt, 100);
  });

  it('stale() with olderThanMs filters out fresh entries', async function () {
    const now = Date.now();
    client._z.set('https://old/', now - 48 * 3600 * 1000);
    client._z.set('https://fresh/', now - 60 * 1000);
    const rows = await redisCache.stale({
      limit: 10,
      olderThanMs: 24 * 3600 * 1000,
    });
    assert.deepEqual(
      rows.map((r) => r.url),
      ['https://old/'],
    );
  });

  it('stats() reports count + oldest/newest', async function () {
    client._z.set('https://a/', 100);
    client._z.set('https://b/', 300);
    const s = await redisCache.stats();
    assert.equal(s.enabled, true);
    assert.equal(s.count, 2);
    assert.equal(s.oldestStoredAt, 100);
    assert.equal(s.newestStoredAt, 300);
  });

  it('status() rejects when cache disabled', async function () {
    redisCache._setEnabledForTests(false);
    await assert.rejects(() => redisCache.status(['https://x/']));
  });

  it('does NOT cache a 200 smaller than CACHE_MIN_HTML_BYTES', async function () {
    redisCache._setConfigForTests({ minHtmlBytes: 20000 });
    const req = makeReq({
      prerender: { _cacheLockOwner: true, content: '<html>tiny</html>' },
    });
    await redisCache.beforeSend(req, res, next);
    assert.equal(client._kv.size, 0); // nothing stored
    assert(next.calledOnce);
  });

  it('caches a 200 at/above CACHE_MIN_HTML_BYTES and indexes it', async function () {
    redisCache._setConfigForTests({ minHtmlBytes: 100 });
    const big = '<html><body>' + 'x'.repeat(500) + '</body></html>';
    const req = makeReq({ prerender: { _cacheLockOwner: true, content: big } });
    await redisCache.beforeSend(req, res, next);
    assert.equal(client._kv.size, 1); // html stored
    assert.equal(client._z.size, 1); // indexed for refresh
  });

  it('statsByDomain() returns { enabled:false } when disabled', async function () {
    redisCache._setEnabledForTests(false);
    const s = await redisCache.statsByDomain();
    assert.equal(s.enabled, false);
  });

  it('statsByDomain() aggregates per-domain count/buckets, sorted desc', async function () {
    const now = Date.now();
    client._z.set('https://www.chicksgold.com/a', now - 30 * 60 * 1000); // <1h
    client._z.set('https://www.chicksgold.com/b', now - 5 * 3600 * 1000); // 1-24h
    client._z.set('https://www.chicksx.com/c', now - 10 * 24 * 3600 * 1000); // 7-30d
    const s = await redisCache.statsByDomain();
    assert.equal(s.enabled, true);
    assert.equal(s.global.count, 3);
    assert.equal(s.domainCount, 2);
    assert.equal(s.domains[0].count >= s.domains[1].count, true); // sorted desc
    const cg = s.domains.find((d) => d.domain === 'www.chicksgold.com');
    assert.equal(cg.count, 2);
    assert.equal(cg.buckets['<1h'], 1);
    assert.equal(cg.buckets['1-24h'], 1);
    assert.equal(typeof s.computedAt, 'number');
  });

  it('statsByDomain() memoizes within TTL (single ZRANGE)', async function () {
    redisCache._setConfigForTests({ statsCacheTtlMs: 60000 });
    redisCache._setEnabledForTests(true);
    redisCache._setClientForTests(client);
    const spy = sandbox.spy(client, 'zrange');
    client._z.set('https://a/x', Date.now());
    await redisCache.statsByDomain();
    await redisCache.statsByDomain();
    assert.equal(spy.callCount, 1); // second served from memo
  });

  it('statsByDomain() buckets unparseable members under "unknown"', async function () {
    client._z.set('not a url', Date.now());
    const s = await redisCache.statsByDomain();
    assert.ok(s.domains.find((d) => d.domain === 'unknown'));
  });

  it('incrMetric()/metrics() round-trip per-domain (global = sum of domains)', async function () {
    await redisCache.incrMetric('renders', 'https://www.chicksx.com/a');
    await redisCache.incrMetric('renders', 'https://www.chicksx.com/b');
    await redisCache.incrMetric(
      'fallback_render',
      'https://www.chicksgold.com/c',
    );
    const m = await redisCache.metrics();
    assert.equal(m.enabled, true);
    assert.equal(m.global.renders, 2);
    assert.equal(m.global.fallback_render, 1);
    const x = m.domains.find((d) => d.domain === 'www.chicksx.com');
    assert.equal(x.renders, 2);
    const g = m.domains.find((d) => d.domain === 'www.chicksgold.com');
    assert.equal(g.fallback_render, 1);
  });

  it('metrics() returns { enabled:false } when disabled', async function () {
    redisCache._setEnabledForTests(false);
    const m = await redisCache.metrics();
    assert.equal(m.enabled, false);
  });
});

describe('redisCache spaces store (CACHE_STORE=spaces)', function () {
  let sandbox, client, store, res, next;

  function makeStore() {
    const m = new Map();
    return {
      _m: m,
      put: (key, buffer, meta) => {
        m.set(key, { body: Buffer.from(buffer), meta });
        return Promise.resolve();
      },
      get: (key) => Promise.resolve(m.has(key) ? m.get(key) : null),
    };
  }

  beforeEach(function () {
    sandbox = sinon.createSandbox();
    client = {
      set: sandbox.stub().resolves('OK'), // single-flight lock acquire
      eval: sandbox.stub().resolves(1), // lock release
      zadd: sandbox.stub().resolves(1), // index
      zscore: sandbox.stub().resolves(null),
    };
    store = makeStore();
    res = { send: sandbox.spy(), setHeader: sandbox.spy() };
    next = sandbox.spy();
    redisCache._reset();
    redisCache._setConfigForTests({ store: 'spaces', compression: true });
    redisCache._setEnabledForTests(true);
    redisCache._setClientForTests(client);
    redisCache._setObjectStoreForTests(store);
  });

  afterEach(function () {
    sandbox.restore();
    redisCache._reset();
  });

  it('writes the body to the object store (not redis) and indexes it', async function () {
    const big = '<html><body>' + 'y'.repeat(500) + '</body></html>';
    const req = makeReq({
      prerender: { _cacheLockOwner: true, content: big, headers: {} },
    });
    await redisCache.beforeSend(req, res, next);
    assert.equal(store._m.size, 1); // body in Spaces
    assert(client.set.notCalled); // body NOT written to Redis
    assert(client.zadd.calledOnce); // indexed for refresh
    assert(next.calledOnce);
  });

  it('round-trips a body through the object store on a hit', async function () {
    const html = '<html><body>hello-spaces</body></html>';
    const wreq = makeReq({
      prerender: {
        _cacheLockOwner: true,
        content: html,
        headers: { 'content-type': 'text/html' },
      },
    });
    await redisCache.beforeSend(wreq, res, next);

    const rreq = makeReq();
    await redisCache.requestReceived(rreq, res, next);
    assert(res.send.called);
    assert.equal(res.send.lastCall.args[0], 200);
    assert.equal(res.send.lastCall.args[1], html);
    assert(res.setHeader.calledWith('X-Prerender-Cache', 'HIT'));
  });

  it('301 round-trips Location via object metadata', async function () {
    const wreq = makeReq({
      prerender: {
        _cacheLockOwner: true,
        statusCode: 301,
        content: '<html></html>',
        headers: { Location: 'https://www.chicksgold.com/new' },
      },
    });
    await redisCache.beforeSend(wreq, res, next);

    const rreq = makeReq();
    await redisCache.requestReceived(rreq, res, next);
    assert.equal(rreq.prerender.statusCode, 301);
    assert.equal(
      rreq.prerender.headers.location,
      'https://www.chicksgold.com/new',
    );
  });

  it('miss falls through to render (acquires lock) when the store is empty', async function () {
    const req = makeReq();
    await redisCache.requestReceived(req, res, next);
    assert(next.calledOnce);
    assert(res.send.notCalled);
    assert.equal(req.prerender._cacheLockOwner, true);
  });
});
