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
