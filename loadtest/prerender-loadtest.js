#!/usr/bin/env node
'use strict';

/*
 * prerender-loadtest.js
 * ---------------------------------------------------------------------------
 * A zero-dependency (http/https only) load generator for a self-hosted
 * Prerender server. It drives concurrent GET /render?url=<target> requests at
 * a series of increasing concurrency "steps", holds each step for a fixed
 * duration, and reports per step:
 *
 *   - success rate (2xx)
 *   - p50 / p95 / p99 latency (ms, full round trip incl. render)
 *   - count of 429s (server shed load at MAX_CONCURRENT_RENDERS)
 *   - count of 504s / other errors (render failures, timeouts, resets)
 *   - throughput (renders/min, counting only successful renders)
 *
 * It then prints a "knee" analysis to help pick MAX_CONCURRENT_RENDERS and a
 * DigitalOcean App Platform autoscale CPU target.
 *
 * Matches the real server contract in lib/server.js / lib/plugins/tokenAuth.js:
 *   429 + Retry-After  -> at the concurrency cap (MAX_CONCURRENT_RENDERS)
 *   503                -> draining / not ready (graceful shutdown, scale-down)
 *   504                -> render error / page load timeout (renderErrorStatusCode)
 *   403                -> bad/missing X-Prerender-Token
 *
 * USAGE
 *   node prerender-loadtest.js \
 *     --base   http://127.0.0.1:3000 \
 *     --target https://example.com/ \
 *     --token  YOUR_PRERENDER_TOKEN              (optional) \
 *     --steps  1,2,3,4,6,8,12                    (concurrency levels) \
 *     --hold   60                                (seconds held per step) \
 *     --warmup 1                                 (warmup renders before step 1) \
 *     --timeout 60                               (per-request timeout, seconds) \
 *     --cooldown 5                               (idle seconds between steps) \
 *     --json   results.json                      (optional: dump raw results)
 *
 * Or via environment variables (CLI flags win):
 *   BASE, TARGET, TOKEN, STEPS, HOLD, WARMUP, TIMEOUT, COOLDOWN, JSON_OUT
 *
 * SELF-CHECK (no server needed, validates the harness math/parsing):
 *   node prerender-loadtest.js --selfcheck
 * ---------------------------------------------------------------------------
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Arg parsing (no deps)
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true; // boolean flag
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

function pick(name, envName, def) {
  if (args[name] !== undefined) return args[name];
  if (process.env[envName] !== undefined) return process.env[envName];
  return def;
}

const CONFIG = {
  base: String(pick('base', 'BASE', 'http://127.0.0.1:3000')).replace(/\/+$/, ''),
  target: String(pick('target', 'TARGET', 'https://example.com/')),
  token: pick('token', 'TOKEN', ''),
  steps: String(pick('steps', 'STEPS', '1,2,3,4,6,8,12'))
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0),
  holdSeconds: parseInt(pick('hold', 'HOLD', '60'), 10),
  warmup: parseInt(pick('warmup', 'WARMUP', '1'), 10),
  timeoutSeconds: parseInt(pick('timeout', 'TIMEOUT', '60'), 10),
  cooldownSeconds: parseInt(pick('cooldown', 'COOLDOWN', '5'), 10),
  jsonOut: pick('json', 'JSON_OUT', ''),
};

// ---------------------------------------------------------------------------
// Percentile helper (nearest-rank, linear-interpolation free, robust)
// ---------------------------------------------------------------------------
function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  // nearest-rank: rank = ceil(p/100 * N), 1-indexed
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[idx];
}

function fmt(n, digits = 1) {
  if (!Number.isFinite(n)) return '0';
  return n.toFixed(digits);
}

// ---------------------------------------------------------------------------
// Single render request -> resolves with { status, ms, ok, is429, is503,
// is504, isError, errKind }
// ---------------------------------------------------------------------------
function doRender(cfg) {
  return new Promise((resolve) => {
    const url = new URL(cfg.base + '/render');
    url.searchParams.set('url', cfg.target);

    const lib = url.protocol === 'https:' ? https : http;
    const start = process.hrtime.bigint();

    const headers = { Accept: 'text/html', Connection: 'close' };
    if (cfg.token) headers['X-Prerender-Token'] = cfg.token;

    const reqOpts = {
      method: 'GET',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers,
    };

    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      resolve(Object.assign({ ms }, res));
    };

    const req = lib.request(reqOpts, (res) => {
      const status = res.statusCode;
      // Drain the body so the socket can close cleanly; we don't keep it.
      res.on('data', () => {});
      res.on('end', () => {
        finish({
          status,
          ok: status >= 200 && status < 300,
          is429: status === 429,
          is503: status === 503,
          is504: status === 504,
          isError: !(status >= 200 && status < 300),
          errKind: status >= 200 && status < 300 ? null : 'http_' + status,
        });
      });
      res.on('error', () => {
        finish({
          status: status || 0,
          ok: false,
          is429: false,
          is503: false,
          is504: false,
          isError: true,
          errKind: 'res_stream_error',
        });
      });
    });

    req.setTimeout(cfg.timeoutSeconds * 1000, () => {
      req.destroy(new Error('timeout'));
    });

    req.on('error', (err) => {
      const kind =
        err && err.message === 'timeout'
          ? 'client_timeout'
          : 'conn_' + (err && err.code ? err.code : 'error');
      finish({
        status: 0,
        ok: false,
        is429: false,
        is503: false,
        is504: false,
        isError: true,
        errKind: kind,
      });
    });

    req.end();
  });
}

// ---------------------------------------------------------------------------
// Run one concurrency step: keep exactly `concurrency` requests in flight for
// `holdSeconds`. A new request is launched the instant a slot frees up
// (closed-loop / constant-concurrency model, which is how a crawler hammers
// a render server). Returns aggregated stats for the step.
// ---------------------------------------------------------------------------
function runStep(cfg, concurrency, holdSeconds) {
  return new Promise((resolve) => {
    const stepStart = Date.now();
    const deadline = stepStart + holdSeconds * 1000;

    const latencies = [];
    const errKinds = {};
    let completed = 0;
    let success = 0;
    let c429 = 0;
    let c503 = 0;
    let c504 = 0;
    let otherErr = 0;
    let inFlight = 0;
    let stopping = false;

    const maybeDone = () => {
      if (stopping && inFlight === 0) {
        latencies.sort((a, b) => a - b);
        const wallSeconds = (Date.now() - stepStart) / 1000;
        const rendersPerMin = wallSeconds > 0 ? (success / wallSeconds) * 60 : 0;
        resolve({
          concurrency,
          holdSeconds,
          wallSeconds,
          completed,
          success,
          successRate: completed > 0 ? success / completed : 0,
          p50: percentile(latencies, 50),
          p95: percentile(latencies, 95),
          p99: percentile(latencies, 99),
          c429,
          c503,
          c504,
          otherErr,
          rendersPerMin,
          errKinds,
        });
      }
    };

    const launch = () => {
      if (Date.now() >= deadline) {
        stopping = true;
        maybeDone();
        return;
      }
      inFlight++;
      doRender(cfg).then((r) => {
        inFlight--;
        completed++;
        if (r.ok) {
          success++;
          latencies.push(r.ms);
        } else if (r.is429) {
          c429++;
        } else if (r.is503) {
          c503++;
        } else if (r.is504) {
          c504++;
        } else {
          otherErr++;
        }
        if (r.errKind) errKinds[r.errKind] = (errKinds[r.errKind] || 0) + 1;
        // Refill the slot.
        launch();
        maybeDone();
      });
    };

    // Prime `concurrency` parallel workers.
    for (let i = 0; i < concurrency; i++) launch();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
function printHeader(cfg) {
  console.log('='.repeat(78));
  console.log('Prerender load test');
  console.log('  base     :', cfg.base);
  console.log('  target   :', cfg.target);
  console.log('  token    :', cfg.token ? '(set)' : '(none)');
  console.log('  steps    :', cfg.steps.join(', '));
  console.log('  hold     :', cfg.holdSeconds + 's per step');
  console.log('  timeout  :', cfg.timeoutSeconds + 's per request');
  console.log('  cooldown :', cfg.cooldownSeconds + 's between steps');
  console.log('='.repeat(78));
  console.log(
    [
      'conc'.padStart(4),
      'done'.padStart(6),
      'succ%'.padStart(6),
      'p50ms'.padStart(8),
      'p95ms'.padStart(9),
      'p99ms'.padStart(9),
      '429'.padStart(5),
      '504'.padStart(5),
      '503'.padStart(5),
      'errOther'.padStart(8),
      'rend/min'.padStart(9),
    ].join(' '),
  );
  console.log('-'.repeat(78));
}

function printRow(s) {
  console.log(
    [
      String(s.concurrency).padStart(4),
      String(s.completed).padStart(6),
      fmt(s.successRate * 100, 1).padStart(6),
      fmt(s.p50, 0).padStart(8),
      fmt(s.p95, 0).padStart(9),
      fmt(s.p99, 0).padStart(9),
      String(s.c429).padStart(5),
      String(s.c504).padStart(5),
      String(s.c503).padStart(5),
      String(s.otherErr).padStart(8),
      fmt(s.rendersPerMin, 1).padStart(9),
    ].join(' '),
  );
}

// ---------------------------------------------------------------------------
// Knee detection.
// The "knee" is the lowest concurrency at which the server stops scaling
// gracefully. We flag a step as "past the knee" when, relative to the best
// prior step, ANY of:
//   - p95 latency more than ~1.8x the best-so-far p95, OR
//   - error rate (non-2xx, EXCLUDING 429 which is intentional load-shedding)
//     exceeds 2%, OR
//   - throughput (renders/min) drops below the previous step's throughput
//     (adding concurrency stopped buying you renders -> saturated).
// 429s are treated as the server *working as designed*: once you see 429s,
// MAX_CONCURRENT_RENDERS on the box is already lower than your offered load.
// ---------------------------------------------------------------------------
function analyzeKnee(steps) {
  let bestP95 = Infinity;
  let prevThroughput = 0;
  let kneeIdx = -1;
  const notes = [];

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const hardErrRate =
      s.completed > 0 ? (s.c504 + s.c503 + s.otherErr) / s.completed : 0;
    const p95Spike = s.p95 > bestP95 * 1.8 && bestP95 !== Infinity;
    const errSpike = hardErrRate > 0.02;
    const throughputRegressed =
      i > 0 && s.rendersPerMin < prevThroughput * 0.98;
    const shedding = s.c429 > 0;

    const reasons = [];
    if (p95Spike) reasons.push(`p95 ${fmt(s.p95, 0)}ms > 1.8x best (${fmt(bestP95, 0)}ms)`);
    if (errSpike) reasons.push(`hard-error rate ${fmt(hardErrRate * 100, 1)}% > 2%`);
    if (throughputRegressed)
      reasons.push(
        `throughput regressed ${fmt(s.rendersPerMin, 1)} < prev ${fmt(prevThroughput, 1)}`,
      );
    if (shedding) reasons.push(`server shedding load: ${s.c429} x 429`);

    if ((p95Spike || errSpike || throughputRegressed || shedding) && kneeIdx === -1) {
      kneeIdx = i;
    }
    if (reasons.length) {
      notes.push(`  conc=${s.concurrency}: ${reasons.join('; ')}`);
    }

    if (s.p95 < bestP95) bestP95 = s.p95;
    prevThroughput = s.rendersPerMin;
  }

  return { kneeIdx, notes };
}

function printAnalysis(steps) {
  const { kneeIdx, notes } = analyzeKnee(steps);
  console.log('');
  console.log('='.repeat(78));
  console.log('KNEE ANALYSIS');
  console.log('='.repeat(78));

  if (notes.length === 0) {
    console.log('No knee detected across the tested steps. The server scaled');
    console.log('gracefully through the highest concurrency you tried. Re-run');
    console.log('with higher --steps (e.g. add 16,24,32) to actually find the limit.');
    const top = steps[steps.length - 1];
    console.log('');
    console.log(`Highest tested concurrency = ${top.concurrency} was still healthy`);
    console.log(`(p95=${fmt(top.p95, 0)}ms, succ=${fmt(top.successRate * 100, 1)}%).`);
    return;
  }

  console.log('Signals observed:');
  notes.forEach((n) => console.log(n));

  if (kneeIdx === -1) {
    console.log('\nNo clean knee index (signals were ambiguous). Inspect the table.');
    return;
  }

  const kneeStep = steps[kneeIdx];
  const safeStep = kneeIdx > 0 ? steps[kneeIdx - 1] : steps[0];

  console.log('');
  console.log(`KNEE at concurrency = ${kneeStep.concurrency}`);
  console.log(`Last healthy concurrency = ${safeStep.concurrency}`);
  console.log('');

  // Translate to MAX_CONCURRENT_RENDERS: sit just BELOW the knee. Use the last
  // healthy step. If the knee is at the very first step, the box can barely do
  // 1 render at a time -> set to 1 and scale OUT, not up.
  const recommendedMax = Math.max(1, safeStep.concurrency);
  console.log('RECOMMENDED SETTINGS');
  console.log(`  MAX_CONCURRENT_RENDERS = ${recommendedMax}`);
  console.log('    (just below the knee; the server returns 429 + Retry-After');
  console.log('     beyond this, so Googlebot backs off instead of OOMing Chrome)');
  console.log('');

  // DO autoscale CPU target: pick a target that triggers a scale-out BEFORE a
  // single box reaches its knee. At the last-healthy concurrency the box is
  // near full useful load; we want to add a replica before that. A 60-70% CPU
  // target leaves headroom for the spike between scale decisions.
  console.log('  DigitalOcean App Platform autoscale:');
  console.log('    cpu_target_percent = 60   (scale OUT at 60% avg CPU)');
  console.log('    min_instance_count = 2    (no cold-start gap; survive 1 box dying)');
  console.log('    max_instance_count = size for peak_offered_concurrency / MAX_CONCURRENT_RENDERS');
  console.log('');
  console.log('  Rationale: each box safely serves ~' + recommendedMax + ' concurrent renders.');
  console.log('    Needed boxes = ceil(peak_concurrent_renders / ' + recommendedMax + ').');
  console.log('    A 60% CPU target fires the scale-out with enough headroom that');
  console.log('    in-flight renders finish before the box crosses its knee.');
}

// ---------------------------------------------------------------------------
// Self-check: validate percentile + knee math without a live server.
// ---------------------------------------------------------------------------
function selfCheck() {
  let failures = 0;
  const assert = (cond, msg) => {
    if (!cond) {
      failures++;
      console.error('FAIL:', msg);
    } else {
      console.log('ok  :', msg);
    }
  };

  // percentile
  const arr = [];
  for (let i = 1; i <= 100; i++) arr.push(i); // 1..100 sorted
  assert(percentile(arr, 50) === 50, 'p50 of 1..100 == 50');
  assert(percentile(arr, 95) === 95, 'p95 of 1..100 == 95');
  assert(percentile(arr, 99) === 99, 'p99 of 1..100 == 99');
  assert(percentile([], 95) === 0, 'p95 of empty == 0');
  assert(percentile([42], 99) === 42, 'p99 of single == that value');

  // knee: throughput regresses + p95 spikes at conc=8
  const fakeSteps = [
    { concurrency: 1, completed: 60, success: 60, successRate: 1, p50: 1000, p95: 1200, p99: 1300, c429: 0, c503: 0, c504: 0, otherErr: 0, rendersPerMin: 60, errKinds: {} },
    { concurrency: 2, completed: 120, success: 120, successRate: 1, p50: 1000, p95: 1250, p99: 1400, c429: 0, c503: 0, c504: 0, otherErr: 0, rendersPerMin: 120, errKinds: {} },
    { concurrency: 4, completed: 230, success: 230, successRate: 1, p50: 1100, p95: 1400, p99: 1600, c429: 0, c503: 0, c504: 0, otherErr: 0, rendersPerMin: 230, errKinds: {} },
    { concurrency: 8, completed: 240, success: 200, successRate: 0.83, p50: 2500, p95: 9000, p99: 15000, c429: 0, c503: 0, c504: 40, otherErr: 0, rendersPerMin: 200, errKinds: { http_504: 40 } },
  ];
  const { kneeIdx } = analyzeKnee(fakeSteps);
  assert(kneeIdx === 3, 'knee detected at index 3 (conc=8)');

  // knee via 429 shedding
  const sheddingSteps = [
    { concurrency: 1, completed: 60, success: 60, successRate: 1, p50: 1000, p95: 1200, p99: 1300, c429: 0, c503: 0, c504: 0, otherErr: 0, rendersPerMin: 60, errKinds: {} },
    { concurrency: 4, completed: 200, success: 150, successRate: 0.75, p50: 1100, p95: 1500, p99: 1700, c429: 50, c503: 0, c504: 0, otherErr: 0, rendersPerMin: 150, errKinds: { http_429: 50 } },
  ];
  const r2 = analyzeKnee(sheddingSteps);
  assert(r2.kneeIdx === 1, 'knee detected at index 1 via 429 shedding');

  console.log('');
  if (failures === 0) {
    console.log('SELF-CHECK PASSED');
    process.exit(0);
  } else {
    console.log('SELF-CHECK FAILED:', failures, 'failure(s)');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (args.selfcheck) {
    selfCheck();
    return;
  }

  if (!CONFIG.steps.length) {
    console.error('No valid --steps provided.');
    process.exit(1);
  }

  printHeader(CONFIG);

  // Warmup: prime Chrome (first render after browser start is slow) so step 1
  // numbers reflect steady state, not cold start.
  if (CONFIG.warmup > 0) {
    process.stdout.write(`warming up (${CONFIG.warmup} render(s))... `);
    for (let i = 0; i < CONFIG.warmup; i++) {
      const r = await doRender(CONFIG);
      process.stdout.write(r.ok ? 'ok ' : `[${r.status || r.errKind}] `);
    }
    console.log('');
    console.log('-'.repeat(78));
  }

  const results = [];
  for (let i = 0; i < CONFIG.steps.length; i++) {
    const c = CONFIG.steps[i];
    const s = await runStep(CONFIG, c, CONFIG.holdSeconds);
    results.push(s);
    printRow(s);
    if (i < CONFIG.steps.length - 1 && CONFIG.cooldownSeconds > 0) {
      await sleep(CONFIG.cooldownSeconds * 1000);
    }
  }

  printAnalysis(results);

  if (CONFIG.jsonOut) {
    try {
      fs.writeFileSync(
        CONFIG.jsonOut,
        JSON.stringify({ config: CONFIG, results }, null, 2),
      );
      console.log('\nRaw results written to', CONFIG.jsonOut);
    } catch (e) {
      console.error('Failed to write JSON output:', e.message);
    }
  }
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
