// Sends `X-Prerender: 1` to the origin (prerender loop-prevention + lets the
// origin suppress cookie-consent banners for prerender).
// NOTE: this header rides on EVERY request, including the page's cross-origin
// XHR/fetch, so each cross-origin API must allow `x-prerender` in its CORS
// Access-Control-Allow-Headers — otherwise the preflight blocks the call and a
// data-driven SPA renders an empty body.
module.exports = {
  tabCreated: (req, res, next) => {
    req.prerender.tab.Network.setExtraHTTPHeaders({
      headers: {
        'X-Prerender': '1',
      },
    });

    next();
  },
};
