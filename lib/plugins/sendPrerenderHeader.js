// Sends `X-Prerender: 1` to the origin (loop-prevention for prerender
// middleware + lets the origin suppress cookie-consent banners for prerender).
//
// CAVEAT: this header is applied to EVERY request the page makes, including the
// SPA's cross-origin XHR/fetch. A custom header on a cross-origin request
// triggers a CORS preflight; if the API's Access-Control-Allow-Headers doesn't
// include `x-prerender`, the browser BLOCKS the call (net::ERR_FAILED) and the
// SPA can't load its data. The correct fix is to allow `x-prerender` in the
// API's CORS config. If you can't, set SEND_PRERENDER_HEADER=false to disable
// this entirely (you then rely on user-agent based loop-prevention).
module.exports = {
  tabCreated: (req, res, next) => {
    if (process.env.SEND_PRERENDER_HEADER === 'false') {
      return next();
    }

    req.prerender.tab.Network.setExtraHTTPHeaders({
      headers: {
        'X-Prerender': '1',
      },
    });

    next();
  },
};
