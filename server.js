#!/usr/bin/env node
var prerender = require('./lib');

var server = prerender();

// Auth + domain lockdown run first so unauthorized / off-domain requests are
// rejected before a Chrome tab is ever opened (and before we can be abused as
// an open render proxy / SSRF vector).
server.use(prerender.tokenAuth()); // 403 unless X-Prerender-Token matches PRERENDER_AUTH_TOKEN
server.use(prerender.whitelist()); // 404 for hosts not in ALLOWED_DOMAINS
// Cache read runs after auth+whitelist (never serve cached content to an
// unauthorized/off-domain request); cache write happens in beforeSend.
// No-op unless CACHE_ENABLED=true.
server.use(prerender.redisCache());
server.use(prerender.sendPrerenderHeader());
server.use(prerender.browserForceRestart());
// server.use(prerender.blockResources());
server.use(prerender.addMetaTags());
server.use(prerender.removeScriptTags());
server.use(prerender.httpHeaders());

server.start();
