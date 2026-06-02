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
      hset: sandbox.stub().resolves(1),
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

    it('skips the read AND takes no lock on no-store (X-Prerender-No-Store header)', async function () {
      const req = makeReq({ headers: { 'x-prerender-no-store': 'true' } });
      await redisCache.requestReceived(req, res, next);
      assert(client.get.notCalled); // no read
      assert(client.set.notCalled); // no single-flight lock acquired
      assert(next.calledOnce);
      assert.equal(req.prerender._cacheNoStore, true);
      assert.notEqual(req.prerender._cacheBypass, true); // distinct from bypass
    });

    it('skips the read on no-store via the noStore=true query param', async function () {
      const req = makeReq({ query: { noStore: 'true' } });
      await redisCache.requestReceived(req, res, next);
      assert(client.get.notCalled);
      assert(next.calledOnce);
      assert.equal(req.prerender._cacheNoStore, true);
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

    it('caches a 200 without a TTL (plain SET, no PX)', async function () {
      client.set.resolves('OK');
      const req = makeReq({ prerender: { _cacheLockOwner: true } });
      await redisCache.beforeSend(req, res, next);
      assert(client.set.calledOnce);
      const args = client.set.firstCall.args;
      assert.equal(args[0], HTML_KEY);
      assert.equal(args[2], undefined); // no PX -> never expires
    });

    it('caches a 200 with a PX TTL when the policy action is drop', async function () {
      redisCache._setPolicyForTests({
        '2xx': { cache: true, ttlHours: 2, onExpiry: 'drop' },
      });
      client.set.resolves('OK');
      const req = makeReq({ prerender: { _cacheLockOwner: true } });
      await redisCache.beforeSend(req, res, next);
      assert(client.set.calledOnce);
      const args = client.set.firstCall.args;
      assert.equal(args[0], HTML_KEY);
      assert.equal(args[2], 'PX');
      assert.equal(args[3], 2 * 3600000);
    });

    it('caches a 4xx with a PX TTL and records its status', async function () {
      redisCache._setConfigForTests({ error4xxTtlMs: 1000 });
      redisCache._setEnabledForTests(true);
      redisCache._setClientForTests(client);
      client.set.resolves('OK');
      const req = makeReq({
        prerender: {
          _cacheLockOwner: true,
          statusCode: 404,
          content: '<html>not found</html>',
        },
      });
      await redisCache.beforeSend(req, res, next);
      assert(client.set.calledOnce);
      const args = client.set.firstCall.args;
      assert.equal(args[0], HTML_KEY);
      assert.equal(args[2], 'PX'); // 4xx body auto-expires
      assert.equal(args[3], 1000);
      assert(client.hset.calledWith('prerender:v1:status', URL, 404));
    });

    it('caches a 403 too (all 4xx are cacheable now)', async function () {
      client.set.resolves('OK');
      const req = makeReq({
        prerender: {
          _cacheLockOwner: true,
          statusCode: 403,
          content: '<html>denied</html>',
        },
      });
      await redisCache.beforeSend(req, res, next);
      assert(client.set.calledOnce);
    });

    it('does NOT store our transient 408 / 429 signals', async function () {
      for (const code of [408, 429]) {
        client.set.resetHistory();
        const req = makeReq({
          prerender: {
            _cacheLockOwner: true,
            statusCode: code,
            content: '<html>x</html>',
          },
        });
        await redisCache.beforeSend(req, res, next);
        assert(client.set.notCalled, 'should not cache ' + code);
      }
    });

    it('applies the minHtmlBytes guard to 200 only (a small 404 still caches)', async function () {
      redisCache._setConfigForTests({
        minHtmlBytes: 20000,
        error4xxTtlMs: 1000,
      });
      redisCache._setEnabledForTests(true);
      redisCache._setClientForTests(client);
      client.set.resolves('OK');
      const req = makeReq({
        prerender: {
          _cacheLockOwner: true,
          statusCode: 404,
          content: '<html>tiny 404</html>',
        },
      });
      await redisCache.beforeSend(req, res, next);
      assert(client.set.calledOnce); // cached despite being < minHtmlBytes
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

    it('does not write on no-store, even with single-flight disabled', async function () {
      // Without the explicit guard, singleFlight:false makes shouldWrite true.
      redisCache._setConfigForTests({ singleFlight: false });
      client.set.resolves('OK');
      const req = makeReq({ prerender: { _cacheNoStore: true } });
      await redisCache.beforeSend(req, res, next);
      assert(client.set.notCalled); // no body write
      assert(client.zadd.notCalled); // not added to the refresh index
      assert(client.hset.notCalled); // no status entry
      assert(next.calledOnce);
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
    const l = new Map(); // listKey -> array (index 0 = head, LPUSH prepends)
    const sortedAsc = () => [...z.entries()].sort((a, b) => a[1] - b[1]);
    const withScores = (pairs) => pairs.flatMap(([m, s]) => [m, String(s)]);
    return {
      _kv: kv,
      _z: z,
      _h: h,
      _l: l,
      lpush: (key, val) => {
        if (!l.has(key)) l.set(key, []);
        l.get(key).unshift(val);
        return Promise.resolve(l.get(key).length);
      },
      lrange: (key, start, stop) => {
        const a = l.get(key) || [];
        return Promise.resolve(a.slice(start, stop === -1 ? a.length : stop + 1));
      },
      ltrim: (key, start, stop) => {
        if (l.has(key)) {
          const a = l.get(key);
          l.set(key, a.slice(start, stop === -1 ? a.length : stop + 1));
        }
        return Promise.resolve('OK');
      },
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
      get: (k) => Promise.resolve(kv.has(k) ? kv.get(k) : null),
      del: (k) => {
        kv.delete(k);
        return Promise.resolve(1);
      },
      zrem: (key, member) => {
        z.delete(member);
        return Promise.resolve(1);
      },
      hset: (key, field, val) => {
        if (!h.has(key)) h.set(key, new Map());
        h.get(key).set(field, Number(val));
        return Promise.resolve(1);
      },
      hdel: (key, field) => {
        const m = h.get(key);
        if (m) m.delete(field);
        return Promise.resolve(1);
      },
      hmget: (key, ...fields) => {
        const m = h.get(key) || new Map();
        return Promise.resolve(
          fields.map((f) => (m.has(f) ? String(m.get(f)) : null)),
        );
      },
      scan: (cursor, _matchKw, pattern, _countKw, _count) => {
        const pfx = String(pattern).replace(/\*$/, '');
        const keys = [...h.keys()].filter((k) => k.startsWith(pfx));
        return Promise.resolve(['0', keys]);
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

  it('status() reports the per-URL status code', async function () {
    const url = 'https://www.chicksx.com/p';
    client._z.set(url, Date.now());
    await client.hset('prerender:v1:status', url, 301);
    const rows = await redisCache.status([url]);
    assert.equal(rows[0].cached, true);
    assert.equal(rows[0].status, 301);
  });

  it('status() keeps a fresh 4xx cached with its status', async function () {
    const url = 'https://www.chicksx.com/missing';
    client._z.set(url, Date.now()); // fresh (< 24h default TTL)
    await client.hset('prerender:v1:status', url, 404);
    const rows = await redisCache.status([url]);
    assert.equal(rows[0].cached, true);
    assert.equal(rows[0].status, 404);
  });

  it('status() evicts an expired 4xx and reports it uncached', async function () {
    redisCache._setConfigForTests({ error4xxTtlMs: 1000 });
    redisCache._setEnabledForTests(true);
    redisCache._setClientForTests(client);
    const url = 'https://www.chicksx.com/gone';
    client._kv.set('prerender:v1:html:' + url, 'x');
    client._z.set(url, Date.now() - 5000); // older than the 1s TTL
    await client.hset('prerender:v1:status', url, 404);
    const rows = await redisCache.status([url]);
    assert.equal(rows[0].cached, false);
    assert.equal(rows[0].status, null);
    // reaped from every structure
    assert.equal(client._z.has(url), false);
    assert.equal(client._kv.has('prerender:v1:html:' + url), false);
    assert.equal(client._h.get('prerender:v1:status').has(url), false);
  });

  it('status() does NOT evict a fresh 3xx (no TTL)', async function () {
    redisCache._setConfigForTests({ error4xxTtlMs: 1000 });
    redisCache._setEnabledForTests(true);
    redisCache._setClientForTests(client);
    const url = 'https://www.chicksx.com/r';
    client._z.set(url, Date.now() - 5000); // old, but 3xx never expires here
    await client.hset('prerender:v1:status', url, 301);
    const rows = await redisCache.status([url]);
    assert.equal(rows[0].cached, true);
    assert.equal(rows[0].status, 301);
  });

  it('stale() includes the per-URL status', async function () {
    client._z.set('https://a/', 100);
    await client.hset('prerender:v1:status', 'https://a/', 200);
    const rows = await redisCache.stale({ limit: 5 });
    assert.equal(rows[0].status, 200);
  });

  it('dueForRefresh() returns oldest 2xx older than the refresh TTL', async function () {
    const now = Date.now();
    client._z.set('https://a/', now - 2 * 86400e3); // 2d old 2xx -> due
    client._z.set('https://b/', now - 60e3); // fresh 2xx -> not due
    await client.hset('prerender:v1:status', 'https://a/', 200);
    await client.hset('prerender:v1:status', 'https://b/', 200);
    const due = await redisCache.dueForRefresh({
      limit: 10,
      refreshTtlMs: 86400e3,
      redirectTtlMs: 7 * 86400e3,
      now,
    });
    assert.deepEqual(due, ['https://a/']);
  });

  it('dueForRefresh() uses the 7d window for 3xx', async function () {
    const now = Date.now();
    client._z.set('https://r2d/', now - 2 * 86400e3); // 2d old 3xx -> NOT due
    client._z.set('https://r8d/', now - 8 * 86400e3); // 8d old 3xx -> due
    await client.hset('prerender:v1:status', 'https://r2d/', 301);
    await client.hset('prerender:v1:status', 'https://r8d/', 302);
    const due = await redisCache.dueForRefresh({
      limit: 10,
      refreshTtlMs: 86400e3,
      redirectTtlMs: 7 * 86400e3,
      now,
    });
    assert.deepEqual(due, ['https://r8d/']);
  });

  it('dueForRefresh() never returns a 4xx', async function () {
    const now = Date.now();
    client._z.set('https://e/', now - 100 * 86400e3); // ancient 4xx -> still skipped
    await client.hset('prerender:v1:status', 'https://e/', 404);
    const due = await redisCache.dueForRefresh({
      limit: 10,
      refreshTtlMs: 86400e3,
      redirectTtlMs: 7 * 86400e3,
      now,
    });
    assert.deepEqual(due, []);
  });

  it('dueForRefresh() honors the exclude set and the limit (oldest first)', async function () {
    const now = Date.now();
    client._z.set('https://a/', now - 2 * 86400e3);
    client._z.set('https://b/', now - 3 * 86400e3); // older
    await client.hset('prerender:v1:status', 'https://a/', 200);
    await client.hset('prerender:v1:status', 'https://b/', 200);
    const excluded = await redisCache.dueForRefresh({
      limit: 10,
      exclude: new Set(['https://b/']),
      refreshTtlMs: 86400e3,
      redirectTtlMs: 7 * 86400e3,
      now,
    });
    assert.deepEqual(excluded, ['https://a/']);
    const oldestOne = await redisCache.dueForRefresh({
      limit: 1,
      refreshTtlMs: 86400e3,
      redirectTtlMs: 7 * 86400e3,
      now,
    });
    assert.deepEqual(oldestOne, ['https://b/']); // oldest-first
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

  it('list() filters by case-insensitive URL substring (q)', async function () {
    client._z.set('https://www.chicksgold.com/buy', 100);
    client._z.set('https://www.chicksx.com/sell', 200);
    const out = await redisCache.list({ q: 'CHICKSX' });
    assert.equal(out.total, 1);
    assert.equal(out.results[0].url, 'https://www.chicksx.com/sell');
  });

  it('list() filters by exact domain', async function () {
    client._z.set('https://www.chicksgold.com/a', 100);
    client._z.set('https://www.chicksx.com/b', 200);
    const out = await redisCache.list({ domain: 'www.chicksx.com' });
    assert.equal(out.total, 1);
    assert.equal(out.results[0].domain, 'www.chicksx.com');
  });

  it('list() filters by status class and by exact code', async function () {
    const now = Date.now();
    client._z.set('https://s/ok', now);
    client._z.set('https://s/redir', now);
    client._z.set('https://s/missing', now);
    await client.hset('prerender:v1:status', 'https://s/ok', 200);
    await client.hset('prerender:v1:status', 'https://s/redir', 301);
    await client.hset('prerender:v1:status', 'https://s/missing', 404);
    const c4 = await redisCache.list({ status: '4xx' });
    assert.deepEqual(
      c4.results.map((r) => r.url),
      ['https://s/missing'],
    );
    const c3 = await redisCache.list({ status: '3xx' });
    assert.deepEqual(
      c3.results.map((r) => r.url),
      ['https://s/redir'],
    );
    const exact = await redisCache.list({ status: '200' });
    assert.deepEqual(
      exact.results.map((r) => r.url),
      ['https://s/ok'],
    );
  });

  it('list() sorts newest-first by default and paginates with a total', async function () {
    client._z.set('https://p/1', 100);
    client._z.set('https://p/2', 200);
    client._z.set('https://p/3', 300);
    client._z.set('https://p/4', 400);
    client._z.set('https://p/5', 500);
    const page = await redisCache.list({ limit: 2, offset: 0 });
    assert.equal(page.total, 5);
    assert.equal(page.limit, 2);
    assert.deepEqual(
      page.results.map((r) => r.storedAt),
      [500, 400],
    );
    const page2 = await redisCache.list({ limit: 2, offset: 2 });
    assert.deepEqual(
      page2.results.map((r) => r.storedAt),
      [300, 200],
    );
  });

  it('list() sorts by url ascending when asked', async function () {
    client._z.set('https://z/', 100);
    client._z.set('https://a/', 200);
    const out = await redisCache.list({ sort: 'url', dir: 'asc' });
    assert.deepEqual(
      out.results.map((r) => r.url),
      ['https://a/', 'https://z/'],
    );
  });

  it('list() clamps limit to 200', async function () {
    client._z.set('https://a/', 100);
    const out = await redisCache.list({ limit: 9999 });
    assert.equal(out.limit, 200);
  });

  it('list() hides an expired 4xx', async function () {
    redisCache._setConfigForTests({ error4xxTtlMs: 1000 });
    redisCache._setEnabledForTests(true);
    redisCache._setClientForTests(client);
    const now = Date.now();
    client._z.set('https://gone/', now - 5000); // older than the 1s TTL
    client._z.set('https://ok/', now);
    await client.hset('prerender:v1:status', 'https://gone/', 404);
    await client.hset('prerender:v1:status', 'https://ok/', 200);
    const out = await redisCache.list({});
    assert.deepEqual(
      out.results.map((r) => r.url),
      ['https://ok/'],
    );
  });

  it('list() reports null status when none recorded and excludes it from status filters', async function () {
    client._z.set('https://nostatus/', 100);
    const all = await redisCache.list({});
    assert.equal(all.total, 1);
    assert.equal(all.results[0].status, null);
    const filtered = await redisCache.list({ status: '2xx' });
    assert.equal(filtered.total, 0);
  });

  it('list() memoizes the snapshot (one index scan across calls)', async function () {
    client._z.set('https://a/', 100);
    const spy = sandbox.spy(client, 'zrange');
    await redisCache.list({});
    await redisCache.list({ q: 'a' });
    assert.equal(spy.callCount, 1);
  });

  it('list() returns {enabled:false} when cache disabled', async function () {
    redisCache._setEnabledForTests(false);
    const out = await redisCache.list({});
    assert.equal(out.enabled, false);
  });

  it('list() on an empty index returns total 0', async function () {
    const out = await redisCache.list({});
    assert.equal(out.enabled, true);
    assert.equal(out.total, 0);
    assert.deepEqual(out.results, []);
  });

  it('remove() normalizes the URL and evicts body + index + status', async function () {
    const url = 'https://www.chicksx.com/p';
    client._kv.set('prerender:v1:html:' + url, 'x');
    client._z.set(url, Date.now());
    await client.hset('prerender:v1:status', url, 200);
    const out = await redisCache.remove(['/' + url]); // leading slash normalized away
    assert.deepEqual(out, { removed: 1 });
    assert.equal(client._z.has(url), false);
    assert.equal(client._kv.has('prerender:v1:html:' + url), false);
    assert.equal(client._h.get('prerender:v1:status').has(url), false);
  });

  it('remove() deletes multiple URLs and counts each', async function () {
    client._z.set('https://a/', 100);
    client._z.set('https://b/', 200);
    const out = await redisCache.remove(['https://a/', 'https://b/']);
    assert.equal(out.removed, 2);
    assert.equal(client._z.has('https://a/'), false);
    assert.equal(client._z.has('https://b/'), false);
  });

  it('remove() skips empty/malformed URLs without throwing', async function () {
    const out = await redisCache.remove(['', null]);
    assert.equal(out.removed, 0);
  });

  it('remove() invalidates the list + stats memos', async function () {
    client._z.set('https://a/', 100);
    client._z.set('https://b/', 200);
    await redisCache.list({}); // prime list memo
    await redisCache.statsByDomain(); // prime stats memo
    await redisCache.remove(['https://a/']);
    const spy = sandbox.spy(client, 'zrange');
    const out = await redisCache.list({});
    assert.equal(spy.callCount, 1); // memo invalidated -> fresh scan
    assert.deepEqual(
      out.results.map((r) => r.url),
      ['https://b/'],
    );
    const stats = await redisCache.statsByDomain();
    assert.equal(stats.global.count, 1);
  });

  it('getPolicy() returns historical defaults when nothing is stored', async function () {
    const p = await redisCache.getPolicy();
    assert.equal(p.enabled, true);
    assert.equal(p.policy['2xx'].ttlHours, 24);
    assert.equal(p.policy['2xx'].onExpiry, 'refresh');
    assert.equal(p.policy['2xx'].custom, false);
    assert.equal(p.policy['3xx'].ttlHours, 168);
    assert.equal(p.policy['3xx'].onExpiry, 'refresh');
    assert.equal(p.policy['4xx'].ttlHours, 24);
    assert.equal(p.policy['4xx'].onExpiry, 'drop');
  });

  it('setPolicy() validates, persists, and getPolicy() reflects it', async function () {
    const r = await redisCache.setPolicy({
      '2xx': { cache: true, ttlHours: 48, onExpiry: 'refresh' },
      '3xx': { cache: true, ttlHours: 12, onExpiry: 'drop' },
      '4xx': { cache: false },
    });
    assert.equal(r.policy['2xx'].ttlHours, 48);
    assert.equal(r.policy['2xx'].custom, true);
    assert.equal(r.policy['3xx'].onExpiry, 'drop');
    assert.equal(r.policy['4xx'].cache, false);
    assert.ok(client._kv.has('prerender:v1:policy'));
    const stored = JSON.parse(client._kv.get('prerender:v1:policy'));
    assert.equal(stored.classes['4xx'].cache, false);
    const g = await redisCache.getPolicy();
    assert.equal(g.policy['2xx'].ttlHours, 48);
    assert.equal(g.policy['4xx'].cache, false);
  });

  it('setPolicy() rejects non-positive or absurd TTLs', async function () {
    await assert.rejects(
      () => redisCache.setPolicy({ '2xx': { cache: true, ttlHours: 0 } }),
      /positive/,
    );
    await assert.rejects(
      () => redisCache.setPolicy({ '2xx': { cache: true, ttlHours: 999999 } }),
      /too large/,
    );
  });

  it('beforeSend skips a class the policy marks no-cache', async function () {
    redisCache._setPolicyForTests({ '4xx': { cache: false } });
    const req = makeReq({
      prerender: {
        _cacheLockOwner: true,
        statusCode: 404,
        content: '<html>nf</html>',
      },
    });
    await redisCache.beforeSend(req, res, next);
    const htmlKeys = [...client._kv.keys()].filter((k) =>
      k.startsWith('prerender:v1:html:'),
    );
    assert.equal(htmlKeys.length, 0);
  });

  it('dueForRefresh honors a policy 2xx refresh interval', async function () {
    const HOUR = 3600000;
    redisCache._setPolicyForTests({
      '2xx': { cache: true, ttlHours: 1, onExpiry: 'refresh' },
    });
    const now = Date.now();
    client._z.set('https://x/a', now - 2 * HOUR);
    client._z.set('https://x/b', now - 30 * 60 * 1000);
    await client.hset('prerender:v1:status', 'https://x/a', 200);
    await client.hset('prerender:v1:status', 'https://x/b', 200);
    const due = await redisCache.dueForRefresh({ limit: 10, now });
    assert.deepEqual(due, ['https://x/a']);
  });

  it('dueForRefresh refreshes a 4xx when the policy sets its action to refresh', async function () {
    const HOUR = 3600000;
    redisCache._setPolicyForTests({
      '4xx': { cache: true, ttlHours: 1, onExpiry: 'refresh' },
    });
    const now = Date.now();
    client._z.set('https://x/nf', now - 2 * HOUR);
    await client.hset('prerender:v1:status', 'https://x/nf', 404);
    const due = await redisCache.dueForRefresh({ limit: 10, now });
    assert.deepEqual(due, ['https://x/nf']);
  });

  it('dueForRefresh skips a 2xx whose policy action is drop', async function () {
    const HOUR = 3600000;
    redisCache._setPolicyForTests({
      '2xx': { cache: true, ttlHours: 1, onExpiry: 'drop' },
    });
    const now = Date.now();
    client._z.set('https://x/a', now - 5 * HOUR);
    await client.hset('prerender:v1:status', 'https://x/a', 200);
    const due = await redisCache.dueForRefresh({ limit: 10, now });
    assert.deepEqual(due, []);
  });

  it('status() evicts a 2xx the policy marks drop past its TTL', async function () {
    redisCache._setPolicyForTests({
      '2xx': { cache: true, ttlHours: 0.001, onExpiry: 'drop' },
    });
    const url = 'https://x/old';
    client._kv.set('prerender:v1:html:' + url, 'x');
    client._z.set(url, Date.now() - 60 * 1000);
    await client.hset('prerender:v1:status', url, 200);
    const rows = await redisCache.status([url]);
    assert.equal(rows[0].cached, false);
    assert.equal(client._z.has(url), false);
  });

  it('status() evicts a leftover entry whose class is now no-cache', async function () {
    redisCache._setPolicyForTests({ '4xx': { cache: false } });
    const url = 'https://x/nf';
    client._kv.set('prerender:v1:html:' + url, 'x');
    client._z.set(url, Date.now());
    await client.hset('prerender:v1:status', url, 404);
    const rows = await redisCache.status([url]);
    assert.equal(rows[0].cached, false);
    assert.equal(client._z.has(url), false);
  });

  it('status() keeps a 4xx the policy marks keep (never expires on read)', async function () {
    redisCache._setPolicyForTests({
      '4xx': { cache: true, ttlHours: 0.001, onExpiry: 'keep' },
    });
    const url = 'https://x/nf';
    client._z.set(url, Date.now() - 60 * 1000);
    await client.hset('prerender:v1:status', url, 404);
    const rows = await redisCache.status([url]);
    assert.equal(rows[0].cached, true);
    assert.equal(rows[0].status, 404);
  });

  it('setPolicy persists URL rules ({classes,rules}) and getPolicy returns them', async function () {
    const r = await redisCache.setPolicy({
      '2xx': { cache: true, ttlHours: 24, onExpiry: 'refresh' },
      rules: [
        { pattern: '/sell/', ttlHours: 2, onExpiry: 'drop', cache: true },
      ],
    });
    assert.equal(r.rules.length, 1);
    assert.equal(r.rules[0].pattern, '/sell/');
    assert.equal(r.rules[0].ttlHours, 2);
    assert.equal(r.rules[0].onExpiry, 'drop');
    assert.ok(r.rules[0].id);
    const stored = JSON.parse(client._kv.get('prerender:v1:policy'));
    assert.ok(stored.classes && stored.classes['2xx']);
    assert.equal(stored.rules.length, 1);
    const g = await redisCache.getPolicy();
    assert.equal(g.rules[0].pattern, '/sell/');
  });

  it('setPolicy rejects an invalid regex, dup pattern, and >50 rules', async function () {
    await assert.rejects(
      () => redisCache.setPolicy({ rules: [{ pattern: '(', ttlHours: 1 }] }),
      /invalid regex/,
    );
    await assert.rejects(
      () =>
        redisCache.setPolicy({
          rules: [
            { pattern: '/x/', ttlHours: 1 },
            { pattern: '/x/', ttlHours: 2 },
          ],
        }),
      /duplicate/,
    );
    const many = [];
    for (let i = 0; i < 51; i += 1)
      many.push({ pattern: '/p' + i + '/', ttlHours: 1 });
    await assert.rejects(
      () => redisCache.setPolicy({ rules: many }),
      /too many rules/,
    );
  });

  it('setPolicy rejects two rules that match a cached URL with different settings', async function () {
    client._z.set('https://x/sell/btc', Date.now());
    await assert.rejects(
      () =>
        redisCache.setPolicy({
          rules: [
            { pattern: '/sell/', ttlHours: 2, onExpiry: 'drop', cache: true },
            { pattern: 'btc', ttlHours: 5, onExpiry: 'refresh', cache: true },
          ],
        }),
      /conflicts with/,
    );
  });

  it('setPolicy allows overlapping rules with identical settings', async function () {
    client._z.set('https://x/sell/btc', Date.now());
    const r = await redisCache.setPolicy({
      rules: [
        { pattern: '/sell/', ttlHours: 2, onExpiry: 'drop', cache: true },
        { pattern: 'btc', ttlHours: 2, onExpiry: 'drop', cache: true },
      ],
    });
    assert.equal(r.rules.length, 2);
  });

  it('a no-cache URL rule overrides the class (beforeSend skips the write)', async function () {
    redisCache._setRulesForTests([{ pattern: '/admin/', cache: false }]);
    const req = makeReq({
      prerender: {
        _cacheLockOwner: true,
        url: 'https://x/admin/panel',
        statusCode: 200,
        content: '<html>a</html>',
      },
    });
    await redisCache.beforeSend(req, res, next);
    const htmlKeys = [...client._kv.keys()].filter((k) =>
      k.startsWith('prerender:v1:html:'),
    );
    assert.equal(htmlKeys.length, 0);
  });

  it('a drop URL rule overrides a 2xx (status evicts past the rule TTL)', async function () {
    redisCache._setRulesForTests([
      { pattern: '/tmp/', cache: true, ttlHours: 0.001, onExpiry: 'drop' },
    ]);
    const url = 'https://x/tmp/p';
    client._kv.set('prerender:v1:html:' + url, 'x');
    client._z.set(url, Date.now() - 60 * 1000);
    await client.hset('prerender:v1:status', url, 200);
    const rows = await redisCache.status([url]);
    assert.equal(rows[0].cached, false);
    assert.equal(client._z.has(url), false);
  });

  it('dueForRefresh uses a rule refresh interval and skips drop rules', async function () {
    const HOUR = 3600000;
    redisCache._setRulesForTests([
      { pattern: '/r/', cache: true, ttlHours: 1, onExpiry: 'refresh' },
      { pattern: '/d/', cache: true, ttlHours: 1, onExpiry: 'drop' },
    ]);
    const now = Date.now();
    client._z.set('https://x/r/a', now - 2 * HOUR);
    client._z.set('https://x/d/a', now - 2 * HOUR);
    await client.hset('prerender:v1:status', 'https://x/r/a', 200);
    await client.hset('prerender:v1:status', 'https://x/d/a', 200);
    const due = await redisCache.dueForRefresh({ limit: 10, now });
    assert.deepEqual(due, ['https://x/r/a']);
  });

  it('previewPattern returns total/matched/sample and rejects a bad regex', async function () {
    client._z.set('https://x/sell/a', 100);
    client._z.set('https://x/sell/b', 200);
    client._z.set('https://x/buy/c', 300);
    const p = await redisCache.previewPattern({ pattern: '/sell/' });
    assert.equal(p.total, 3);
    assert.equal(p.matched, 2);
    assert.equal(p.sample.length, 2);
    assert.equal(p.sample[0].url, 'https://x/sell/b'); // newest first
    assert.deepEqual(p.conflictsWith, []);
    await assert.rejects(
      () => redisCache.previewPattern({ pattern: '(' }),
      /invalid regex/,
    );
  });

  it('getPolicy reads the legacy bare-class policy shape (back-compat)', async function () {
    client._kv.set(
      'prerender:v1:policy',
      JSON.stringify({ '4xx': { cache: false } }),
    );
    const g = await redisCache.getPolicy();
    assert.equal(g.policy['4xx'].cache, false);
    assert.equal(g.policy['4xx'].custom, true);
    assert.deepEqual(g.rules, []);
    assert.deepEqual(g.noRenderRules, []);
  });

  it('setPolicy persists noRenderRules and getPolicy returns them', async function () {
    const r = await redisCache.setPolicy({
      noRenderRules: [{ pattern: '/admin/', statusCode: 410 }],
    });
    assert.equal(r.noRenderRules.length, 1);
    assert.equal(r.noRenderRules[0].pattern, '/admin/');
    assert.equal(r.noRenderRules[0].statusCode, 410);
    assert.ok(r.noRenderRules[0].id);
    const stored = JSON.parse(client._kv.get('prerender:v1:policy'));
    assert.equal(stored.noRenderRules.length, 1);
    assert.equal(stored.noRenderRules[0].statusCode, 410);
    const g = await redisCache.getPolicy();
    assert.equal(g.noRenderRules[0].pattern, '/admin/');
  });

  it('setPolicy rejects a bad no-render regex, dup, >50, and a disallowed statusCode', async function () {
    await assert.rejects(
      () =>
        redisCache.setPolicy({
          noRenderRules: [{ pattern: '(', statusCode: 410 }],
        }),
      /invalid no-render regex/,
    );
    await assert.rejects(
      () =>
        redisCache.setPolicy({
          noRenderRules: [
            { pattern: '/x/', statusCode: 410 },
            { pattern: '/x/', statusCode: 404 },
          ],
        }),
      /duplicate no-render/,
    );
    const many = [];
    for (let i = 0; i < 51; i += 1)
      many.push({ pattern: '/p' + i + '/', statusCode: 410 });
    await assert.rejects(
      () => redisCache.setPolicy({ noRenderRules: many }),
      /too many no-render rules/,
    );
    await assert.rejects(
      () =>
        redisCache.setPolicy({
          noRenderRules: [{ pattern: '/x/', statusCode: 500 }],
        }),
      /statusCode/,
    );
    await assert.rejects(
      () => redisCache.setPolicy({ noRenderRules: [{ pattern: '/x/' }] }),
      /statusCode/,
    );
  });

  it('a no-render rule short-circuits requestReceived with the status + empty body', async function () {
    redisCache._setNoRenderRulesForTests([
      { pattern: '/admin/', statusCode: 410 },
    ]);
    const req = makeReq({ prerender: { url: 'https://x/admin/panel' } });
    await redisCache.requestReceived(req, res, next);
    assert(res.send.calledOnce);
    assert.equal(res.send.firstCall.args[0], 410);
    assert.equal(res.send.firstCall.args[1], '');
    assert(next.notCalled); // never proceeds to render
    assert.equal(req.prerender._noRender, true);
  });

  it('a no-render rule wins over a cache hit (cached body is never served)', async function () {
    const url = 'https://x/admin/panel';
    client._kv.set('prerender:v1:html:' + url, entryJson({ body: '<html>cached</html>' }));
    client._z.set(url, Date.now());
    redisCache._setNoRenderRulesForTests([
      { pattern: '/admin/', statusCode: 404 },
    ]);
    const req = makeReq({ prerender: { url } });
    await redisCache.requestReceived(req, res, next);
    assert.equal(res.send.firstCall.args[0], 404);
    assert.equal(res.send.firstCall.args[1], ''); // not the cached HTML
  });

  it('beforeSend writes nothing for a no-render short-circuit (even with single-flight off)', async function () {
    // Single-flight off + cacheable 200 + no min-bytes gate => shouldWrite would be
    // true, so this locks in the `if (p._noRender) return next();` guard as the only
    // thing preventing the write.
    redisCache._setConfigForTests({ singleFlight: false, minHtmlBytes: 0 });
    redisCache._setEnabledForTests(true);
    redisCache._setClientForTests(client);
    redisCache._setNoRenderRulesForTests([
      { pattern: '/admin/', statusCode: 410 },
    ]);
    const req = makeReq({
      prerender: {
        _noRender: true,
        url: 'https://x/admin/p',
        statusCode: 200,
        content: '<html><head></head><body>hi</body></html>',
      },
    });
    await redisCache.beforeSend(req, res, next);
    assert(next.calledOnce);
    const htmlKeys = [...client._kv.keys()].filter((k) =>
      k.startsWith('prerender:v1:html:'),
    );
    assert.equal(htmlKeys.length, 0);
  });

  it('removeMatching({pattern}) bulk-deletes only URLs the regex matches', async function () {
    const now = Date.now();
    client._z.set('https://x/admin/a', now);
    client._z.set('https://x/admin/b', now);
    client._z.set('https://x/ok', now);
    const out = await redisCache.removeMatching({ pattern: '/admin/' });
    assert.equal(out.matched, 2);
    await new Promise((r) => setTimeout(r, 20)); // drain background eviction
    assert.equal(client._z.has('https://x/admin/a'), false);
    assert.equal(client._z.has('https://x/admin/b'), false);
    assert.equal(client._z.has('https://x/ok'), true); // non-match kept
  });

  it('flush({cache:true}) invalidates the list memo so the next list() rescans', async function () {
    client._z.set('https://a/', 100);
    await redisCache.list({}); // prime the list memo
    await redisCache.flush({ cache: true });
    const spy = sandbox.spy(client, 'zrange');
    await redisCache.list({});
    assert.equal(spy.callCount, 1); // memo dropped -> fresh index scan
  });

  it('removeMatching() bulk-deletes entries of a status class (kept others)', async function () {
    const now = Date.now();
    client._z.set('https://x/ok', now);
    client._z.set('https://x/r1', now);
    client._z.set('https://x/r2', now);
    await client.hset('prerender:v1:status', 'https://x/ok', 200);
    await client.hset('prerender:v1:status', 'https://x/r1', 301);
    await client.hset('prerender:v1:status', 'https://x/r2', 302);
    const out = await redisCache.removeMatching({ status: '3xx' });
    assert.deepEqual(out, { matched: 2, started: true });
    await new Promise((r) => setTimeout(r, 20)); // drain background eviction
    assert.equal(client._z.has('https://x/ok'), true); // 2xx kept
    assert.equal(client._z.has('https://x/r1'), false); // 3xx gone
    assert.equal(client._z.has('https://x/r2'), false);
  });

  it('removeMatching() bulk-deletes a domain', async function () {
    const now = Date.now();
    client._z.set('https://www.chicksx.com/a', now);
    client._z.set('https://www.chicksgold.com/b', now);
    const out = await redisCache.removeMatching({ domain: 'www.chicksx.com' });
    assert.equal(out.matched, 1);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(client._z.has('https://www.chicksx.com/a'), false);
    assert.equal(client._z.has('https://www.chicksgold.com/b'), true);
  });

  it('removeMatching() bulk-deletes a search term', async function () {
    client._z.set('https://x/sell/bitcoin', 100);
    client._z.set('https://x/buy/bitcoin', 200);
    const out = await redisCache.removeMatching({ q: 'sell' });
    assert.equal(out.matched, 1);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(client._z.has('https://x/sell/bitcoin'), false);
    assert.equal(client._z.has('https://x/buy/bitcoin'), true);
  });

  it('removeMatching() rejects with NO_FILTER when no filter is set', async function () {
    client._z.set('https://x/a', 100);
    await assert.rejects(
      () => redisCache.removeMatching({ q: '', status: '', domain: '' }),
      (e) => e.code === 'NO_FILTER',
    );
    assert.equal(client._z.has('https://x/a'), true); // nothing removed
  });

  it('removeMatching() rejects when cache disabled', async function () {
    redisCache._setEnabledForTests(false);
    await assert.rejects(() => redisCache.removeMatching({ status: '2xx' }));
  });

  it('remove() rejects when cache disabled', async function () {
    redisCache._setEnabledForTests(false);
    await assert.rejects(() => redisCache.remove(['https://x/']));
  });

  it('releaseLockForRequest releases the lock for the owner under single-flight', async function () {
    redisCache._setConfigForTests({ singleFlight: true });
    redisCache._setEnabledForTests(true);
    redisCache._setClientForTests(client);
    const evalSpy = sandbox.spy(client, 'eval');
    const req = {
      prerender: { _cacheLockOwner: true, renderId: 'rid-9', url: 'https://x/p' },
    };
    await redisCache.releaseLockForRequest(req);
    assert(evalSpy.calledOnce);
    assert.equal(evalSpy.firstCall.args[3], 'rid-9'); // compare-and-del on our renderId
    assert(String(evalSpy.firstCall.args[2]).indexOf(':lock:') > -1);
  });

  it('releaseLockForRequest is a no-op when this request is not the lock owner', async function () {
    redisCache._setConfigForTests({ singleFlight: true });
    redisCache._setEnabledForTests(true);
    redisCache._setClientForTests(client);
    const evalSpy = sandbox.spy(client, 'eval');
    await redisCache.releaseLockForRequest({
      prerender: { _cacheLockOwner: false, url: 'https://x/p' },
    });
    assert(evalSpy.notCalled);
  });

  it('releaseLockForRequest is a no-op when single-flight is off', async function () {
    redisCache._setConfigForTests({ singleFlight: false });
    redisCache._setEnabledForTests(true);
    redisCache._setClientForTests(client);
    const evalSpy = sandbox.spy(client, 'eval');
    await redisCache.releaseLockForRequest({
      prerender: { _cacheLockOwner: true, renderId: 'r', url: 'https://x/p' },
    });
    assert(evalSpy.notCalled);
  });

  it('recordFallbackEvent logs served + failed; fallbackEvents returns them newest-first', async function () {
    await redisCache.recordFallbackEvent({ url: 'https://x/a', trigger: 429, outcome: 'failed', reason: 'saas_429' });
    await redisCache.recordFallbackEvent({ url: 'https://x/b', trigger: 504, outcome: 'served', status: 200 });
    const r = await redisCache.fallbackEvents({ limit: 10 });
    assert.equal(r.enabled, true);
    assert.equal(r.events.length, 2);
    // newest first (LPUSH): the served event
    assert.equal(r.events[0].url, 'https://x/b');
    assert.equal(r.events[0].outcome, 'served');
    assert.equal(r.events[0].status, 200);
    assert.equal(r.events[0].reason, null);
    assert.equal(r.events[0].trigger, 504);
    assert.equal(r.events[0].host, 'x');
    assert.ok(r.events[0].id && r.events[0].at);
    // the failed event
    assert.equal(r.events[1].outcome, 'failed');
    assert.equal(r.events[1].reason, 'saas_429');
    assert.equal(r.events[1].status, null);
  });

  it('recordFallbackEvent caps the ring buffer at fallbackLogMax (oldest dropped)', async function () {
    redisCache._setConfigForTests({ fallbackLogMax: 3 });
    redisCache._setEnabledForTests(true);
    redisCache._setClientForTests(client);
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await redisCache.recordFallbackEvent({ url: 'https://x/' + i, trigger: 500, outcome: 'failed', reason: 'saas_5xx' });
    }
    const r = await redisCache.fallbackEvents({ limit: 100 });
    assert.equal(r.events.length, 3);
    assert.equal(r.events[0].url, 'https://x/4'); // newest kept
    assert.equal(r.events[2].url, 'https://x/2'); // 0 and 1 trimmed
  });

  it('fallbackEvents returns {enabled:false} when disabled', async function () {
    redisCache._setEnabledForTests(false);
    const r = await redisCache.fallbackEvents({ limit: 10 });
    assert.equal(r.enabled, false);
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

  it('caches an empty-body 3xx redirect that carries a Location (self-heal)', async function () {
    const req = makeReq({
      prerender: {
        _cacheLockOwner: true,
        url: 'https://x/redir',
        statusCode: 301,
        content: '', // a redirect legitimately has no body
        headers: { location: 'https://x/new' },
      },
    });
    await redisCache.beforeSend(req, res, next);
    const htmlKeys = [...client._kv.keys()].filter((k) =>
      k.startsWith('prerender:v1:html:'),
    );
    assert.equal(htmlKeys.length, 1); // stored despite the empty body
    assert.equal(client._z.size, 1); // indexed
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

  it('statsByDomain() breaks the cache down by status code (global + per-domain)', async function () {
    const now = Date.now();
    client._z.set('https://www.chicksx.com/a', now);
    client._z.set('https://www.chicksx.com/b', now);
    client._z.set('https://www.chicksx.com/r', now);
    client._z.set('https://www.chicksgold.com/missing', now);
    await client.hset('prerender:v1:status', 'https://www.chicksx.com/a', 200);
    await client.hset('prerender:v1:status', 'https://www.chicksx.com/b', 200);
    await client.hset('prerender:v1:status', 'https://www.chicksx.com/r', 301);
    await client.hset(
      'prerender:v1:status',
      'https://www.chicksgold.com/missing',
      404,
    );
    const s = await redisCache.statsByDomain();
    assert.deepEqual(s.global.statusCounts, { 200: 2, 301: 1, 404: 1 });
    const cx = s.domains.find((d) => d.domain === 'www.chicksx.com');
    assert.deepEqual(cx.statusCounts, { 200: 2, 301: 1 });
  });

  it('statsByDomain() omits entries with no recorded status from statusCounts', async function () {
    client._z.set('https://www.chicksx.com/nostatus', Date.now());
    const s = await redisCache.statsByDomain();
    assert.equal(s.global.count, 1);
    assert.deepEqual(s.global.statusCounts, {});
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

  it('incrMetric() accumulates duration sums (render_ms / cache_ms) for averages', async function () {
    await redisCache.incrMetric('renders', 'https://www.chicksx.com/a');
    await redisCache.incrMetric('render_ms', 'https://www.chicksx.com/a', 900);
    await redisCache.incrMetric('renders', 'https://www.chicksx.com/a');
    await redisCache.incrMetric('render_ms', 'https://www.chicksx.com/a', 1100);
    await redisCache.incrMetric('cache_hits', 'https://www.chicksx.com/a');
    await redisCache.incrMetric('cache_ms', 'https://www.chicksx.com/a', 7);
    const m = await redisCache.metrics();
    assert.equal(m.global.renders, 2);
    assert.equal(m.global.render_ms, 2000); // -> avg 1000ms over 2 renders
    assert.equal(m.global.cache_hits, 1);
    assert.equal(m.global.cache_ms, 7);
    const x = m.domains.find((d) => d.domain === 'www.chicksx.com');
    assert.equal(x.render_ms, 2000);
    assert.equal(x.cache_ms, 7);
  });

  it('metrics() returns { enabled:false } when disabled', async function () {
    redisCache._setEnabledForTests(false);
    const m = await redisCache.metrics();
    assert.equal(m.enabled, false);
  });

  it('metricsAllLabels() aggregates every label HASH via SCAN', async function () {
    redisCache._setConfigForTests({ metricsLabel: 'ondemand' });
    redisCache._setEnabledForTests(true);
    redisCache._setClientForTests(client);
    await redisCache.incrMetric('renders', 'https://www.chicksgold.com/a');
    // switch the active label and write more
    redisCache._setConfigForTests({ metricsLabel: 'scheduled' });
    redisCache._setEnabledForTests(true);
    redisCache._setClientForTests(client);
    await redisCache.incrMetric('renders', 'https://www.chicksgold.com/b');
    await redisCache.incrMetric('renders', 'https://www.chicksgold.com/c');

    const m = await redisCache.metricsAllLabels();
    assert.equal(m.enabled, true);
    assert.equal(m.labels.ondemand.global.renders, 1);
    assert.equal(m.labels.scheduled.global.renders, 2);
    assert.equal(m.labels.scheduled.domains[0].domain, 'www.chicksgold.com');
  });

  it('metricsAllLabels() returns { enabled:false } when disabled', async function () {
    redisCache._setEnabledForTests(false);
    const m = await redisCache.metricsAllLabels();
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
      del: (key) => {
        m.delete(key);
        return Promise.resolve();
      },
    };
  }

  beforeEach(function () {
    sandbox = sinon.createSandbox();
    client = {
      set: sandbox.stub().resolves('OK'), // single-flight lock acquire
      eval: sandbox.stub().resolves(1), // lock release
      zadd: sandbox.stub().resolves(1), // index
      zscore: sandbox.stub().resolves(null),
      hset: sandbox.stub().resolves(1), // per-URL status
      zrem: sandbox.stub().resolves(1), // eviction
      hdel: sandbox.stub().resolves(1), // eviction
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

  it('reaps a stale 4xx body on read (lazy eviction)', async function () {
    redisCache._setConfigForTests({
      store: 'spaces',
      compression: true,
      error4xxTtlMs: 1000,
    });
    redisCache._setEnabledForTests(true);
    redisCache._setClientForTests(client);
    redisCache._setObjectStoreForTests(store);

    const wreq = makeReq({
      prerender: {
        _cacheLockOwner: true,
        statusCode: 404,
        content: '<html>404</html>',
      },
    });
    await redisCache.beforeSend(wreq, res, next);
    const key = [...store._m.keys()][0];
    // Backdate the stored timestamp beyond the TTL.
    store._m.get(key).meta.storedat = String(Date.now() - 5000);

    const rreq = makeReq();
    await redisCache.requestReceived(rreq, res, next);
    await new Promise((r) => setImmediate(r)); // flush the fire-and-forget evict

    assert(res.send.notCalled); // expired -> treated as a miss
    assert.equal(rreq.prerender._cacheLockOwner, true);
    assert.equal(store._m.has(key), false); // body deleted
    assert(client.zrem.called); // index entry removed
  });
});

describe('redisCache work queue', function () {
  let sandbox, client;

  // Minimal fake tuned for the queue ops: a single ZSET + an attempts HASH.
  function makeQueueRedis() {
    const z = new Map(); // member -> score
    const h = new Map(); // attempt field -> count
    return {
      _z: z,
      _h: h,
      // zadd(key, 'NX', score, member)  OR  zadd(key, score, member)
      zadd: (key, a, b, c) => {
        if (a === 'NX') {
          if (z.has(c)) return Promise.resolve(0);
          z.set(c, Number(b));
          return Promise.resolve(1);
        }
        z.set(b, Number(a));
        return Promise.resolve(1);
      },
      zpopmin: (key, count) => {
        const sorted = [...z.entries()]
          .sort((x, y) => x[1] - y[1])
          .slice(0, count);
        const out = [];
        for (const [m, s] of sorted) {
          out.push(m, String(s));
          z.delete(m);
        }
        return Promise.resolve(out);
      },
      zcard: () => Promise.resolve(z.size),
      hincrby: (key, field, n) => {
        h.set(field, (h.get(field) || 0) + Number(n));
        return Promise.resolve(h.get(field));
      },
      hdel: (key, field) => {
        h.delete(field);
        return Promise.resolve(1);
      },
    };
  }

  beforeEach(function () {
    sandbox = sinon.createSandbox();
    client = makeQueueRedis();
    redisCache._reset();
    redisCache._setConfigForTests({ queueMaxAttempts: 2 });
    redisCache._setEnabledForTests(true);
    redisCache._setClientForTests(client);
  });

  afterEach(function () {
    sandbox.restore();
    redisCache._reset();
  });

  it('enqueue adds new urls (NX dedups), dequeue pops by priority', async function () {
    assert.equal(
      await redisCache.enqueue(['https://x/a', 'https://x/b'], 1),
      2,
    );
    assert.equal(await redisCache.enqueue(['https://x/a'], 1), 0); // duplicate -> skipped
    assert.equal(await redisCache.enqueue(['https://x/c'], 0), 1); // higher priority
    assert.equal(await redisCache.queueDepth(), 3);
    assert.deepEqual(await redisCache.dequeue(1), ['https://x/c']); // P0 before P1
    assert.deepEqual((await redisCache.dequeue(10)).sort(), [
      'https://x/a',
      'https://x/b',
    ]);
    assert.equal(await redisCache.queueDepth(), 0);
  });

  it('requeue re-adds until queueMaxAttempts, then drops', async function () {
    assert.equal(await redisCache.requeue('https://x/a'), true); // attempt 1 < 2
    assert.equal(await redisCache.queueDepth(), 1);
    await redisCache.dequeue(1);
    assert.equal(await redisCache.requeue('https://x/a'), false); // attempt 2 >= 2 -> dropped
    assert.equal(await redisCache.queueDepth(), 0);
  });

  it('clearAttempt resets the retry counter', async function () {
    await redisCache.requeue('https://x/a'); // attempt 1
    await redisCache.clearAttempt('https://x/a');
    assert.equal(await redisCache.requeue('https://x/a'), true); // counted from 0 again
  });

  it('queue ops are a no-op when the cache is disabled', async function () {
    redisCache._setEnabledForTests(false);
    assert.equal(await redisCache.enqueue(['https://x/a'], 0), 0);
    assert.deepEqual(await redisCache.dequeue(5), []);
    assert.equal(await redisCache.queueDepth(), 0);
  });
});

describe('redisCache flush (admin reset)', function () {
  let sandbox, client, store;

  // SCAN returns a single page per pattern, then cursor '0'.
  const scanPages = {
    'prerender:v1:html:*': [
      'prerender:v1:html:a',
      'prerender:v1:html:b',
      'prerender:v1:html:c',
    ],
    'prerender:v1:lock:*': ['prerender:v1:lock:a'],
    'prerender:v1:metrics:*': [
      'prerender:v1:metrics:ondemand',
      'prerender:v1:metrics:scheduled',
    ],
  };

  function makeFlushRedis() {
    return {
      scan: (cursor, _m, pattern) =>
        Promise.resolve(['0', scanPages[pattern] || []]),
      del: sandbox.stub().resolves(1),
      unlink: sandbox.stub().resolves(1),
    };
  }
  function makeStore() {
    return { deleteAllUnderPrefix: sandbox.stub().resolves(42) };
  }

  beforeEach(function () {
    sandbox = sinon.createSandbox();
    client = makeFlushRedis();
    store = makeStore();
    redisCache._reset();
    redisCache._setEnabledForTests(true);
    redisCache._setClientForTests(client);
  });

  afterEach(function () {
    sandbox.restore();
    redisCache._reset();
  });

  it('cache scope on Spaces deletes bodies via the object store + structural keys', async function () {
    redisCache._setConfigForTests({ store: 'spaces' });
    redisCache._setEnabledForTests(true);
    redisCache._setClientForTests(client);
    redisCache._setObjectStoreForTests(store);

    const r = await redisCache.flush({ cache: true });
    assert.equal(r.store, 'spaces');
    assert.equal(r.bodies, 42); // from objectStore.deleteAllUnderPrefix
    assert(store.deleteAllUnderPrefix.calledWith('v1/html/')); // prefix '' + v1/html/
    // 4 structural DELs (index/status/queue/attempts) + 1 scanned lock key
    assert.equal(r.structuralKeys, 5);
    assert.equal(r.metricsLabels, 0); // metrics untouched
  });

  it('cache scope on the Redis store deletes html keys via SCAN', async function () {
    redisCache._setConfigForTests({ store: 'redis' });
    redisCache._setEnabledForTests(true);
    redisCache._setClientForTests(client);

    const r = await redisCache.flush({ cache: true });
    assert.equal(r.store, 'redis');
    assert.equal(r.bodies, 3); // 3 html keys from SCAN
    assert.equal(r.structuralKeys, 5);
  });

  it('metrics scope clears every per-label metrics HASH only', async function () {
    redisCache._setConfigForTests({ store: 'spaces' });
    redisCache._setEnabledForTests(true);
    redisCache._setClientForTests(client);
    redisCache._setObjectStoreForTests(store);

    const r = await redisCache.flush({ metrics: true });
    assert.equal(r.metricsLabels, 2);
    assert.equal(r.bodies, 0); // cache untouched
    assert.equal(r.structuralKeys, 0);
    assert(store.deleteAllUnderPrefix.notCalled);
  });

  it('throws when the cache is disabled', async function () {
    redisCache._setEnabledForTests(false);
    await assert.rejects(
      () => redisCache.flush({ cache: true }),
      /cache disabled/,
    );
  });
});
