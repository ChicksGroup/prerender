const assert = require('assert');
const sitemapProxy = require('../lib/sitemapProxy');

// API SitemapIndex sample (note &amp; — the XML-escaped &).
const INDEX_XML =
  '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
  [1, 2, 3, 4, 5, 6, 7, 8]
    .map(
      (n) =>
        '<sitemap><loc>https://api.chicksgroup.com/Sitemap?websiteShortCode=CX&amp;page=' +
        n +
        '</loc></sitemap>',
    )
    .join('') +
  '</sitemapindex>';

const PAGE3_XML =
  '<?xml version="1.0" encoding="utf-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
  '<url><loc>https://chicksx.com/swap/cvx-to-imx</loc></url></urlset>';

function makeReq(host, headers, query) {
  return {
    hostname: host,
    headers: Object.assign({ host: host }, headers || {}),
    query: query || {},
  };
}
function makeRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    send(b) { this.body = b; return this; },
    sendStatus(c) { this.statusCode = c; this.body = null; return this; },
  };
}

describe('sitemapProxy', function () {
  afterEach(function () {
    sitemapProxy._setConfigForTests(); // reparse defaults
    sitemapProxy._setFetchForTests(null); // restore real fetch
  });

  describe('shortcodeFor', function () {
    it('maps apex/www/port/case to the shortcode, unknown -> null', function () {
      assert.equal(sitemapProxy.shortcodeFor('chicksx.com'), 'CX');
      assert.equal(sitemapProxy.shortcodeFor('www.chicksx.com'), 'CX');
      assert.equal(sitemapProxy.shortcodeFor('chicksx.com:443'), 'CX');
      assert.equal(sitemapProxy.shortcodeFor('CHICKSX.COM'), 'CX');
      assert.equal(sitemapProxy.shortcodeFor('chicksgold.com'), 'CG');
      assert.equal(sitemapProxy.shortcodeFor('example.com'), null);
      assert.equal(sitemapProxy.shortcodeFor(''), null);
    });
  });

  describe('parseSitemapLocs', function () {
    it('extracts ordered locs and XML-unescapes &amp;', function () {
      const locs = sitemapProxy.parseSitemapLocs(INDEX_XML);
      assert.equal(locs.length, 8);
      assert.equal(locs[0].loc, 'https://api.chicksgroup.com/Sitemap?websiteShortCode=CX&page=1');
      assert.equal(locs[7].loc, 'https://api.chicksgroup.com/Sitemap?websiteShortCode=CX&page=8');
    });
  });

  describe('renderIndex', function () {
    it('rewrites children to public per-page URLs (1-based)', function () {
      const xml = sitemapProxy.renderIndex('chicksx.com', sitemapProxy.parseSitemapLocs(INDEX_XML));
      assert.ok(xml.indexOf('<loc>https://chicksx.com/sitemap/sitemap-1.xml</loc>') > -1);
      assert.ok(xml.indexOf('<loc>https://chicksx.com/sitemap/sitemap-8.xml</loc>') > -1);
      assert.ok(xml.indexOf('api.chicksgroup.com') === -1); // no API URLs leak through
      assert.equal((xml.match(/<sitemap>/g) || []).length, 8);
    });
  });

  describe('index handler', function () {
    it('serves the rewritten index as XML for a known host', async function () {
      sitemapProxy._setFetchForTests(() => Promise.resolve(INDEX_XML));
      const res = makeRes();
      await sitemapProxy.index(makeReq('www.chicksx.com'), res);
      assert.equal(res.statusCode, 200);
      assert.ok(/application\/xml/.test(res.headers['content-type']));
      assert.ok(res.body.indexOf('https://chicksx.com/sitemap/sitemap-1.xml') > -1);
    });

    it('uses X-Website-Code header to pick the site, ignoring the request Host', async function () {
      // Behind nginx the Host is the proxy host; the code comes via the header,
      // and the public host is reverse-mapped from the code for the rewrite.
      sitemapProxy._setFetchForTests(() => Promise.resolve(INDEX_XML));
      const res = makeRes();
      await sitemapProxy.index(makeReq('prerender.chicksgroup.com', { 'x-website-code': 'CX' }), res);
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.indexOf('https://chicksx.com/sitemap/sitemap-1.xml') > -1);
      assert.ok(res.body.indexOf('prerender.chicksgroup.com') === -1);
    });

    it('uses the ?websiteCode= query as a fallback to the header', async function () {
      sitemapProxy._setFetchForTests(() => Promise.resolve(INDEX_XML));
      const res = makeRes();
      await sitemapProxy.index(makeReq('prerender.chicksgroup.com', {}, { websiteCode: 'CX' }), res);
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.indexOf('https://chicksx.com/sitemap/sitemap-1.xml') > -1);
    });

    it('dev environment fetches the dev API and rewrites to the dev. host', async function () {
      let fetchedUrl = null;
      sitemapProxy._setFetchForTests((url) => {
        fetchedUrl = url;
        return Promise.resolve(INDEX_XML);
      });
      const res = makeRes();
      await sitemapProxy.index(
        makeReq('prerender.chicksgroup.com', { 'x-website-code': 'CX', 'x-environment': 'dev' }),
        res,
      );
      assert.equal(res.statusCode, 200);
      assert.ok(fetchedUrl.indexOf('https://dev-api.chicksgroup.com/Sitemap/SitemapIndex') === 0);
      assert.ok(res.body.indexOf('https://dev.chicksx.com/sitemap/sitemap-1.xml') > -1);
      assert.ok(res.body.indexOf('https://chicksx.com/sitemap') === -1); // no apex leak
    });

    it('staging environment fetches the staging API and rewrites to the staging. host', async function () {
      let fetchedUrl = null;
      sitemapProxy._setFetchForTests((url) => {
        fetchedUrl = url;
        return Promise.resolve(INDEX_XML);
      });
      const res = makeRes();
      await sitemapProxy.index(
        makeReq('prerender.chicksgroup.com', { 'x-website-code': 'CX', 'x-environment': 'staging' }),
        res,
      );
      assert.equal(res.statusCode, 200);
      assert.ok(fetchedUrl.indexOf('https://staging-api.chicksgroup.com/') === 0);
      assert.ok(res.body.indexOf('https://staging.chicksx.com/sitemap/sitemap-1.xml') > -1);
    });

    it('404s an unknown host (no fetch)', async function () {
      let fetched = false;
      sitemapProxy._setFetchForTests(() => { fetched = true; return Promise.resolve(INDEX_XML); });
      const res = makeRes();
      await sitemapProxy.index(makeReq('example.com'), res);
      assert.equal(res.statusCode, 404);
      assert.equal(fetched, false);
    });

    it('502s when the upstream fetch fails', async function () {
      sitemapProxy._setFetchForTests(() => Promise.reject(new Error('boom')));
      const res = makeRes();
      await sitemapProxy.index(makeReq('chicksx.com'), res);
      assert.equal(res.statusCode, 502);
    });
  });

  describe('page handler', function () {
    function routedFetch(url) {
      if (url.indexOf('SitemapIndex') > -1) return Promise.resolve(INDEX_XML);
      if (url.indexOf('page=3') > -1) return Promise.resolve(PAGE3_XML);
      return Promise.resolve('<urlset></urlset>');
    }

    it('passes the n-th API sitemap through verbatim', async function () {
      sitemapProxy._setFetchForTests(routedFetch);
      const res = makeRes();
      await sitemapProxy.page(makeReq('chicksx.com'), res, 3);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body, PAGE3_XML); // unchanged, no inner rewrite
      assert.ok(/application\/xml/.test(res.headers['content-type']));
    });

    it('resolves the site from X-Website-Code (proxy Host) and passes the page through', async function () {
      sitemapProxy._setFetchForTests(routedFetch);
      const res = makeRes();
      await sitemapProxy.page(makeReq('prerender.chicksgroup.com', { 'x-website-code': 'CX' }), res, 3);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body, PAGE3_XML);
    });

    it('404s an out-of-range page', async function () {
      sitemapProxy._setFetchForTests(routedFetch);
      const res = makeRes();
      await sitemapProxy.page(makeReq('chicksx.com'), res, 99);
      assert.equal(res.statusCode, 404);
    });

    it('404s an unknown host', async function () {
      sitemapProxy._setFetchForTests(routedFetch);
      const res = makeRes();
      await sitemapProxy.page(makeReq('example.com'), res, 1);
      assert.equal(res.statusCode, 404);
    });
  });
});
