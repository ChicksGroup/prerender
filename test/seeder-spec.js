const assert = require('assert');
const sinon = require('sinon');
const zlib = require('zlib');
const seeder = require('../lib/seeder');

// A fake server exposing just what the seeder reads.
function makeServer() {
  return { isShuttingDown: false };
}

// Injected-dep defaults: a scan that would succeed with nothing to do. Tests
// override the pieces they exercise.
function makeDeps(overrides) {
  return Object.assign(
    {
      manual: true,
      fetch: () => Promise.reject(new Error('no fetch stubbed')),
      status: (urls) => Promise.resolve(urls.map(() => ({ cached: false }))),
      enqueue: (urls) => Promise.resolve(urls.length),
      getSitemapList: () => Promise.resolve([]),
      getLastScanAt: () => Promise.resolve(null),
      setLastScanAt: () => Promise.resolve(),
      acquireLock: () => Promise.resolve(true),
      renewLock: () => Promise.resolve(true),
      releaseLock: () => Promise.resolve(),
      recordStatus: () => Promise.resolve(),
      pruneStatuses: () => Promise.resolve(),
      sleep: () => Promise.resolve(),
    },
    overrides || {},
  );
}

function urlsetXml(urls) {
  const items = urls
    .map(
      (u) =>
        `<url><loc>${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items}\n</urlset>`;
}

function indexXml(locs) {
  const items = locs
    .map((l) => `<sitemap><loc>${l}</loc></sitemap>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items}\n</sitemapindex>`;
}

// fetch stub backed by a url -> xml map; unknown urls reject.
function mapFetch(map, calls) {
  return (url) => {
    if (calls) calls.push(url);
    return map[url] != null
      ? Promise.resolve(map[url])
      : Promise.reject(new Error('sitemap HTTP 404'));
  };
}

const SEEDER_ENVS = [
  'SEEDER_INTERVAL_MS',
  'SEEDER_TICK_MS',
  'SEEDER_FETCH_COOLDOWN_MS',
  'SEEDER_LOCK_TTL_MS',
  'SEEDER_FETCH_TIMEOUT_MS',
  'SEEDER_MAX_DEPTH',
  'SEEDER_STATUS_BATCH',
];

describe('seeder parsing', function () {
  it('parseLastmodMs handles W3C variants and treats naive datetimes as UTC', function () {
    assert.equal(seeder._parseLastmodMs('2026-01-02'), Date.UTC(2026, 0, 2));
    assert.equal(
      seeder._parseLastmodMs('2026-01-02T03:04:05Z'),
      Date.UTC(2026, 0, 2, 3, 4, 5),
    );
    assert.equal(
      seeder._parseLastmodMs('2026-01-02T03:04:05+02:00'),
      Date.UTC(2026, 0, 2, 1, 4, 5),
    );
    // naive datetime == the same instant with an explicit Z (Python parity;
    // plain Date.parse would have used LOCAL time here)
    assert.equal(
      seeder._parseLastmodMs('2026-01-02T03:04:05'),
      Date.UTC(2026, 0, 2, 3, 4, 5),
    );
    assert.equal(seeder._parseLastmodMs('not a date'), null);
    assert.equal(seeder._parseLastmodMs(''), null);
    assert.equal(seeder._parseLastmodMs(null), null);
  });

  it('parseSitemap extracts urlset entries with lastmod and unescapes locs', function () {
    const xml = urlsetXml([
      { loc: 'https://x.com/a?p=1&amp;q=2', lastmod: '2026-01-02' },
      { loc: 'https://x.com/b' },
    ]);
    const doc = seeder._parseSitemap(xml);
    assert.equal(doc.kind, 'urlset');
    assert.equal(doc.entries.length, 2);
    assert.equal(doc.entries[0].loc, 'https://x.com/a?p=1&q=2');
    assert.equal(doc.entries[0].lastmodMs, Date.UTC(2026, 0, 2));
    assert.equal(doc.entries[1].lastmodMs, null);
  });

  it('parseSitemap recognizes a sitemapindex and skips blocks without a loc', function () {
    const doc = seeder._parseSitemap(
      indexXml(['https://x.com/s1.xml']).replace(
        '</sitemapindex>',
        '<sitemap><lastmod>2026-01-01</lastmod></sitemap></sitemapindex>',
      ),
    );
    assert.equal(doc.kind, 'index');
    assert.deepEqual(
      doc.entries.map((e) => e.loc),
      ['https://x.com/s1.xml'],
    );
  });

  it('maybeGunzip inflates by magic bytes or .gz suffix and survives corrupt gzip', function () {
    const xml = '<urlset></urlset>';
    const gz = zlib.gzipSync(Buffer.from(xml, 'utf8'));
    assert.equal(seeder._maybeGunzip(gz, 'https://x.com/s.xml').toString(), xml);
    assert.equal(seeder._maybeGunzip(gz, 'https://x.com/s.xml.gz').toString(), xml);
    const plain = Buffer.from(xml, 'utf8');
    assert.equal(seeder._maybeGunzip(plain, 'https://x.com/s.xml').toString(), xml);
    // .gz url with a non-gzip (or corrupt) body falls back to the raw bytes
    assert.equal(seeder._maybeGunzip(plain, 'https://x.com/s.xml.gz').toString(), xml);
    const corrupt = Buffer.concat([gz.slice(0, 4), Buffer.from('xx')]);
    assert.equal(seeder._maybeGunzip(corrupt, 'https://x.com/s.xml.gz'), corrupt);
  });
});

describe('seeder classify (seed_lastmod semantics)', function () {
  const e = (loc, lastmodMs) => ({ loc, lastmodMs: lastmodMs || null });
  const row = (cached, storedAt, status) => ({ cached, storedAt, status });

  function run(entry, r) {
    return seeder._classify([entry], [r]);
  }

  it('uncached / missing row -> new (P0)', function () {
    assert.deepEqual(run(e('u'), row(false, null, null)).newUrls, ['u']);
    assert.deepEqual(run(e('u'), undefined).newUrls, ['u']);
  });

  it('cached + fresh, no lastmod -> neither list', function () {
    const r = run(e('u'), row(true, Date.now(), 200));
    assert.deepEqual(r.newUrls, []);
    assert.deepEqual(r.refreshUrls, []);
  });

  it('cached + ANCIENT 2xx without lastmod -> NOT refreshed (no time-based staleness)', function () {
    const r = run(e('u'), row(true, 1000, 200)); // stored ~1970
    assert.deepEqual(r.refreshUrls, []);
  });

  it('lastmod newer than storedAt -> refresh (P1); equal/older -> skip', function () {
    assert.deepEqual(run(e('u', 2000), row(true, 1000, 200)).refreshUrls, ['u']);
    assert.deepEqual(run(e('u', 1000), row(true, 1000, 200)).refreshUrls, []);
    assert.deepEqual(run(e('u', 500), row(true, 1000, 200)).refreshUrls, []);
  });

  it('cached 4xx is never enqueued, even with a newer lastmod', function () {
    const r = run(e('u', 2000), row(true, 1000, 404));
    assert.deepEqual(r.newUrls, []);
    assert.deepEqual(r.refreshUrls, []);
  });

  it('an evicted 4xx reappears as uncached -> re-seeded as new (Model B)', function () {
    // redisCache.status() reaps an expired 4xx and reports cached:false
    assert.deepEqual(run(e('u'), row(false, null, null)).newUrls, ['u']);
  });

  it('cached with an unreadable storedAt -> refresh', function () {
    assert.deepEqual(run(e('u'), row(true, null, 200)).refreshUrls, ['u']);
  });

  it('3xx follows the same lastmod rule (time-based redirect refresh is the refresher\'s)', function () {
    assert.deepEqual(run(e('u', 2000), row(true, 1000, 301)).refreshUrls, ['u']);
    assert.deepEqual(run(e('u'), row(true, 1000, 301)).refreshUrls, []);
  });
});

describe('seeder collect (sitemap expansion)', function () {
  afterEach(function () {
    seeder.stop();
    SEEDER_ENVS.forEach((k) => delete process.env[k]);
  });

  const noHooks = { afterFetch: () => {} };

  it('expands a sitemap index recursively and dedups shared children', async function () {
    const calls = [];
    const map = {
      'https://x.com/index.xml': indexXml([
        'https://x.com/s1.xml',
        'https://x.com/s2.xml',
        'https://x.com/s1.xml', // duplicate child -> fetched once
      ]),
      'https://x.com/s1.xml': urlsetXml([{ loc: 'https://x.com/a' }]),
      'https://x.com/s2.xml': urlsetXml([
        { loc: 'https://x.com/b' },
        { loc: 'https://x.com/a' }, // duplicate loc across sub-sitemaps
      ]),
    };
    seeder.start(makeServer(), makeDeps({ fetch: mapFetch(map, calls) }));
    const { entries } = await seeder._collect('https://x.com/index.xml', noHooks);
    assert.deepEqual(entries.map((e) => e.loc).sort(), [
      'https://x.com/a',
      'https://x.com/b',
    ]);
    assert.equal(calls.filter((u) => u === 'https://x.com/s1.xml').length, 1);
  });

  it('stops recursing past SEEDER_MAX_DEPTH', async function () {
    process.env.SEEDER_MAX_DEPTH = '2';
    const calls = [];
    const map = {
      i0: indexXml(['i1']),
      i1: indexXml(['i2']),
      i2: indexXml(['u3']), // depth 3 > 2 -> u3 must not be fetched
      u3: urlsetXml([{ loc: 'https://x.com/deep' }]),
    };
    seeder.start(makeServer(), makeDeps({ fetch: mapFetch(map, calls) }));
    const { entries } = await seeder._collect('i0', noHooks);
    assert.deepEqual(entries, []);
    assert.ok(calls.indexOf('u3') === -1);
  });

  it('skips a broken child but throws on a broken root', async function () {
    const map = {
      'https://x.com/index.xml': indexXml([
        'https://x.com/broken.xml',
        'https://x.com/ok.xml',
      ]),
      'https://x.com/ok.xml': urlsetXml([{ loc: 'https://x.com/a' }]),
    };
    seeder.start(makeServer(), makeDeps({ fetch: mapFetch(map) }));
    const { entries, childErrors } = await seeder._collect(
      'https://x.com/index.xml',
      noHooks,
    );
    assert.deepEqual(entries.map((e) => e.loc), ['https://x.com/a']);
    assert.equal(childErrors, 1);
    await assert.rejects(
      () => seeder._collect('https://x.com/missing-root.xml', noHooks),
      /404/,
    );
  });

  it('cools down between fetches (success AND failure) but not after the last', async function () {
    const sleep = sinon.stub().resolves();
    const map = {
      root: indexXml(['broken', 'ok']),
      ok: urlsetXml([{ loc: 'https://x.com/a' }]),
    };
    seeder.start(makeServer(), makeDeps({ fetch: mapFetch(map), sleep }));
    await seeder._collect('root', { afterFetch: () => {} });
    // 3 fetches (root, then the two children in LIFO order) -> cooldown after
    // the first two only (the failure included), never after the queue empties
    assert.equal(sleep.callCount, 2);
    sleep.resetHistory();
    seeder.stop();
    seeder.start(makeServer(), makeDeps({ fetch: mapFetch(map), sleep }));
    await seeder._collect('ok', { afterFetch: () => {} }); // single doc
    assert.equal(sleep.callCount, 0);
  });

  it('renews the lock after every fetch via the afterFetch hook', async function () {
    const afterFetch = sinon.stub().resolves();
    const map = {
      root: indexXml(['ok']),
      ok: urlsetXml([{ loc: 'https://x.com/a' }]),
    };
    seeder.start(makeServer(), makeDeps({ fetch: mapFetch(map) }));
    await seeder._collect('root', { afterFetch });
    assert.equal(afterFetch.callCount, 2);
  });
});

describe('seeder scan + gating', function () {
  afterEach(function () {
    seeder.stop();
    SEEDER_ENVS.forEach((k) => delete process.env[k]);
  });

  const SM = { id: 'a1', url: 'https://x.com/sitemap.xml', enabled: true };

  it('diffs in SEEDER_STATUS_BATCH chunks and enqueues at the right priorities', async function () {
    process.env.SEEDER_STATUS_BATCH = '500';
    const locs = Array.from({ length: 1200 }, (_, i) => ({
      loc: `https://x.com/p${i}`,
    }));
    const statusCalls = [];
    const enqueueCalls = [];
    const deps = makeDeps({
      fetch: () => Promise.resolve(urlsetXml(locs)),
      status: (urls) => {
        statusCalls.push(urls.length);
        return Promise.resolve(urls.map(() => ({ cached: false })));
      },
      enqueue: (urls, p) => {
        enqueueCalls.push([urls.length, p]);
        return Promise.resolve(urls.length);
      },
      getSitemapList: () => Promise.resolve([SM]),
    });
    seeder.start(makeServer(), deps);
    const summary = await seeder._tickOnce();
    assert.deepEqual(statusCalls, [500, 500, 200]);
    assert.deepEqual(enqueueCalls, [
      [500, 0],
      [500, 0],
      [200, 0],
    ]);
    assert.equal(summary.urlsFound, 1200);
    assert.equal(summary.enqueuedNew, 1200);
    assert.equal(summary.enqueuedRefresh, 0);
  });

  it('splits new (P0) and lastmod-changed (P1) within a batch', async function () {
    const enqueueCalls = [];
    const xml = urlsetXml([
      { loc: 'https://x.com/new' },
      { loc: 'https://x.com/changed', lastmod: '2026-01-02' },
      { loc: 'https://x.com/fresh' },
    ]);
    const rowsByUrl = {
      'https://x.com/new': { cached: false },
      'https://x.com/changed': {
        cached: true,
        storedAt: Date.UTC(2026, 0, 1),
        status: 200,
      },
      'https://x.com/fresh': {
        cached: true,
        storedAt: Date.UTC(2026, 0, 3),
        status: 200,
      },
    };
    const deps = makeDeps({
      fetch: () => Promise.resolve(xml),
      status: (urls) => Promise.resolve(urls.map((u) => rowsByUrl[u])),
      enqueue: (urls, p) => {
        enqueueCalls.push([urls.slice(), p]);
        return Promise.resolve(urls.length);
      },
      getSitemapList: () => Promise.resolve([SM]),
    });
    seeder.start(makeServer(), deps);
    const summary = await seeder._tickOnce();
    assert.deepEqual(enqueueCalls, [
      [['https://x.com/new'], 0],
      [['https://x.com/changed'], 1],
    ]);
    assert.equal(summary.enqueuedNew, 1);
    assert.equal(summary.enqueuedRefresh, 1);
  });

  it('idles without touching the lock when nothing is configured or enabled', async function () {
    const acquireLock = sinon.stub().resolves(true);
    seeder.start(makeServer(), makeDeps({ acquireLock }));
    let r = await seeder._tickOnce();
    assert.equal(r.reason, 'no-sitemaps');
    seeder.stop();
    seeder.start(
      makeServer(),
      makeDeps({
        acquireLock,
        getSitemapList: () =>
          Promise.resolve([{ id: 'a', url: 'https://x.com/s.xml', enabled: false }]),
      }),
    );
    r = await seeder._tickOnce();
    assert.equal(r.reason, 'no-sitemaps');
    assert.equal(acquireLock.callCount, 0);
  });

  it('idles when the last scan is fresh (not-due) without locking', async function () {
    const acquireLock = sinon.stub().resolves(true);
    seeder.start(
      makeServer(),
      makeDeps({
        acquireLock,
        getSitemapList: () => Promise.resolve([SM]),
        getLastScanAt: () => Promise.resolve(Date.now() - 1000),
      }),
    );
    const r = await seeder._tickOnce();
    assert.equal(r.reason, 'not-due');
    assert.equal(acquireLock.callCount, 0);
  });

  it('idles when another instance holds the scan lock', async function () {
    const fetch = sinon.stub().resolves(urlsetXml([]));
    seeder.start(
      makeServer(),
      makeDeps({
        fetch,
        getSitemapList: () => Promise.resolve([SM]),
        acquireLock: () => Promise.resolve(false),
      }),
    );
    const r = await seeder._tickOnce();
    assert.equal(r.reason, 'locked');
    assert.equal(fetch.callCount, 0);
  });

  it('re-checks the gate under the lock and yields a lost race', async function () {
    const gate = sinon.stub();
    gate.onFirstCall().resolves(null); // pre-lock: looks due
    gate.onSecondCall().resolves(Date.now()); // under the lock: someone just scanned
    const setLastScanAt = sinon.stub().resolves();
    const releaseLock = sinon.stub().resolves();
    const fetch = sinon.stub().resolves(urlsetXml([]));
    seeder.start(
      makeServer(),
      makeDeps({
        fetch,
        getSitemapList: () => Promise.resolve([SM]),
        getLastScanAt: gate,
        setLastScanAt,
        releaseLock,
      }),
    );
    const r = await seeder._tickOnce();
    assert.equal(r.reason, 'lost-race');
    assert.equal(fetch.callCount, 0);
    assert.equal(setLastScanAt.callCount, 0); // the loser never stamps the gate
    assert.equal(releaseLock.callCount, 1); // but always releases its lock
  });

  it('stamps the gate once at scan start and always releases the lock', async function () {
    const setLastScanAt = sinon.stub().resolves();
    const releaseLock = sinon.stub().resolves();
    seeder.start(
      makeServer(),
      makeDeps({
        fetch: () => Promise.resolve(urlsetXml([{ loc: 'https://x.com/a' }])),
        getSitemapList: () => Promise.resolve([SM]),
        setLastScanAt,
        releaseLock,
      }),
    );
    await seeder._tickOnce();
    assert.equal(setLastScanAt.callCount, 1);
    assert.equal(releaseLock.callCount, 1);
  });

  it('releases the lock even when every sitemap scan fails, and records the error', async function () {
    const releaseLock = sinon.stub().resolves();
    const recorded = [];
    seeder.start(
      makeServer(),
      makeDeps({
        fetch: () => Promise.reject(new Error('sitemap HTTP 503')),
        getSitemapList: () => Promise.resolve([SM]),
        releaseLock,
        recordStatus: (id, patch) => {
          recorded.push([id, patch]);
          return Promise.resolve();
        },
      }),
    );
    const summary = await seeder._tickOnce();
    assert.equal(summary.errors, 1);
    assert.equal(releaseLock.callCount, 1);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0][0], 'a1');
    assert.equal(recorded[0][1].lastError, 'sitemap HTTP 503');
    assert.ok(recorded[0][1].lastErrorAt > 0);
    // the failure patch must NOT clobber prior success stats
    assert.ok(!('urlsFound' in recorded[0][1]));
  });

  it('a failing sitemap does not stop the next one from scanning', async function () {
    const sms = [
      { id: 'bad', url: 'https://x.com/bad.xml', enabled: true },
      { id: 'good', url: 'https://x.com/good.xml', enabled: true },
    ];
    const map = { 'https://x.com/good.xml': urlsetXml([{ loc: 'https://x.com/a' }]) };
    const recorded = [];
    seeder.start(
      makeServer(),
      makeDeps({
        fetch: mapFetch(map),
        getSitemapList: () => Promise.resolve(sms),
        recordStatus: (id, patch) => {
          recorded.push([id, patch]);
          return Promise.resolve();
        },
      }),
    );
    const summary = await seeder._tickOnce();
    assert.equal(summary.errors, 1);
    assert.equal(summary.urlsFound, 1);
    const good = recorded.find(([id]) => id === 'good');
    assert.equal(good[1].urlsFound, 1);
    assert.equal(good[1].lastError, null); // a good scan clears the error
  });

  it('records a full success doc with counts and duration', async function () {
    const recorded = [];
    seeder.start(
      makeServer(),
      makeDeps({
        fetch: () =>
          Promise.resolve(
            urlsetXml([{ loc: 'https://x.com/a' }, { loc: 'https://x.com/b' }]),
          ),
        getSitemapList: () => Promise.resolve([SM]),
        recordStatus: (id, patch) => {
          recorded.push(patch);
          return Promise.resolve();
        },
      }),
    );
    await seeder._tickOnce();
    const doc = recorded[0];
    assert.equal(doc.urlsFound, 2);
    assert.equal(doc.enqueuedNew, 2);
    assert.equal(doc.enqueuedRefresh, 0);
    assert.ok(doc.lastScanAt > 0);
    assert.ok(doc.lastDurationMs >= 0);
    assert.equal(doc.lastError, null);
    assert.equal(doc.lastErrorAt, null);
  });

  it('prunes statuses for ALL configured ids (enabled + disabled) each scan', async function () {
    const prune = sinon.stub().resolves();
    const sms = [
      { id: 'on', url: 'https://x.com/on.xml', enabled: true },
      { id: 'off', url: 'https://x.com/off.xml', enabled: false },
    ];
    seeder.start(
      makeServer(),
      makeDeps({
        fetch: () => Promise.resolve(urlsetXml([])),
        getSitemapList: () => Promise.resolve(sms),
        pruneStatuses: prune,
      }),
    );
    await seeder._tickOnce();
    assert.deepEqual(prune.firstCall.args[0], ['on', 'off']);
  });

  it('skips disabled sitemaps but scans the enabled ones', async function () {
    const calls = [];
    const sms = [
      { id: 'on', url: 'https://x.com/on.xml', enabled: true },
      { id: 'off', url: 'https://x.com/off.xml', enabled: false },
    ];
    const map = {
      'https://x.com/on.xml': urlsetXml([{ loc: 'https://x.com/a' }]),
      'https://x.com/off.xml': urlsetXml([{ loc: 'https://x.com/zzz' }]),
    };
    seeder.start(
      makeServer(),
      makeDeps({
        fetch: mapFetch(map, calls),
        getSitemapList: () => Promise.resolve(sms),
      }),
    );
    const summary = await seeder._tickOnce();
    assert.deepEqual(calls, ['https://x.com/on.xml']);
    assert.equal(summary.sitemaps, 1);
  });

  it('returns {stopped:true} while shutting down and aborts an in-progress scan', async function () {
    const srv = makeServer();
    srv.isShuttingDown = true;
    seeder.start(srv, makeDeps({ getSitemapList: () => Promise.resolve([SM]) }));
    const r = await seeder._tickOnce();
    assert.ok(r.stopped);

    // mid-scan shutdown: the flag flips between diff batches -> the scan aborts,
    // already-enqueued work stands, the lock is released
    process.env.SEEDER_STATUS_BATCH = '1';
    const srv2 = makeServer();
    const enqueueCalls = [];
    const releaseLock = sinon.stub().resolves();
    seeder.stop();
    seeder.start(
      srv2,
      makeDeps({
        fetch: () =>
          Promise.resolve(
            urlsetXml([{ loc: 'https://x.com/a' }, { loc: 'https://x.com/b' }]),
          ),
        status: (urls) => {
          srv2.isShuttingDown = true; // flips after the first batch's diff
          return Promise.resolve(urls.map(() => ({ cached: false })));
        },
        enqueue: (urls, p) => {
          enqueueCalls.push([urls.slice(), p]);
          return Promise.resolve(urls.length);
        },
        getSitemapList: () => Promise.resolve([SM]),
        releaseLock,
      }),
    );
    const summary = await seeder._tickOnce();
    assert.equal(enqueueCalls.length, 1); // only the first batch made it
    assert.ok(summary.aborted);
    assert.equal(releaseLock.callCount, 1);
  });

  it('parses its env config with manager-parity defaults', function () {
    const cfg = seeder._parseConfig();
    assert.equal(cfg.intervalMs, 600000);
    assert.equal(cfg.tickMs, 60000);
    assert.equal(cfg.cooldownMs, 1000);
    assert.equal(cfg.lockTtlMs, 120000);
    assert.equal(cfg.fetchTimeoutMs, 30000);
    assert.equal(cfg.maxDepth, 4);
    assert.equal(cfg.statusBatch, 500);
    process.env.SEEDER_INTERVAL_MS = '60000';
    assert.equal(seeder._parseConfig().intervalMs, 60000);
  });
});
