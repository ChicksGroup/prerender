const assert = require('assert');
const sinon = require('sinon');
const clear = require('../../lib/plugins/saasCacheClear');

function makeReq(over) {
  return {
    prerender: Object.assign(
      { url: 'https://www.chicksx.com/', renderType: 'html', statusCode: 200 },
      (over && over.prerender) || {},
    ),
  };
}

describe('saasCacheClear plugin', function () {
  let sandbox, res, next;

  beforeEach(function () {
    sandbox = sinon.createSandbox();
    res = { setHeader: sandbox.spy() };
    next = sandbox.spy();
    clear._reset();
    clear._setConfigForTests({ enabled: true, token: 'tok' });
  });

  afterEach(function () {
    sandbox.restore();
    clear._reset();
  });

  it('enabled() requires both the flag and a token', function () {
    clear._setConfigForTests({ enabled: true, token: '' });
    assert.equal(clear.enabled(), false);
    clear._setConfigForTests({ enabled: false, token: 'x' });
    assert.equal(clear.enabled(), false);
    clear._setConfigForTests({ enabled: true, token: 'x' });
    assert.equal(clear.enabled(), true);
  });

  it('enqueues a fresh, good render', function () {
    clear.beforeSend(makeReq(), res, next);
    assert.equal(clear._queueSize(), 1);
    assert(next.calledOnce);
  });

  it('skips cache hits', function () {
    clear.beforeSend(
      makeReq({ prerender: { _servedFromCache: true } }),
      res,
      next,
    );
    assert.equal(clear._queueSize(), 0);
  });

  it('skips fallback responses', function () {
    clear.beforeSend(
      makeReq({ prerender: { _fromFallback: true } }),
      res,
      next,
    );
    assert.equal(clear._queueSize(), 0);
  });

  it('skips non-cacheable statuses', function () {
    clear.beforeSend(makeReq({ prerender: { statusCode: 500 } }), res, next);
    assert.equal(clear._queueSize(), 0);
  });

  it('is a no-op when disabled', function () {
    clear._setConfigForTests({ enabled: false, token: 'x' });
    clear.beforeSend(makeReq(), res, next);
    assert.equal(clear._queueSize(), 0);
    assert(next.calledOnce);
  });

  it('drainOne POSTs a clear for the URL and polls status on 200', async function () {
    const post = sandbox.stub().resolves(200);
    const status = sandbox.stub().resolves(200);
    clear._setHttpForTests({ post, status });
    clear.enqueue('https://www.chicksx.com/p');
    await clear._drainOne();
    assert(post.calledOnceWith('https://www.chicksx.com/p'));
    assert(status.called);
    assert.equal(clear._queueSize(), 0);
  });

  it('re-queues on 403 (a clear is already in progress)', async function () {
    const post = sandbox.stub().resolves(403);
    const status = sandbox.stub().resolves(200);
    clear._setHttpForTests({ post, status });
    clear.enqueue('https://x/');
    await clear._drainOne();
    assert(post.calledOnce);
    assert(status.notCalled);
    assert.equal(clear._queueSize(), 1); // put back for a later attempt
  });

  it('respects the queue cap (drops overflow)', function () {
    clear._setConfigForTests({ enabled: true, token: 't', maxQueue: 2 });
    clear.enqueue('a');
    clear.enqueue('b');
    clear.enqueue('c');
    assert.equal(clear._queueSize(), 2);
  });
});
