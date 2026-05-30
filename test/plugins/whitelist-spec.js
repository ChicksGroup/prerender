const assert = require('assert');
const sinon = require('sinon');
const whitelist = require('../../lib/plugins/whitelist');

describe('whitelist plugin', function () {
  let sandbox, res, next;
  const ORIGINAL = process.env.ALLOWED_DOMAINS;

  function makeReq(u) {
    return { prerender: { url: u } };
  }

  beforeEach(function () {
    sandbox = sinon.createSandbox();
    res = { send: sandbox.spy() };
    next = sandbox.spy();
  });

  afterEach(function () {
    sandbox.restore();
    if (ORIGINAL === undefined) delete process.env.ALLOWED_DOMAINS;
    else process.env.ALLOWED_DOMAINS = ORIGINAL;
  });

  it('allows a whitelisted host', function () {
    process.env.ALLOWED_DOMAINS = 'www.chicksgold.com,chicksgold.com';
    whitelist.init();
    whitelist.requestReceived(
      makeReq('https://www.chicksgold.com/some/page'),
      res,
      next,
    );
    assert(next.calledOnce);
    assert(res.send.notCalled);
  });

  it('404s a non-whitelisted host', function () {
    process.env.ALLOWED_DOMAINS = 'www.chicksgold.com';
    whitelist.init();
    whitelist.requestReceived(makeReq('https://www.google.com/'), res, next);
    assert(next.notCalled);
    assert(res.send.calledOnceWithExactly(404));
  });

  it('404s the apex when only www is listed (host match is exact)', function () {
    process.env.ALLOWED_DOMAINS = 'www.chicksgold.com';
    whitelist.init();
    whitelist.requestReceived(makeReq('https://chicksgold.com/'), res, next);
    assert(next.notCalled);
    assert(res.send.calledOnceWithExactly(404));
  });
});
