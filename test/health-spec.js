const assert = require('assert');
const server = require('../lib/server');

// /ready delegates to server.isReady(); test that logic directly so we don't
// need to boot Express/Chrome.
describe('server readiness (isReady)', function () {
  let originalConnected, originalShutdown;

  beforeEach(function () {
    originalConnected = server.isBrowserConnected;
    originalShutdown = server.isShuttingDown;
  });

  afterEach(function () {
    server.isBrowserConnected = originalConnected;
    server.isShuttingDown = originalShutdown;
  });

  it('is ready when the browser is connected and not shutting down', function () {
    server.isBrowserConnected = true;
    server.isShuttingDown = false;
    assert.strictEqual(server.isReady(), true);
  });

  it('is not ready when the browser is not connected', function () {
    server.isBrowserConnected = false;
    server.isShuttingDown = false;
    assert.strictEqual(server.isReady(), false);
  });

  it('is not ready while shutting down', function () {
    server.isBrowserConnected = true;
    server.isShuttingDown = true;
    assert.strictEqual(server.isReady(), false);
  });
});
