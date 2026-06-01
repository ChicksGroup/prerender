// Sitemap proxy/rewrite — replaces the standalone sitemap service.
//
// GET /sitemap_index.xml         -> fetch the API's SitemapIndex for this host's
//                                   shortcode and rewrite each child <loc> to a
//                                   public https://<host>/sitemap/sitemap-<n>.xml.
// GET /sitemap/sitemap-<n>.xml    -> fetch the n-th child URL from that index
//                                   (verbatim, XML-unescaped) and pass it through.
//
// It's a fetch + XML-rewrite proxy (no headless render), public (mounted as Express
// routes before the catch-all, so it bypasses tokenAuth/whitelist), and fetches
// fresh every time (no caching). Only the index is rewritten; per-page sitemaps
// already contain public URLs and are passed through unchanged.
const http = require('http');
const https = require('https');
const { URL } = require('url');
const util = require('./util.js');

function parseConfig() {
  const map = {}; // host -> code
  const byCode = {}; // code -> canonical host (first wins) — for rewriting the index
  (process.env.SITEMAP_SHORTCODES || 'chicksx.com:CX,chicksgold.com:CG')
    .split(',')
    .forEach((pair) => {
      const idx = pair.indexOf(':');
      if (idx < 0) return;
      const host = pair.slice(0, idx).trim().toLowerCase();
      const code = pair.slice(idx + 1).trim();
      if (host && code) {
        map[host] = code;
        if (!byCode[code]) byCode[code] = host;
      }
    });
  return {
    enabled: (process.env.SITEMAP_PROXY_ENABLED || 'false') === 'true',
    apiBase: (process.env.SITEMAP_API_BASE || 'https://api.chicksgroup.com').replace(/\/+$/, ''),
    shortcodes: map,
    hostByCode: byCode,
    timeoutMs: parseInt(process.env.SITEMAP_TIMEOUT_MS || '15000', 10),
  };
}

let config = parseConfig();
let fetchFn = null; // set to fetchText below; injectable for tests

function enabled() {
  return config.enabled;
}

// Canonical apex host: lowercase, no port/path, no leading www.
function normHost(host) {
  let h = (host || '').toLowerCase().trim();
  h = h.split('/')[0].split(':')[0];
  if (h.startsWith('www.')) h = h.slice(4);
  return h;
}

function shortcodeFor(host) {
  return config.shortcodes[normHost(host)] || null;
}

// Resolve { code, host } for a request. An explicit code from the front proxy
// (X-Website-Code header or ?websiteCode= query) wins — so this works regardless
// of the Host the proxy forwards — with the public host reverse-mapped from the
// code (used to rewrite the index <loc>s). Falls back to the Host map for direct
// access. Returns null when no site can be determined.
function resolveSite(req) {
  const hdr = req && req.headers ? req.headers['x-website-code'] : '';
  const q = req && req.query ? req.query.websiteCode : '';
  const explicit = String(hdr || q || '').trim();
  if (explicit && /^[A-Za-z0-9]{1,16}$/.test(explicit)) {
    return { code: explicit, host: config.hostByCode[explicit] || normHost(hostOf(req)) };
  }
  const host = normHost(hostOf(req));
  const code = config.shortcodes[host];
  return code ? { code: code, host: host } : null;
}

function xmlUnescape(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&amp;/g, '&'); // ampersand last so &amp;lt; -> &lt;
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Ordered list of { loc, lastmod } from a <sitemapindex>. Sitemaps are simple,
// well-formed XML, so a tolerant regex pass is enough (no XML dep).
function parseSitemapLocs(xml) {
  const out = [];
  const blockRe = /<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi;
  let m;
  while ((m = blockRe.exec(xml)) !== null) {
    const block = m[1];
    const loc = /<loc>\s*([\s\S]*?)\s*<\/loc>/i.exec(block);
    if (!loc) continue;
    const lm = /<lastmod>\s*([\s\S]*?)\s*<\/lastmod>/i.exec(block);
    out.push({ loc: xmlUnescape(loc[1].trim()), lastmod: lm ? lm[1].trim() : null });
  }
  return out;
}

// Rebuild a clean <sitemapindex> pointing children at our public per-page URLs.
function renderIndex(host, entries) {
  const items = entries.map((e, i) => {
    const loc = `https://${host}/sitemap/sitemap-${i + 1}.xml`;
    const lm = e.lastmod ? `\n    <lastmod>${xmlEscape(e.lastmod)}</lastmod>` : '';
    return `  <sitemap>\n    <loc>${xmlEscape(loc)}</loc>${lm}\n  </sitemap>`;
  });
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    items.join('\n') +
    '\n</sitemapindex>\n'
  );
}

// GET an XML resource as text. Non-2xx / timeout / network error -> reject.
function fetchText(url) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(new Error('bad sitemap url'));
    }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(
      url,
      {
        method: 'GET',
        headers: {
          Accept: 'application/xml,text/xml,*/*',
          'Accept-Encoding': 'identity',
          'User-Agent': 'ChicksPrerenderSitemapProxy/1.0',
        },
      },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new Error('upstream HTTP ' + res.statusCode));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      },
    );
    req.setTimeout(config.timeoutMs, () => req.destroy(new Error('sitemap fetch timeout')));
    req.on('error', reject);
    req.end();
  });
}
fetchFn = fetchText;

function indexApiUrl(code) {
  return `${config.apiBase}/Sitemap/SitemapIndex?websiteShortCode=${encodeURIComponent(code)}`;
}

function sendXml(res, body) {
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.status(200).send(body);
}

function hostOf(req) {
  if (req.hostname) return req.hostname;
  const h = req.headers && req.headers.host ? req.headers.host : '';
  return h.split(':')[0];
}

// GET /sitemap_index.xml
function index(req, res) {
  const site = resolveSite(req);
  if (!site) return res.sendStatus(404);
  return Promise.resolve()
    .then(() => fetchFn(indexApiUrl(site.code)))
    .then((xml) => sendXml(res, renderIndex(site.host, parseSitemapLocs(xml))))
    .catch((e) => {
      util.log('[sitemap] index error', site.code, e && e.message);
      return res.sendStatus(502);
    });
}

// GET /sitemap/sitemap-<n>.xml
function page(req, res, n) {
  const site = resolveSite(req);
  if (!site) return res.sendStatus(404);
  if (!Number.isInteger(n) || n < 1) return res.sendStatus(404);
  return Promise.resolve()
    .then(() => fetchFn(indexApiUrl(site.code)))
    .then((xml) => {
      const entries = parseSitemapLocs(xml);
      if (n > entries.length) return res.sendStatus(404);
      return fetchFn(entries[n - 1].loc).then((body) => sendXml(res, body));
    })
    .catch((e) => {
      util.log('[sitemap] page error', site.code, n, e && e.message);
      return res.sendStatus(502);
    });
}

module.exports = {
  enabled,
  index,
  page,
  // exposed for tests / reuse
  shortcodeFor,
  parseSitemapLocs,
  renderIndex,
  // --- test seams ---
  _setFetchForTests: (fn) => {
    fetchFn = fn || fetchText;
  },
  _setConfigForTests: (overrides) => {
    config = Object.assign(parseConfig(), overrides || {});
  },
};
