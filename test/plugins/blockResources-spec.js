const assert = require('assert');
const blockResources = require('../../lib/plugins/blockResources');
const { shouldBlockRequest } = blockResources;

describe('blockResources plugin', function () {
  describe('shouldBlockRequest', function () {
    it('blocks images, fonts, and media by resourceType', function () {
      assert.strictEqual(
        shouldBlockRequest('Image', 'https://chicksx.com/home/hero.webp'),
        true,
      );
      assert.strictEqual(
        shouldBlockRequest('Font', 'https://chicksx.com/MaterialIcons.woff2'),
        true,
      );
      assert.strictEqual(
        shouldBlockRequest('Media', 'https://chicksx.com/promo.mp4'),
        true,
      );
    });

    it('allows the resources that build the DOM (script, css, document, data)', function () {
      assert.strictEqual(
        shouldBlockRequest(
          'Script',
          'https://chicksx.com/app~9a8b795a.b59267e5.bundle.js',
        ),
        false,
      );
      assert.strictEqual(
        shouldBlockRequest(
          'Stylesheet',
          'https://chicksx.com/app~9a8b795a.ef2a5695.bundle.css',
        ),
        false,
      );
      assert.strictEqual(
        shouldBlockRequest('Document', 'https://chicksx.com/sell'),
        false,
      );
      assert.strictEqual(
        shouldBlockRequest('XHR', 'https://api.chicksgroup.com/featureflags'),
        false,
      );
      assert.strictEqual(
        shouldBlockRequest('Fetch', 'https://api.chicksgroup.com/v1/products'),
        false,
      );
    });

    it('does not block a JS/CSS bundle whose URL merely contains an image-like substring', function () {
      // The previous extension-substring approach would have aborted these;
      // resourceType-based blocking does not.
      assert.strictEqual(
        shouldBlockRequest('Script', 'https://chicksx.com/icons.svg.bundle.js'),
        false,
      );
      assert.strictEqual(
        shouldBlockRequest(
          'Stylesheet',
          'https://chicksx.com/sprite.png.styles.css',
        ),
        false,
      );
    });

    it('blocks analytics/ads/widget hosts regardless of resourceType', function () {
      assert.strictEqual(
        shouldBlockRequest(
          'Script',
          'https://www.google-analytics.com/analytics.js',
        ),
        true,
      );
      assert.strictEqual(
        shouldBlockRequest('Image', 'https://stats.g.doubleclick.net/p.gif'),
        true,
      );
      assert.strictEqual(
        shouldBlockRequest('Document', 'https://www.youtube.com/embed/abc123'),
        true,
      );
    });

    it('blocks the Google Fonts stylesheet (targeted) but allows first-party CSS', function () {
      assert.strictEqual(
        shouldBlockRequest(
          'Stylesheet',
          'https://fonts.googleapis.com/css?family=Roboto',
        ),
        true,
      );
      assert.strictEqual(
        shouldBlockRequest('Stylesheet', 'https://chicksx.com/app.bundle.css'),
        false,
      );
    });

    it('handles missing resourceType / url gracefully', function () {
      assert.strictEqual(
        shouldBlockRequest(undefined, 'https://chicksx.com/app.bundle.js'),
        false,
      );
      assert.strictEqual(shouldBlockRequest('Image', undefined), true);
      assert.strictEqual(shouldBlockRequest(undefined, undefined), false);
    });
  });

  describe('tabCreated', function () {
    function fakeTab() {
      const state = { interceptedHandler: null, continued: [] };
      const tab = {
        Network: {
          setRequestInterception: () => Promise.resolve(),
          requestIntercepted: (cb) => {
            state.interceptedHandler = cb;
          },
          continueInterceptedRequest: (opts) => {
            state.continued.push(opts);
          },
        },
      };
      return { tab, state };
    }

    it('aborts a blocked request and continues an allowed one', function () {
      const { tab, state } = fakeTab();
      blockResources.tabCreated({ prerender: { tab } }, {}, () => {});

      state.interceptedHandler({
        interceptionId: '1',
        request: { url: 'https://chicksx.com/hero.png' },
        resourceType: 'Image',
      });
      state.interceptedHandler({
        interceptionId: '2',
        request: { url: 'https://chicksx.com/app.bundle.js' },
        resourceType: 'Script',
      });

      assert.deepStrictEqual(state.continued[0], {
        interceptionId: '1',
        errorReason: 'Aborted',
      });
      assert.deepStrictEqual(state.continued[1], { interceptionId: '2' });
    });
  });
});
