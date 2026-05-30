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
