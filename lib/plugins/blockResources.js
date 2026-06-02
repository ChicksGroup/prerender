// Resource categories that never appear in the HTML we serialize for crawlers.
// Prerendering returns only the rendered DOM, so images, fonts, and media are
// pure waste: they cost CDN egress (every render uses a fresh, cold-cache
// Chrome context, so they're re-downloaded each time) and slow the render.
// We block by Chrome's resourceType — far more robust than matching file
// extensions in the URL (which can false-positive on, e.g., `icons.svg.js`).
//
// We deliberately DO NOT block:
//   - Script               the SPA needs JS to build the DOM
//   - Stylesheet (CSS)      blocking it can change the serialized DOM
//                           (layout-driven JS, visibility/lazy-load logic)
//   - Document / XHR / Fetch  the page itself and the data it renders from
const blockedResourceTypes = new Set(['Image', 'Font', 'Media']);

// Analytics / ads / chat / tag-manager hosts (plus a few third-party font/CSS
// CDNs) that are useless for prerendering and only add render time, request
// noise, and pageview/impression inflation. Matched as a substring of the
// request URL regardless of resourceType, since these load as scripts,
// beacons, iframes, or stylesheets. Mirrors prerender.io's production default.
const blockedUrlSubstrings = [
  'google-analytics.com',
  'api.mixpanel.com',
  'fonts.googleapis.com',
  'stats.g.doubleclick.net',
  'mc.yandex.ru',
  'use.typekit.net',
  'beacon.tapfiliate.com',
  'js-agent.newrelic.com',
  'api.segment.io',
  'woopra.com',
  'static.olark.com',
  'static.getclicky.com',
  'fast.fonts.com',
  'youtube.com/embed',
  'cdn.heapanalytics.com',
  'googleads.g.doubleclick.net',
  'pagead2.googlesyndication.com',
  'fullstory.com/rec',
  'navilytics.com/nls_ajax.php',
  'log.optimizely.com/event',
  'hn.inspectlet.com',
  'tpc.googlesyndication.com',
  'partner.googleadservices.com',

  // Modern analytics / tag managers / ad pixels / chat widgets / session
  // recorders that the legacy list above predates. None affect the serialized
  // HTML, and blocking the tag managers also prevents the pixels they would
  // otherwise inject from ever loading. Keeping these out of the render also
  // stops every prerender from firing a bot pageview/conversion into GA, Ads,
  // Meta, Bing, Clarity, etc. (analytics-data pollution).
  'googletagmanager.com', // GTM (gtm.js / gtag/js / gtag/destination) — the root that pulls in most others
  'analytics.google.com', // GA4 collect
  '/g/collect', // GA4 measurement-protocol beacon (also fires on www.google.com)
  '/ccm/collect', // Google Ads / consent-mode collect
  '/rmkt/', // Google Ads remarketing collect
  '/pagead/', // Google ad tags
  'connect.facebook.net', // Meta Pixel / FB SDK loader
  'facebook.com/tr', // Meta Pixel beacon
  'bat.bing.com', // Microsoft Ads UET
  'clarity.ms', // Microsoft Clarity (www. / scripts. / n. subdomains)
  'cloudflareinsights.com', // Cloudflare Web Analytics beacon (NOT cdn-cgi challenge — left untouched)
  'widget.intercom.io', // Intercom chat widget
  'js.intercomcdn.com',
  'redditstatic.com', // Reddit Pixel
  'pixel-config.reddit.com',
  'snap.licdn.com', // LinkedIn Insight
  'analytics.tiktok.com', // TikTok Pixel
  'static.ads-twitter.com', // X/Twitter Pixel
  'cdn.segment.com', // Segment
  'hotjar.com', // Hotjar
  'js.jam.dev', // Jam.dev session recorder
];

// Pure decision function (no Chrome dependency) so the block policy is unit
// testable. Returns true if the request should be aborted.
function shouldBlockRequest(resourceType, url) {
  if (resourceType && blockedResourceTypes.has(resourceType)) return true;
  if (!url) return false;
  return blockedUrlSubstrings.some((substring) => url.indexOf(substring) >= 0);
}

module.exports = {
  shouldBlockRequest,
  blockedResourceTypes,
  blockedUrlSubstrings,

  tabCreated: (req, res, next) => {
    req.prerender.tab.Network.setRequestInterception({
      patterns: [{ urlPattern: '*' }],
    }).then(() => {
      next();
    });

    req.prerender.tab.Network.requestIntercepted(
      ({ interceptionId, request, resourceType }) => {
        let interceptOptions = { interceptionId };

        if (shouldBlockRequest(resourceType, request.url)) {
          interceptOptions.errorReason = 'Aborted';
        }

        // continueInterceptedRequest returns a promise that REJECTS if the tab's
        // CDP WebSocket is already closing/closed — which happens routinely when a
        // render finishes (or times out) while requests are still in flight, so the
        // tab is torn down mid-interception. That rejection is benign (the request
        // is moot once the tab is gone), but if left unhandled Node's default
        // --unhandled-rejections=throw crashes the entire process. Under the
        // refresher's high tab churn this fires constantly. Swallow it.
        const p = req.prerender.tab.Network.continueInterceptedRequest(
          interceptOptions,
        );
        if (p && typeof p.catch === 'function') p.catch(() => {});
      },
    );
  },
};
