const chrome = require('../../lib/browsers/chrome'),
  sinon = require('sinon'),
  assert = require('assert');

describe('chrome', function () {
  describe('_isCriticalSubresource (dirtyRender guard)', function () {
    const SAVED = {};
    const VARS = [
      'ALLOWED_DOMAINS',
      'DIRTY_RENDER_EXTRA_DOMAINS',
      'DIRTY_RENDER_ALL_HOSTS',
    ];
    const PAGE = 'https://chicksgold.com/ACE';

    beforeEach(function () {
      for (const v of VARS) {
        SAVED[v] = process.env[v];
        delete process.env[v];
      }
    });

    afterEach(function () {
      for (const v of VARS) {
        if (SAVED[v] === undefined) delete process.env[v];
        else process.env[v] = SAVED[v];
      }
    });

    it('a third-party 5xx is NOT critical when a whitelist is configured', function () {
      process.env.ALLOWED_DOMAINS = 'chicksgold.com,chicksx.com';
      assert.strictEqual(
        chrome._isCriticalSubresource('https://api.ipify.org/', PAGE),
        false,
      );
    });

    it("the page's own host is always critical", function () {
      process.env.ALLOWED_DOMAINS = 'chicksgold.com';
      assert.strictEqual(
        chrome._isCriticalSubresource('https://chicksgold.com/api/items', PAGE),
        true,
      );
    });

    it('a subdomain of an allowed domain is critical', function () {
      process.env.ALLOWED_DOMAINS = 'chicksgold.com,chicksx.com';
      assert.strictEqual(
        chrome._isCriticalSubresource('https://api.chicksgold.com/v1/x', PAGE),
        true,
      );
    });

    it('a cross-brand allowed domain is critical', function () {
      process.env.ALLOWED_DOMAINS = 'chicksgold.com,chicksx.com';
      assert.strictEqual(
        chrome._isCriticalSubresource('https://api.chicksx.com/rates', PAGE),
        true,
      );
    });

    it('a lookalike domain does NOT match the whitelist', function () {
      process.env.ALLOWED_DOMAINS = 'chicksgold.com';
      assert.strictEqual(
        chrome._isCriticalSubresource('https://evilchicksgold.com/x', PAGE),
        false,
      );
    });

    it('DIRTY_RENDER_EXTRA_DOMAINS extends the critical set', function () {
      process.env.ALLOWED_DOMAINS = 'chicksgold.com';
      process.env.DIRTY_RENDER_EXTRA_DOMAINS = 'stripe.com';
      assert.strictEqual(
        chrome._isCriticalSubresource('https://api.stripe.com/v1/charges', PAGE),
        true,
      );
    });

    it('with no domain lists configured, every 5xx stays critical (legacy)', function () {
      assert.strictEqual(
        chrome._isCriticalSubresource('https://api.ipify.org/', PAGE),
        true,
      );
    });

    it('DIRTY_RENDER_ALL_HOSTS=true forces legacy behavior', function () {
      process.env.ALLOWED_DOMAINS = 'chicksgold.com';
      process.env.DIRTY_RENDER_ALL_HOSTS = 'true';
      assert.strictEqual(
        chrome._isCriticalSubresource('https://api.ipify.org/', PAGE),
        true,
      );
    });

    it('an unparseable subresource URL stays critical (conservative)', function () {
      process.env.ALLOWED_DOMAINS = 'chicksgold.com';
      assert.strictEqual(chrome._isCriticalSubresource('not a url', PAGE), true);
    });
  });

  describe('loadUrlThenWaitForPageLoadEvent', function () {
    let tab;
    let sandbox;

    beforeEach(function () {
      sandbox = sinon.createSandbox();

      tab = sandbox.stub();
      tab.prerender = sandbox.stub();
      tab.prerender.pageDoneCheckInterval = 1000;
      tab.prerender.pageLoadTimeout = 1;

      tab.Page = sandbox.stub();
      tab.Page.enable = sandbox.stub();
      tab.Page.enable.resolves(1);
      tab.Page.addScriptToEvaluateOnNewDocument = sandbox.stub();
      tab.Page.navigate = sandbox.stub();
      tab.Page.navigate.resolves(1);

      tab.Emulation = sandbox.stub();
      tab.Emulation.setDeviceMetricsOverride = sandbox.stub();

      chrome.options = chrome.options || {};
    });

    afterEach(function () {
      sandbox.restore();
    });

    it('Should NOT change tabs status code', async function () {
      const expectedStatusCode = 123;
      tab.prerender.statusCode = expectedStatusCode;

      await chrome.loadUrlThenWaitForPageLoadEvent(tab, 'the-url');

      assert.strictEqual(tab.prerender.statusCode, expectedStatusCode);
    });

    it('Should change tabs status code to the predefined value', async function () {
      const expectedStatusCode = 222;
      tab.prerender.statusCode = 111;
      tab.prerender.timeoutStatusCode = expectedStatusCode;

      await chrome.loadUrlThenWaitForPageLoadEvent(tab, 'the-url');

      assert.strictEqual(tab.prerender.statusCode, expectedStatusCode);
    });
  });
});
