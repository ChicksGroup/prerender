const assert = require('assert');
const server = require('../lib/server');

describe('server.init proxyServer wiring', function () {
  const ORIGINAL = process.env.PROXY_SERVER;

  afterEach(function () {
    if (ORIGINAL === undefined) delete process.env.PROXY_SERVER;
    else process.env.PROXY_SERVER = ORIGINAL;
  });

  it('reads PROXY_SERVER into options.proxyServer', function () {
    process.env.PROXY_SERVER = 'http://squid:3128';
    server.init({});
    assert.strictEqual(server.options.proxyServer, 'http://squid:3128');
  });

  it('does not override an explicit options.proxyServer', function () {
    process.env.PROXY_SERVER = 'http://squid:3128';
    server.init({ proxyServer: 'http://explicit:8080' });
    assert.strictEqual(server.options.proxyServer, 'http://explicit:8080');
  });

  it('leaves proxyServer unset when PROXY_SERVER is not set', function () {
    delete process.env.PROXY_SERVER;
    server.init({});
    assert.strictEqual(server.options.proxyServer, undefined);
  });
});
