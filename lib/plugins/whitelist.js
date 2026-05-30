var url = require('url');
const util = require('../util.js');

let allowedDomains = [];

function parseDomains() {
  return (process.env.ALLOWED_DOMAINS || '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

// Allow an exact host OR any subdomain of an allowed base domain.
//   ALLOWED_DOMAINS=chicksx.com  permits  chicksx.com, www.chicksx.com, api.chicksx.com
//   but NOT  evilchicksx.com  or  chicksx.com.attacker.com
function isAllowed(hostname) {
  const h = (hostname || '').toLowerCase();
  if (!h) return false;
  return allowedDomains.some((d) => h === d || h.endsWith('.' + d));
}

module.exports = {
  init: () => {
    allowedDomains = parseDomains();
    if (allowedDomains.length === 0) {
      util.log(
        'warning: whitelist plugin enabled but ALLOWED_DOMAINS is empty — all requests will 404',
      );
    }
  },
  requestReceived: (req, res, next) => {
    if (isAllowed(url.parse(req.prerender.url).hostname)) {
      next();
    } else {
      res.send(404);
    }
  },
};
