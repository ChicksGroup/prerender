#!/usr/bin/env node
var prerender = require('./lib');

var server = prerender();

// Auth + domain lockdown run first so unauthorized / off-domain requests are
// rejected before a Chrome tab is ever opened (and before we can be abused as
// an open render proxy / SSRF vector).
server.use(prerender.tokenAuth()); // 403 unless X-Prerender-Token matches PRERENDER_AUTH_TOKEN
server.use(prerender.whitelist()); // 404 for hosts not in ALLOWED_DOMAINS
// SaaS fallback on render failure. Registered BEFORE redisCache so its
// beforeSend replaces a failed render with prerender.io's output first, and the
// cache then stores that. No-op unless FALLBACK_ENABLED=true (+ FALLBACK_TOKEN).
server.use(prerender.fallback());
// Cache read runs after auth+whitelist (never serve cached content to an
// unauthorized/off-domain request); cache write happens in beforeSend.
// No-op unless CACHE_ENABLED=true.
server.use(prerender.redisCache());
// After a fresh render, evict that URL from the SaaS prerender cache so a later
// fallback re-renders fresh. Runs after redisCache so it sees the final state
// (skips cache hits + fallback responses). No-op unless SAAS_CLEAR_ENABLED=true.
server.use(prerender.saasCacheClear());
server.use(prerender.sendPrerenderHeader());
server.use(prerender.browserForceRestart());
// server.use(prerender.blockResources());
server.use(prerender.addMetaTags());
server.use(prerender.removeScriptTags());
server.use(prerender.httpHeaders());

server.start();
