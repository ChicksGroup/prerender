const assert = require('assert');
const sinon = require('sinon');
const tokenAuth = require('../../lib/plugins/tokenAuth');

describe('tokenAuth plugin', function () {
  let sandbox, req, res, next;
  const ORIGINAL = process.env.PRERENDER_AUTH_TOKEN;

  beforeEach(function () {
    sandbox = sinon.createSandbox();
    req = { headers: {}, prerender: {} };
    res = { send: sandbox.spy() };
    next = sandbox.spy();
  });

  afterEach(function () {
    sandbox.restore();
    if (ORIGINAL === undefined) delete process.env.PRERENDER_AUTH_TOKEN;
    else process.env.PRERENDER_AUTH_TOKEN = ORIGINAL;
  });

  it('passes through when no token is configured', function () {
    delete process.env.PRERENDER_AUTH_TOKEN;
    tokenAuth.requestReceived(req, res, next);
    assert(next.calledOnce);
    assert(res.send.notCalled);
  });

  it('calls next when the token matches', function () {
    process.env.PRERENDER_AUTH_TOKEN = 'secret-123';
    req.headers['x-prerender-token'] = 'secret-123';
    tokenAuth.requestReceived(req, res, next);
    assert(next.calledOnce);
    assert(res.send.notCalled);
  });

  it('sends 403 when the token header is missing', function () {
    process.env.PRERENDER_AUTH_TOKEN = 'secret-123';
    tokenAuth.requestReceived(req, res, next);
    assert(next.notCalled);
    assert(res.send.calledOnceWithExactly(403));
  });

  it('sends 403 when the token is wrong', function () {
    process.env.PRERENDER_AUTH_TOKEN = 'secret-123';
    req.headers['x-prerender-token'] = 'nope';
    tokenAuth.requestReceived(req, res, next);
    assert(next.notCalled);
    assert(res.send.calledOnceWithExactly(403));
  });
});
