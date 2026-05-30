const fs = require('fs');
const path = require('path');
const http = require('http');
const util = require('./util');
const basename = path.basename;
const server = require('./server');
const express = require('express');
const app = express();
const bodyParser = require('body-parser');
const compression = require('compression');
const redisCache = require('./plugins/redisCache');

// Shared-secret check for the /cache/* routes. They are plain Express routes
// (registered before the catch-all), so they bypass the render plugin pipeline
// and need their own auth. Allows all when PRERENDER_AUTH_TOKEN is unset.
function cacheAuthOk(req) {
  const expected = process.env.PRERENDER_AUTH_TOKEN;
  if (!expected) return true;
  return req.headers['x-prerender-token'] === expected;
}

exports = module.exports = (
  options = {
    logRequests: process.env.PRERENDER_LOG_REQUESTS === 'true',
  },
) => {
  const parsedOptions = Object.assign(
    {},
    {
      port: options.port || process.env.PORT || 3000,
    },
    options,
  );

  server.init(options);
  server.onRequest = server.onRequest.bind(server);

  app.disable('x-powered-by');
  app.use(compression());

  // Liveness: the process is up and serving HTTP. Registered before the
  // catch-all so it isn't treated as a URL to render.
  app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

  // Readiness: the browser is connected and we're not draining for shutdown.
  // The platform health check points here so draining/unhealthy instances are
  // pulled from rotation.
  app.get('/ready', (req, res) => {
    const ready = server.isReady();
    res.status(ready ? 200 : 503).json({
      ready,
      browserConnected: server.isBrowserConnected === true,
      shuttingDown: !!server.isShuttingDown,
      inFlight: server.browserRequestsInFlight
        ? server.browserRequestsInFlight.size
        : null,
    });
  });

  // --- cache introspection (token-protected; drives the cache-manager) ---
  // Batch lookup: which of these URLs are cached, and when were they stored.
  app.post('/cache/status', bodyParser.json({ limit: '8mb' }), (req, res) => {
    if (!cacheAuthOk(req)) return res.sendStatus(403);
    const urls = req.body && req.body.urls;
    if (!Array.isArray(urls))
      return res.status(400).json({ error: 'body.urls must be an array' });
    redisCache
      .status(urls)
      .then((results) => res.json({ results }))
      .catch((e) => res.status(503).json({ error: e.message }));
  });

  // Oldest cached entries (refresh candidates). ?limit=N&olderThanMs=M
  app.get('/cache/stale', (req, res) => {
    if (!cacheAuthOk(req)) return res.sendStatus(403);
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 10000);
    const olderThanMs = parseInt(req.query.olderThanMs, 10) || 0;
    redisCache
      .stale({ limit, olderThanMs })
      .then((results) => res.json({ results }))
      .catch((e) => res.status(503).json({ error: e.message }));
  });

  // Cache coverage / age summary for observability.
  app.get('/cache/stats', (req, res) => {
    if (!cacheAuthOk(req)) return res.sendStatus(403);
    redisCache
      .stats()
      .then((s) => res.json(s))
      .catch((e) => res.status(503).json({ error: e.message }));
  });

  app.get('*', server.onRequest);

  //dont check content-type and just always try to parse body as json
  app.post('*', bodyParser.json({ type: () => true }), server.onRequest);

  // Capture the http.Server handle so graceful shutdown can stop accepting
  // new connections while in-flight renders drain.
  server.httpServer = app.listen(parsedOptions, () =>
    util.log(
      `Prerender server accepting requests on port ${parsedOptions.port}`,
    ),
  );

  return server;
};

fs.readdirSync(__dirname + '/plugins').forEach((filename) => {
  if (!/\.js$/.test(filename)) return;

  var name = basename(filename, '.js');

  function load() {
    return require('./plugins/' + name);
  }

  Object.defineProperty(exports, name, {
    value: load,
  });
});
