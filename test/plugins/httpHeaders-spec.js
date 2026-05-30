const assert = require('assert');
const sinon = require('sinon');
const httpHeaders = require('../../lib/plugins/httpHeaders');

describe('httpHeaders plugin', function () {
  let sandbox, res, next;

  function makeReq(content) {
    return { prerender: { content, renderType: 'html' } };
  }

  beforeEach(function () {
    sandbox = sinon.createSandbox();
    res = { send: sandbox.spy(), setHeader: sandbox.spy() };
    next = sandbox.spy();
  });

  afterEach(function () {
    sandbox.restore();
  });

  it('passes a normal 200 page through untouched', function () {
    const req = makeReq('<html><head></head><body>hi</body></html>');
    httpHeaders.pageLoaded(req, res, next);
    assert(next.calledOnce);
    assert(res.send.notCalled);
  });

  it('returns the meta status code and strips the meta tag', function () {
    const req = makeReq(
      '<html><head><meta name="prerender-status-code" content="404"></head><body>nope</body></html>',
    );
    httpHeaders.pageLoaded(req, res, next);
    assert(next.notCalled);
    assert(res.send.calledOnce);
    const [code, body] = res.send.firstCall.args;
    assert.equal(code, '404');
    assert(
      body.indexOf('prerender-status-code') === -1,
      'meta tag should be stripped from body',
    );
  });

  it('sets Location and returns 301 for a redirect meta pair', function () {
    const req = makeReq(
      '<html><head>' +
        '<meta name="prerender-status-code" content="301">' +
        '<meta name="prerender-header" content="Location: https://www.chicksgold.com/new">' +
        '</head><body></body></html>',
    );
    httpHeaders.pageLoaded(req, res, next);
    assert(
      res.setHeader.calledWith('Location', 'https://www.chicksgold.com/new'),
    );
    assert(res.send.calledOnce);
    assert.equal(res.send.firstCall.args[0], '301');
  });

  it('he-decodes header entities', function () {
    const req = makeReq(
      '<html><head>' +
        '<meta name="prerender-status-code" content="301">' +
        '<meta name="prerender-header" content="Location: https://x.com/?a=1&amp;b=2">' +
        '</head><body></body></html>',
    );
    httpHeaders.pageLoaded(req, res, next);
    assert(res.setHeader.calledWith('Location', 'https://x.com/?a=1&b=2'));
  });
});
