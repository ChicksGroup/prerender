const assert = require('assert');
const sinon = require('sinon');
const removeScriptTags = require('../../lib/plugins/removeScriptTags');

describe('removeScriptTags plugin', function () {
  let sandbox, res, next;

  beforeEach(function () {
    sandbox = sinon.createSandbox();
    res = { send: sandbox.spy(), setHeader: sandbox.spy() };
    next = sandbox.spy();
  });

  afterEach(function () {
    sandbox.restore();
  });

  it('removes script tags but preserves application/ld+json (SEO-critical)', function () {
    const ld =
      '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product"}</script>';
    const html =
      '<html><head>' +
      ld +
      '<script src="https://cdn.example.com/app.js"></script>' +
      '<script>window.x = 1;</script>' +
      '</head><body>hi</body></html>';
    const req = { prerender: { content: html, renderType: 'html' } };

    removeScriptTags.pageLoaded(req, res, next);

    const out = req.prerender.content.toString();
    assert(next.calledOnce);
    assert(out.indexOf(ld) > -1, 'JSON-LD block must remain byte-intact');
    assert(out.indexOf('app.js') === -1, 'external script must be removed');
    assert(out.indexOf('window.x = 1') === -1, 'inline script must be removed');
  });

  it('does nothing for non-html render types', function () {
    const req = {
      prerender: { content: Buffer.from('binary'), renderType: 'png' },
    };
    removeScriptTags.pageLoaded(req, res, next);
    assert(next.calledOnce);
  });
});
