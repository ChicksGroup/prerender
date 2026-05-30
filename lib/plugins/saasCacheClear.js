// After we successfully render a page ourselves, evict that URL from the SaaS
// prerender (prerender.io) cache so a later fallback re-renders fresh instead of
// serving prerender.io's stale copy (which would then pollute our cache).
//
// IMPORTANT: prerender.io's Cache Clear API allows only ONE clear job per account
// at a time (403 while one is in progress) and clears by SQL-LIKE pattern. So we
// can't fire a clear per render synchronously. Instead we enqueue URLs and a
// single background loop drains them one job at a time, best-effort. Under a
// large render burst (e.g. the initial seed) the bounded queue drops the
// overflow (logged) — pair this with an occasional domain-pattern bulk clear if
// you need guaranteed freshness across everything.
//
// Gated by SAAS_CLEAR_ENABLED (+ a token). No-op otherwise.
const http = require('http');
const https = require('https');
const { URL } = require('url');
const util = require('../util.js');

let cfg = null;
let queue = new Set();
let running = false;

function parseConfig() {
  return {
    enabled: (process.env.SAAS_CLEAR_ENABLED || 'false') === 'true',
    token:
      process.env.SAAS_CLEAR_TOKEN ||
      process.env.PRERENDER_IO_TOKEN ||
      process.env.FALLBACK_TOKEN ||
      '',
    apiUrl: (process.env.SAAS_CLEAR_API || 'https://api.prerender.io').replace(
      /\/$/,
      '',
    ),
    statuses: new Set(
      (process.env.SAAS_CLEAR_STATUS || '200,301,302,404')
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !Number.isNaN(n)),
    ),
    maxQueue: parseInt(process.env.SAAS_CLEAR_MAX_QUEUE || '5000', 10),
    pollMs: parseInt(process.env.SAAS_CLEAR_POLL_MS || '1000', 10),
    pollAttempts: parseInt(process.env.SAAS_CLEAR_POLL_ATTEMPTS || '30', 10),
    idleMs: parseInt(process.env.SAAS_CLEAR_IDLE_MS || '500', 10),
  };
}

function enabled() {
  return !!(cfg && cfg.enabled && cfg.token);
}

function logEvt(evt, data) {
  util.log('[saasClear]', JSON.stringify(Object.assign({ evt }, data || {})));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- real HTTP (overridable in tests) ---
function request(method, path, bodyObj) {
  return new Promise((resolve) => {
    let base;
    try {
      base = new URL(cfg.apiUrl);
    } catch (e) {
      return resolve(0);
    }
    const lib = base.protocol === 'https:' ? https : http;
    const body = bodyObj ? JSON.stringify(bodyObj) : null;
    const headers = {};
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = lib.request(
      {
        method,
        hostname: base.hostname,
        port: base.port || (base.protocol === 'https:' ? 443 : 80),
        path,
        headers,
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(0));
    if (body) req.write(body);
    req.end();
  });
}

let httpImpl = {
  // 200 = queued, 403 = a clear is already in progress for this account
  post: (url) =>
    request('POST', '/cache-clear', { prerenderToken: cfg.token, query: url }),
  // 200 = no job running, 403 = in progress
  status: () => request('GET', '/cache-clear-status/' + cfg.token, null),
};

function enqueue(url) {
  if (!enabled() || !url) return;
  if (queue.size >= cfg.maxQueue) {
    logEvt('queue-full', { dropped: url, size: queue.size });
    return;
  }
  queue.add(url);
}

function takeOne() {
  const v = queue.values().next().value;
  queue.delete(v);
  return v;
}

async function waitUntilDone() {
  for (let i = 0; i < cfg.pollAttempts; i++) {
    const code = await httpImpl.status();
    if (code === 200) return true;
    await sleep(cfg.pollMs);
  }
  return false;
}

// Process exactly one queued URL (one clear job). Exposed for tests.
async function drainOne() {
  if (queue.size === 0) return;
  const url = takeOne();
  try {
    const code = await httpImpl.post(url);
    if (code === 403) {
      // Account-wide job already running (possibly another instance) — retry later.
      queue.add(url);
      return;
    }
    if (code === 200) {
      await waitUntilDone();
      logEvt('cleared', { url });
    } else {
      logEvt('clear-failed', { url, code });
    }
  } catch (e) {
    logEvt('clear-error', { url, err: e && e.message });
  }
}

async function loop() {
  while (running) {
    if (queue.size === 0) {
      await sleep(cfg.idleMs);
      continue;
    }
    await drainOne();
    if (queue.size > 0) await sleep(cfg.pollMs); // stagger jobs (one-at-a-time API)
  }
}

function start() {
  if (running || !enabled()) return;
  running = true;
  loop();
}

module.exports = {
  init: () => {
    cfg = parseConfig();
    if (cfg.enabled && !cfg.token) {
      util.log(
        'warning: SAAS_CLEAR_ENABLED but no token set — SaaS cache-clear inactive',
      );
    }
    util.log(
      `[saasClear] ${enabled() ? 'enabled -> ' + cfg.apiUrl : 'disabled'}`,
    );
    start();
  },

  // Enqueue a clear after a fresh, good, non-fallback render (so prerender.io's
  // now-stale copy is dropped). Cache hits and fallback responses are skipped.
  beforeSend: (req, res, next) => {
    if (enabled()) {
      const p = req.prerender;
      const code = parseInt(p.statusCode, 10);
      if (
        !p._servedFromCache &&
        !p._fromFallback &&
        cfg.statuses.has(code) &&
        (p.renderType || 'html') === 'html'
      ) {
        enqueue(p.url);
      }
    }
    next();
  },

  enabled,
  enqueue,

  // --- test seams ---
  _drainOne: drainOne,
  _queueSize: () => queue.size,
  _setHttpForTests: (impl) => {
    httpImpl = impl;
  },
  _setConfigForTests: (overrides) => {
    cfg = Object.assign(parseConfig(), overrides || {});
  },
  _reset: () => {
    running = false;
    queue = new Set();
    cfg = null;
    httpImpl = {
      post: (url) =>
        request('POST', '/cache-clear', {
          prerenderToken: cfg.token,
          query: url,
        }),
      status: () => request('GET', '/cache-clear-status/' + cfg.token, null),
    };
  },
};
