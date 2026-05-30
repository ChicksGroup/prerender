const assert = require('assert');
const sinon = require('sinon');
const whitelist = require('../../lib/plugins/whitelist');

describe('whitelist plugin', function () {
  let sandbox, res, next;
  const ORIGINAL = process.env.ALLOWED_DOMAINS;

  function makeReq(u) {
    return { prerender: { url: u } };
  }

  function check(allowedDomains, targetUrl) {
    process.env.ALLOWED_DOMAINS = allowedDomains;
    whitelist.init();
    whitelist.requestReceived(makeReq(targetUrl), res, next);
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

  it('allows an exact host match', function () {
    check('www.chicksgold.com,chicksgold.com', 'https://www.chicksgold.com/page');
    assert(next.calledOnce);
    assert(res.send.notCalled);
  });

  it('allows subdomains of a base domain', function () {
    check('chicksx.com', 'https://www.chicksx.com/buy');
    check('chicksx.com', 'https://api.chicksx.com/');
    check('chicksx.com', 'https://chicksx.com/'); // base itself
    assert.strictEqual(next.callCount, 3);
    assert(res.send.notCalled);
  });

  it('404s a non-whitelisted host', function () {
    check('chicksx.com', 'https://www.google.com/');
    assert(next.notCalled);
    assert(res.send.calledOnceWithExactly(404));
  });

  it('404s lookalike / suffix-attack domains', function () {
    check('chicksx.com', 'https://evilchicksx.com/'); // not a subdomain
    check('chicksx.com', 'https://chicksx.com.attacker.com/'); // suffix attack
    assert(next.notCalled);
    assert.strictEqual(res.send.callCount, 2);
    assert(res.send.alwaysCalledWithExactly(404));
  });

  it('404s the parent domain when only a subdomain is listed', function () {
    check('www.chicksgold.com', 'https://chicksgold.com/');
    assert(next.notCalled);
    assert(res.send.calledOnceWithExactly(404));
  });

  it('trims whitespace in the domain list', function () {
    check('chicksgold.com, chicksx.com', 'https://www.chicksx.com/');
    assert(next.calledOnce);
    assert(res.send.notCalled);
  });
});
