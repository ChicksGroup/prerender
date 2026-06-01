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

        req.prerender.tab.Network.continueInterceptedRequest(interceptOptions);
      },
    );
  },
};
