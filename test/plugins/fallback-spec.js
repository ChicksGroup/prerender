const assert = require('assert');
const sinon = require('sinon');
const fallback = require('../../lib/plugins/fallback');

function makeReq(over) {
  const p = Object.assign(
    {
      url: 'https://www.chicksx.com/',
      renderType: 'html',
      statusCode: 504,
      content: 'err',
      headers: {},
    },
    (over && over.prerender) || {},
  );
  return { prerender: p, server: { options: { renderErrorStatusCode: 504 } } };
}

describe('fallback plugin', function () {
  let sandbox, res, next;

  beforeEach(function () {
    sandbox = sinon.createSandbox();
    res = { setHeader: sandbox.spy(), send: sandbox.spy() };
    next = sandbox.spy();
    fallback._reset();
    fallback._setConfigForTests({ enabled: true, token: 'tok' });
  });

  afterEach(function () {
    sandbox.restore();
    fallback._reset();
  });

  it('enabled() requires both the flag and a token', function () {
    fallback._setConfigForTests({ enabled: true, token: '' });
    assert.equal(fallback.enabled(), false);
    fallback._setConfigForTests({ enabled: false, token: 'x' });
    assert.equal(fallback.enabled(), false);
    fallback._setConfigForTests({ enabled: true, token: 'x' });
    assert.equal(fallback.enabled(), true);
  });

  it('replaces a failed render with the fallback result and flags it for caching', async function () {
    fallback._setFetchForTests(() =>
      Promise.resolve({
        statusCode: 200,
        headers: { 'content-type': 'text/html' },
        content: '<html>saas</html>',
      }),
    );
    const req = makeReq({ prerender: { statusCode: 504 } });
    await fallback.beforeSend(req, res, next);
    assert.equal(req.prerender.statusCode, 200);
    assert.equal(req.prerender.content, '<html>saas</html>');
    assert.equal(req.prerender._cacheBypass, true);
    assert.equal(req.prerender._fromFallback, true);
    assert(res.setHeader.calledWith('X-Prerender-Fallback', 'prerender.io'));
    assert(next.calledOnce);
  });

  it('does nothing for a successful (200) render', async function () {
    let fetched = false;
    fallback._setFetchForTests(() => {
      fetched = true;
      return Promise.resolve(null);
    });
    const req = makeReq({
      prerender: { statusCode: 200, content: '<html>ok</html>' },
    });
    await fallback.beforeSend(req, res, next);
    assert.equal(fetched, false);
    assert.equal(req.prerender.content, '<html>ok</html>');
    assert(next.calledOnce);
  });

  it('only triggers for configured status codes (404 does not)', async function () {
    let fetched = false;
    fallback._setFetchForTests(() => {
      fetched = true;
      return Promise.resolve(null);
    });
    const req = makeReq({ prerender: { statusCode: 404 } });
    await fallback.beforeSend(req, res, next);
    assert.equal(fetched, false);
    assert(next.calledOnce);
  });

  it('skips when already served from fallback', async function () {
    let fetched = false;
    fallback._setFetchForTests(() => {
      fetched = true;
      return Promise.resolve(null);
    });
    const req = makeReq({
      prerender: { statusCode: 504, _fromFallback: true },
    });
    await fallback.beforeSend(req, res, next);
    assert.equal(fetched, false);
    assert(next.calledOnce);
  });

  it('leaves the original error when the fallback also fails', async function () {
    fallback._setFetchForTests(() => Promise.resolve(null));
    const req = makeReq({ prerender: { statusCode: 504, content: 'err' } });
    await fallback.beforeSend(req, res, next);
    assert.equal(req.prerender.statusCode, 504);
    assert.equal(req.prerender.content, 'err');
    assert(next.calledOnce);
  });

  it('is a no-op when disabled', async function () {
    fallback._setConfigForTests({ enabled: false, token: 'x' });
    let fetched = false;
    fallback._setFetchForTests(() => {
      fetched = true;
      return Promise.resolve(null);
    });
    const req = makeReq({ prerender: { statusCode: 504 } });
    await fallback.beforeSend(req, res, next);
    assert.equal(fetched, false);
    assert(next.calledOnce);
  });
});

describe('server.serveFromFallback (capacity path)', function () {
  const server = require('../../lib/server');
  let sandbox, res;

  beforeEach(function () {
    sandbox = sinon.createSandbox();
    res = { setHeader: sandbox.spy(), sendStatus: sandbox.spy() };
    server.options = server.options || {};
    server.options.overloadRetryAfter = '2';
    fallback._reset();
    fallback._setConfigForTests({ enabled: true, token: 't' });
  });

  afterEach(function () {
    sandbox.restore();
    fallback._reset();
  });

  it('applies the fallback result and calls finish() on success', async function () {
    fallback._setFetchForTests(() =>
      Promise.resolve({
        statusCode: 200,
        headers: {},
        content: '<html>saas</html>',
      }),
    );
    const finishStub = sandbox.stub(server, 'finish');
    const req = { prerender: { url: 'https://x/', renderType: 'html' } };
    await server.serveFromFallback(req, res, 429);
    assert.equal(req.prerender.content, '<html>saas</html>');
    assert.equal(req.prerender._fromFallback, true);
    assert(finishStub.calledOnce);
  });

  it('returns the attempted status when the fallback fails', async function () {
    fallback._setFetchForTests(() => Promise.resolve(null));
    const req = { prerender: { url: 'https://x/' } };
    await server.serveFromFallback(req, res, 429);
    assert(res.sendStatus.calledWith(429));
  });
});
