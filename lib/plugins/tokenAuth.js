const crypto = require('crypto');
const util = require('../util.js');

// Constant-time string compare so a wrong token can't be discovered by timing.
// Length mismatch returns false (the small length leak is acceptable for a
// high-entropy shared secret behind TLS).
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Shared-secret auth for the render endpoint. The site middleware sends the
// secret in the `X-Prerender-Token` header (the same header prerender.io uses).
// When PRERENDER_AUTH_TOKEN is unset (local dev / tests) all requests pass.
module.exports = {
  init: () => {
    if (!process.env.PRERENDER_AUTH_TOKEN) {
      util.log(
        'warning: tokenAuth plugin enabled but PRERENDER_AUTH_TOKEN is not set; allowing all requests',
      );
    }
  },

  requestReceived: (req, res, next) => {
    const expected = process.env.PRERENDER_AUTH_TOKEN;

    // No token configured -> do not block (keeps local dev and tests working).
    if (!expected) {
      return next();
    }

    const provided = req.headers && req.headers['x-prerender-token'];

    if (safeEqual(provided, expected)) {
      return next();
    }

    return res.send(403);
  },
};
