import { spawn, spawnSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { cpus, totalmem, platform, release } from 'node:os';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { startSharedCache } from './shared-cache.mjs';

const sourceUrl = process.env.DATABASE_URL;
const k6Bin = process.env.K6_BIN || 'k6';
if (process.env.NODE_ENV !== 'test' || !sourceUrl) throw new Error('NODE_ENV=test and DATABASE_URL are required');
const source = new URL(sourceUrl);
if (!['localhost', '127.0.0.1'].includes(source.hostname)) throw new Error('Phase 3 is restricted to local PostgreSQL');
const loadUrl = new URL(source);
loadUrl.pathname = '/hourboard_loadtest';
const k6Version = spawnSync(k6Bin, ['version'], { encoding: 'utf8' });
if (k6Version.status !== 0) throw new Error('k6 CLI is required; set K6_BIN to its executable path');
const mode = process.env.PHASE3_MODE || 'full';
if (!['full', 'open-state-herd'].includes(mode)) throw new Error('Invalid Phase 3 mode');
if (mode === 'full' && process.env.PHASE3_RUN_ID) throw new Error('A full run must create a new result directory');
if (mode === 'open-state-herd' && !process.env.PHASE3_RUN_ID) throw new Error('Supplemental run requires PHASE3_RUN_ID');
const runId = process.env.PHASE3_RUN_ID || new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(runId)) throw new Error('Invalid Phase 3 run ID');
const root = `k6/results/phase3/${runId}`;
const admin = new pg.Pool({ connectionString: source.toString(), max: 2 });
let pool;
let monitorPool;
let app;
let cache;

function assert(condition, message) { if (!condition) throw new Error(message); }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower);
};
const round3 = value => value === null || value === undefined ? null : Math.round(value * 1000) / 1000;
async function save(path, data) {
  await mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + '\n');
}
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
async function until(action, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { if (await action()) return; } catch { /* 서비스 시작 대기 */ }
    await sleep(100);
  }
  throw new Error('Timed out waiting for service');
}
async function jsonGet(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  assert(response.ok, `GET failed: ${url} ${response.status}`);
  return response.json();
}
async function attempt(base, slotAt, message) {
  const startedAt = Date.now();
  const started = performance.now();
  try {
    const response = await fetch(`${base}/api/attempts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slotAt, message }), signal: AbortSignal.timeout(30000)
    });
    return { startedAt, elapsedMs: performance.now() - started, status: response.status, body: await response.json(), sentMessage: message };
  } catch (error) {
    return { startedAt, elapsedMs: performance.now() - started, status: null, body: null, sentMessage: message, error: String(error) };
  }
}
function classify(responses) {
  const accepted = [];
  const registrationClosed = [];
  const unexpected = [];
  for (const response of responses) {
    const body = response.body;
    if (response.status === 200 && ((body?.code === 'WINNER' && body.position === 1 && body.winner === true)
      || (body?.code === 'RANKED' && Number.isInteger(body.position) && body.position >= 2 && body.winner === false))) accepted.push(response);
    else if (response.status === 409 && body?.code === 'REGISTRATION_CLOSED' && body.position === null && body.winner === false) registrationClosed.push(response);
    else unexpected.push(response);
  }
  return { accepted, registrationClosed, unexpected };
}
async function checkIntegrity(base, slotAt, responses) {
  const groups = classify(responses);
  const positions = groups.accepted.map(item => item.body.position).sort((a, b) => a - b);
  const missing = Array.from({ length: positions.length }, (_, index) => index + 1).filter(position => !positions.includes(position));
  const duplicatePositions = positions.length - new Set(positions).size;
  const winners = groups.accepted.filter(item => item.body.code === 'WINNER');
  const dbRow = (await pool.query('SELECT winner_message, attempt_count, created_at FROM hour_slots WHERE slot_start = $1', [slotAt])).rows[0];
  const round = await jsonGet(`${base}/api/round`);
  const winnerMessageMutations = Number(!dbRow || winners.length !== 1 || dbRow.winner_message !== winners[0]?.sentMessage
    || round.currentSlot.message !== winners[0]?.sentMessage);
  const result = {
    requested: responses.length, accepted: groups.accepted.length, registrationClosed: groups.registrationClosed.length,
    unexpectedFailed: groups.unexpected.length, winnerCount: winners.length,
    minPosition: positions[0] ?? null, maxPosition: positions.at(-1) ?? null,
    duplicatePositions, missingPositions: missing.length, winnerMessageMutations,
    dbAttemptCount: dbRow ? Number(dbRow.attempt_count) : null,
    registrationClosedPositionConsumed: Number(dbRow && Number(dbRow.attempt_count) !== groups.accepted.length),
    registrationClosedWinnerTrue: groups.registrationClosed.filter(item => item.body.winner !== false).length,
    acceptanceRate: groups.accepted.length / responses.length,
    unexpectedErrorRate: groups.unexpected.length / responses.length,
    firstRegisteredAt: dbRow?.created_at.toISOString() ?? null,
    unexpectedResponses: groups.unexpected.map(item => ({ status: item.status, code: item.body?.code ?? null, error: item.error ?? null }))
  };
  assert(result.accepted >= 1 && result.winnerCount === 1 && result.duplicatePositions === 0
    && result.missingPositions === 0 && result.minPosition === 1 && result.maxPosition === result.accepted
    && result.winnerMessageMutations === 0 && result.registrationClosedPositionConsumed === 0
    && result.registrationClosedWinnerTrue === 0 && result.unexpectedFailed === 0, 'Winner/Position/Window integrity failed');
  return result;
}
async function monitor() {
  const samples = [];
  let busy = false;
  let stopped = false;
  const take = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const result = await monitorPool.query(`
        SELECT
          (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'active') AS active_connections,
          (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock') AS lock_waiting_connections,
          (SELECT count(*)::int FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE a.datname = current_database() AND NOT l.granted) AS ungranted_locks,
          (SELECT coalesce(jsonb_object_agg(wait_event_type, n), '{}'::jsonb) FROM
            (SELECT wait_event_type, count(*)::int AS n FROM pg_stat_activity
             WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type IS NOT NULL
             GROUP BY wait_event_type) events) AS wait_event_types
      `);
      samples.push({ at: new Date().toISOString(), ...result.rows[0] });
    } catch (error) { samples.push({ at: new Date().toISOString(), monitorError: String(error) }); }
    finally { busy = false; }
  };
  await take();
  const timer = setInterval(() => { void take(); }, 75);
  return async () => {
    clearInterval(timer);
    stopped = true;
    while (busy) await sleep(10);
    return {
      samplingIntervalMs: 75, sampleCount: samples.length,
      maxActiveConnections: Math.max(0, ...samples.map(x => x.active_connections ?? 0)),
      maxLockWaitingConnections: Math.max(0, ...samples.map(x => x.lock_waiting_connections ?? 0)),
      maxUngrantedLocks: Math.max(0, ...samples.map(x => x.ungranted_locks ?? 0)),
      samples
    };
  };
}
async function activeRound(base) {
  while (true) {
    const round = await jsonGet(`${base}/api/round`);
    const remaining = Date.parse(round.nextSlotAt) - Date.parse(round.serverTime);
    if (remaining >= 30000) return round;
    console.log(`Waiting ${Math.ceil(remaining / 1000)}s for safe next round`);
    await sleep(Math.min(30000, remaining + 300));
  }
}
async function resetRound(base) {
  const round = await activeRound(base);
  await pool.query('DELETE FROM hour_slots WHERE slot_start = $1', [round.currentSlot.startsAt]);
  const empty = await jsonGet(`${base}/api/open-state`);
  assert(empty.slotAt === round.currentSlot.startsAt && !empty.winnerExists && empty.registrationOpen
    && empty.registrationClosesAt === null, 'Round reset or open-state contract failed');
  return round.currentSlot.startsAt;
}
function metric(summary, name, key, fallback = null) { return summary.metrics?.[name]?.values?.[key] ?? fallback; }
async function runK6(script, env, summaryPath) {
  await mkdir(summaryPath.slice(0, summaryPath.lastIndexOf('/')), { recursive: true });
  const args = ['run', '--quiet'];
  for (const [key, value] of Object.entries({ ...env, SUMMARY_PATH: summaryPath })) args.push('-e', `${key}=${value}`);
  args.push(script);
  let output = '';
  const child = spawn(k6Bin, args, { cwd: process.cwd(), windowsHide: true });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  assert(code === 0, `k6 failed (${code}): ${output.slice(-2000)}`);
  let raw;
  try { raw = await readFile(summaryPath, 'utf8'); }
  catch { throw new Error(`k6 summary missing: ${summaryPath}; output: ${output.slice(-2000)}`); }
  return JSON.parse(raw);
}
function k6Measurements(summary) {
  return {
    requested: metric(summary, 'http_reqs', 'count', 0),
    accepted: metric(summary, 'phase3_accepted', 'count', 0),
    registrationClosed: metric(summary, 'phase3_registration_closed', 'count', 0),
    unexpectedFailed: metric(summary, 'phase3_unexpected_failed', 'count', 0),
    winnerCount: metric(summary, 'phase3_winner', 'count', 0),
    p50Ms: round3(metric(summary, 'http_req_duration', 'med')),
    p95Ms: round3(metric(summary, 'http_req_duration', 'p(95)')),
    p99Ms: round3(metric(summary, 'http_req_duration', 'p(99)')),
    minMs: round3(metric(summary, 'http_req_duration', 'min')),
    maxMs: round3(metric(summary, 'http_req_duration', 'max')),
    rps: round3(metric(summary, 'http_reqs', 'rate')),
    firstDispatchEpochMs: metric(summary, 'phase3_dispatch_epoch_ms', 'min'),
    lastDispatchEpochMs: metric(summary, 'phase3_dispatch_epoch_ms', 'max')
  };
}

async function checkWindow(base) {
  const slotAt = await resetRound(base);
  const first = await attempt(base, slotAt, 'phase3-window-first');
  assert(first.status === 200 && first.body.code === 'WINNER' && first.body.position === 1, 'First registration failed');
  const second = await attempt(base, slotAt, 'phase3-window-second');
  assert(second.status === 200 && second.body.code === 'RANKED' && second.body.position === 2, 'Follow-up registration failed');
  await sleep(Math.max(0, Date.parse(first.body.registrationClosesAt) - Date.now() + 50));
  const before = (await pool.query('SELECT attempt_count, winner_message FROM hour_slots WHERE slot_start = $1', [slotAt])).rows[0];
  const closed = await attempt(base, slotAt, 'phase3-window-closed');
  const after = (await pool.query('SELECT attempt_count, winner_message FROM hour_slots WHERE slot_start = $1', [slotAt])).rows[0];
  const openState = await jsonGet(`${base}/api/open-state`);
  const result = {
    slotAt, requested: 3, accepted: 2, registrationClosed: 1, unexpectedFailed: 0,
    winnerCount: 1, minPosition: 1, maxPosition: 2, duplicatePositions: 0, missingPositions: 0,
    winnerMessageMutations: Number(before.winner_message !== after.winner_message),
    closesAt: first.body.registrationClosesAt,
    closedStatus: closed.status, closedCode: closed.body?.code,
    closedPosition: closed.body?.position, closedWinner: closed.body?.winner,
    attemptCountBeforeClose: Number(before.attempt_count), attemptCountAfterClose: Number(after.attempt_count),
    openStateAfterClose: openState
  };
  assert(closed.status === 409 && closed.body.code === 'REGISTRATION_CLOSED' && closed.body.position === null
    && closed.body.winner === false && result.attemptCountBeforeClose === result.attemptCountAfterClose
    && result.winnerMessageMutations === 0 && !openState.registrationOpen && openState.winnerExists,
  'Registration Window check failed');
  await save(`${root}/registration-window.json`, result);
  return result;
}

async function raceStage(base, concurrency) {
  const label = String(concurrency).padStart(3, '0');
  const dir = `${root}/registration-race/concurrency-${label}`;
  const slotAt = await resetRound(base);
  const stopMonitor = await monitor();
  const started = performance.now();
  const responses = await Promise.all(Array.from({ length: concurrency }, (_, index) =>
    attempt(base, slotAt, `phase3-integrity-${label}-${String(index + 1).padStart(3, '0')}`)));
  const elapsedMs = performance.now() - started;
  const locks = await stopMonitor();
  const integrity = await checkIntegrity(base, slotAt, responses);
  Object.assign(integrity, {
    concurrency, slotAt, elapsedMs: round3(elapsedMs), rps: round3(concurrency / (elapsedMs / 1000)),
    p50Ms: round3(quantile(responses.map(x => x.elapsedMs), .5)),
    p95Ms: round3(quantile(responses.map(x => x.elapsedMs), .95)),
    p99Ms: round3(quantile(responses.map(x => x.elapsedMs), .99))
  });
  await save(`${dir}/integrity.json`, integrity);
  await save(`${dir}/postgres-locks-integrity.json`, locks);
  console.log(`Race integrity ${concurrency}: accepted ${integrity.accepted}, closed ${integrity.registrationClosed}`);

  const perfSlotAt = await resetRound(base);
  const summaryPath = `${dir}/k6-summary.json`;
  await mkdir(dir, { recursive: true });
  const stopPerfMonitor = await monitor();
  const summary = await runK6('k6/scenarios/phase3-race.js', {
    BASE_URL: base, CONCURRENCY: concurrency, SLOT_AT: perfSlotAt,
    MESSAGE_PREFIX: `phase3-race-${label}`, BARRIER_AT: Date.now() + 5000
  }, summaryPath);
  const perfLocks = await stopPerfMonitor();
  const perf = k6Measurements(summary);
  const row = (await pool.query('SELECT attempt_count, winner_message FROM hour_slots WHERE slot_start = $1', [perfSlotAt])).rows[0];
  Object.assign(perf, {
    concurrency, slotAt: perfSlotAt, acceptanceRate: perf.accepted / perf.requested,
    unexpectedErrorRate: perf.unexpectedFailed / perf.requested,
    dbAttemptCount: row ? Number(row.attempt_count) : null,
    winnerMessageValid: row?.winner_message?.startsWith(`phase3-race-${label}-vu-`) ?? false,
    dispatchSpreadMs: round3(perf.lastDispatchEpochMs - perf.firstDispatchEpochMs)
  });
  assert(perf.requested === concurrency && perf.accepted >= 1 && perf.winnerCount === 1
    && perf.requested === perf.accepted + perf.registrationClosed + perf.unexpectedFailed
    && perf.unexpectedFailed === 0 && perf.dbAttemptCount === perf.accepted && perf.winnerMessageValid,
  `k6 race ${concurrency} failed`);
  await save(`${dir}/performance.json`, perf);
  await save(`${dir}/postgres-locks.json`, perfLocks);
  console.log(`Race k6 ${concurrency}: accepted ${perf.accepted}, closed ${perf.registrationClosed}, p95 ${perf.p95Ms}ms`);
  return { integrity, performance: perf, contention: { integrity: locks, performance: perfLocks } };
}

async function openPollingStage(base, mode, clients) {
  const slotAt = await resetRound(base);
  if (mode === 'cached-polling') cache.clear();
  const target = mode === 'cached-polling' ? cache.url : base;
  const previousStats = mode === 'cached-polling' ? { ...cache.stats } : null;
  const path = `${root}/open-state/${mode}-${clients}.json`;
  const summaryPath = `${root}/open-state/${mode}-${clients}-k6-summary.json`;
  await mkdir(`${root}/open-state`, { recursive: true });
  const winnerPromise = new Promise(resolve => setTimeout(() => {
    void attempt(base, slotAt, `phase3-${mode}-${clients}-winner`).then(resolve);
  }, 3000));
  const summaryPromise = runK6('k6/scenarios/phase3-open-state.js', {
    BASE_URL: target, CLIENTS: clients, SLOT_AT: slotAt, DURATION_SECONDS: 20, POLL_INTERVAL_MS: 1000
  }, summaryPath);
  const [summary, winner] = await Promise.all([summaryPromise, winnerPromise]);
  assert(winner.status === 200 && winner.body.code === 'WINNER', `${mode} winner trigger failed`);
  const clientRequestCount = metric(summary, 'http_reqs', 'count', 0);
  const unexpectedFailed = metric(summary, 'phase3_unexpected_failed', 'count', 0);
  const originRequestCount = mode === 'cached-polling'
    ? cache.stats.originRequestCount - previousStats.originRequestCount : clientRequestCount;
  const cacheHitCount = mode === 'cached-polling' ? cache.stats.cacheHitCount - previousStats.cacheHitCount : 0;
  const cacheMissCount = mode === 'cached-polling' ? cache.stats.cacheMissCount - previousStats.cacheMissCount : clientRequestCount;
  const result = {
    mode, virtualClients: clients, pollIntervalMs: 1000, durationSeconds: 20, slotAt,
    clientRequestCount, originRequestCount, cacheHitCount, cacheMissCount,
    cacheCoalescedCount: mode === 'cached-polling' ? cache.stats.coalescedCount - previousStats.coalescedCount : 0,
    cacheSuppressionRatio: 1 - originRequestCount / clientRequestCount,
    originRps: round3(originRequestCount / 20),
    clientRps: round3(metric(summary, 'http_reqs', 'rate')),
    p50Ms: round3(metric(summary, 'http_req_duration', 'med')),
    p95Ms: round3(metric(summary, 'http_req_duration', 'p(95)')),
    p99Ms: round3(metric(summary, 'http_req_duration', 'p(99)')),
    unexpectedFailed, unexpectedErrorRate: unexpectedFailed / clientRequestCount,
    networkFailed: metric(summary, 'phase3_network_failed', 'count', 0),
    httpFailed: metric(summary, 'phase3_http_failed', 'count', 0),
    contractFailed: metric(summary, 'phase3_contract_failed', 'count', 0),
    wrongSlot: metric(summary, 'phase3_wrong_slot', 'count', 0),
    openDetectionDelayMs: {
      roundStart: null,
      winnerP50: round3(metric(summary, 'phase3_winner_detection_ms', 'med')),
      winnerP95: round3(metric(summary, 'phase3_winner_detection_ms', 'p(95)')),
      closeP50: round3(metric(summary, 'phase3_close_detection_ms', 'med')),
      closeP95: round3(metric(summary, 'phase3_close_detection_ms', 'p(95)'))
    },
    winnerDetectionSamples: metric(summary, 'phase3_winner_detection_count', 'count', 0),
    closeDetectionSamples: metric(summary, 'phase3_close_detection_count', 'count', 0),
    winnerClosesAt: winner.body.registrationClosesAt
  };
  assert(clientRequestCount > 0 && unexpectedFailed === 0 && result.winnerDetectionSamples > 0
    && result.closeDetectionSamples > 0 && (await jsonGet(`${base}/api/open-state`)).registrationOpen === false,
  `${mode} ${clients} detection failed`);
  if (mode === 'cached-polling') assert(cacheHitCount + cacheMissCount === clientRequestCount,
    'Shared-cache hit/miss accounting failed');
  await save(path, result);
  console.log(`${mode} ${clients}: client ${clientRequestCount}, origin ${originRequestCount}, close p50 ${result.openDetectionDelayMs.closeP50}ms`);
  return result;
}

async function waitForBoundary(target) {
  while (Date.now() < target - 7000) {
    const remaining = target - 7000 - Date.now();
    console.log(`Waiting ${Math.ceil(remaining / 1000)}s for actual Round boundary`);
    await sleep(Math.min(30000, remaining));
  }
}
async function roundBoundaryStage(base) {
  let round = await jsonGet(`${base}/api/round`);
  let boundary = Date.parse(round.nextSlotAt);
  if (boundary - Date.now() < 9000) boundary += 3_600_000;
  await waitForBoundary(boundary);
  round = await jsonGet(`${base}/api/round`);
  assert(Date.parse(round.nextSlotAt) === boundary, 'Round boundary changed before detector start');
  cache.clear();
  const before = { ...cache.stats };
  const summaryDirectPath = `${root}/open-state/round-boundary-direct-k6-summary.json`;
  const summaryCachedPath = `${root}/open-state/round-boundary-cached-k6-summary.json`;
  const initialSentAt = Date.now();
  const initial = await jsonGet(`${base}/api/round`);
  const initialReceivedAt = Date.now();
  const offsetMs = Date.parse(initial.serverTime) - (initialSentAt + initialReceivedAt) / 2;
  const estimatedWaitMs = Math.max(0, boundary - (Date.now() + offsetMs));
  const timer = (async () => {
    const start = performance.now();
    await sleep(estimatedWaitMs);
    const activatedAt = Date.now();
    let verificationRequestCount = 0;
    let verified;
    let immediateVerificationOpen = false;
    do {
      if (verificationRequestCount) await sleep(10);
      verified = await jsonGet(`${base}/api/open-state`);
      verificationRequestCount++;
      if (verificationRequestCount === 1) immediateVerificationOpen = verified.slotAt === new Date(boundary).toISOString();
    } while (verified.slotAt !== new Date(boundary).toISOString() && verificationRequestCount < 20);
    return {
      mode: 'client-timer', initialRequestCount: 1, verificationRequestCount,
      additionalPreBoundaryRequests: 0, initialRoundTripMs: initialReceivedAt - initialSentAt,
      offsetMs: round3(offsetMs), scheduledWaitMs: round3(estimatedWaitMs),
      actualWaitMs: round3(performance.now() - start), activatedAt: new Date(activatedAt).toISOString(),
      boundaryAt: new Date(boundary).toISOString(), activationClockErrorMs: round3(activatedAt - boundary),
      immediateVerificationOpen,
      verificationDelayMs: round3(Date.parse(verified.serverTime) - boundary),
      verificationOpen: verified.slotAt === new Date(boundary).toISOString() && verified.registrationOpen
    };
  })();
  const direct = runK6('k6/scenarios/phase3-open-state.js', {
    BASE_URL: base, CLIENTS: 1, SLOT_AT: round.currentSlot.startsAt,
    DURATION_SECONDS: 12, POLL_INTERVAL_MS: 1000, ALLOW_BOUNDARY: 1
  }, summaryDirectPath);
  const cached = runK6('k6/scenarios/phase3-open-state.js', {
    BASE_URL: cache.url, CLIENTS: 1, SLOT_AT: round.currentSlot.startsAt,
    DURATION_SECONDS: 12, POLL_INTERVAL_MS: 1000, ALLOW_BOUNDARY: 1
  }, summaryCachedPath);
  const [timerResult, directSummary, cachedSummary] = await Promise.all([timer, direct, cached]);
  const directDelay = metric(directSummary, 'phase3_round_detection_ms', 'med');
  const cachedDelay = metric(cachedSummary, 'phase3_round_detection_ms', 'med');
  const result = {
    boundaryAt: new Date(boundary).toISOString(), clientTimer: timerResult,
    directPolling: {
      virtualClients: 1, clientRequestCount: metric(directSummary, 'http_reqs', 'count', 0),
      originRequestCount: metric(directSummary, 'http_reqs', 'count', 0),
      roundStartDetectionDelayMs: round3(directDelay),
      unexpectedFailed: metric(directSummary, 'phase3_unexpected_failed', 'count', 0)
    },
    cachedPolling: {
      virtualClients: 1, clientRequestCount: metric(cachedSummary, 'http_reqs', 'count', 0),
      originRequestCount: cache.stats.originRequestCount - before.originRequestCount,
      cacheHitCount: cache.stats.cacheHitCount - before.cacheHitCount,
      cacheMissCount: cache.stats.cacheMissCount - before.cacheMissCount,
      roundStartDetectionDelayMs: round3(cachedDelay),
      unexpectedFailed: metric(cachedSummary, 'phase3_unexpected_failed', 'count', 0)
    }
  };
  assert(timerResult.verificationOpen && directDelay !== null && cachedDelay !== null
    && result.directPolling.unexpectedFailed === 0 && result.cachedPolling.unexpectedFailed === 0,
  'Actual Round boundary detection failed');
  await save(`${root}/open-state/round-boundary.json`, result);
  await save(`${root}/open-state/client-timer.json`, timerResult);
  console.log(`Actual Round boundary: timer ${timerResult.activationClockErrorMs}ms, direct ${round3(directDelay)}ms, cached ${round3(cachedDelay)}ms`);
  return result;
}

async function openStateHerdStage(base, concurrency) {
  const label = String(concurrency).padStart(3, '0');
  const dir = `${root}/open-state-herd/concurrency-${label}`;
  const slotAt = await resetRound(base);
  const stopMonitor = await monitor();
  const summary = await runK6('k6/scenarios/phase3-open-state-herd.js', {
    BASE_URL: base, CONCURRENCY: concurrency, SLOT_AT: slotAt, BARRIER_AT: Date.now() + 5000
  }, `${dir}/k6-summary.json`);
  const locks = await stopMonitor();
  const requested = metric(summary, 'http_reqs', 'count', 0);
  const accepted = metric(summary, 'phase3_open_state_accepted', 'count', 0);
  const unexpectedFailed = metric(summary, 'phase3_unexpected_failed', 'count', 0);
  const firstDispatch = metric(summary, 'phase3_dispatch_epoch_ms', 'min');
  const lastDispatch = metric(summary, 'phase3_dispatch_epoch_ms', 'max');
  const state = await jsonGet(`${base}/api/open-state`);
  const result = {
    measuredAt: new Date().toISOString(), concurrency, slotAt, requested, accepted, unexpectedFailed,
    originRequestCount: requested, dispatchSpreadMs: round3(lastDispatch - firstDispatch),
    p50Ms: round3(metric(summary, 'http_req_duration', 'med')),
    p95Ms: round3(metric(summary, 'http_req_duration', 'p(95)')),
    p99Ms: round3(metric(summary, 'http_req_duration', 'p(99)')),
    rps: round3(metric(summary, 'http_reqs', 'rate')),
    unexpectedErrorRate: unexpectedFailed / requested,
    stateAfterBurst: { slotAt: state.slotAt, winnerExists: state.winnerExists, registrationOpen: state.registrationOpen }
  };
  assert(requested === concurrency && accepted === concurrency && unexpectedFailed === 0
    && result.dispatchSpreadMs !== null && state.slotAt === slotAt
    && !state.winnerExists && state.registrationOpen, `Open-state herd ${concurrency} failed`);
  await save(`${dir}/performance.json`, result);
  await save(`${dir}/postgres-locks.json`, locks);
  console.log(`Open-state herd ${concurrency}: spread ${result.dispatchSpreadMs}ms, p95 ${result.p95Ms}ms`);
  return { performance: result, contention: locks };
}

async function herdStage(base, concurrency) {
  const label = String(concurrency).padStart(3, '0');
  const dir = `${root}/thundering-herd/concurrency-${label}`;
  const slotAt = await resetRound(base);
  const barrierAt = Date.now() + 3000;
  const stopMonitor = await monitor();
  const responses = await Promise.all(Array.from({ length: concurrency }, async (_, index) => {
    await sleep(Math.max(0, barrierAt - Date.now()));
    return attempt(base, slotAt, `phase3-herd-integrity-${label}-${String(index + 1).padStart(3, '0')}`);
  }));
  const locks = await stopMonitor();
  const integrity = await checkIntegrity(base, slotAt, responses);
  const first = Math.min(...responses.map(item => item.startedAt));
  const last = Math.max(...responses.map(item => item.startedAt));
  const end = Math.max(...responses.map(item => item.startedAt + item.elapsedMs));
  Object.assign(integrity, {
    concurrency, slotAt, barrierAt: new Date(barrierAt).toISOString(),
    firstDispatchAt: new Date(first).toISOString(), lastDispatchAt: new Date(last).toISOString(),
    dispatchSpreadMs: last - first, rps: round3(concurrency / ((end - first) / 1000)),
    p50Ms: round3(quantile(responses.map(x => x.elapsedMs), .5)),
    p95Ms: round3(quantile(responses.map(x => x.elapsedMs), .95)),
    p99Ms: round3(quantile(responses.map(x => x.elapsedMs), .99))
  });
  await save(`${dir}/integrity.json`, integrity);
  await save(`${dir}/postgres-locks-integrity.json`, locks);

  const perfSlotAt = await resetRound(base);
  const summaryPath = `${dir}/k6-summary.json`;
  await mkdir(dir, { recursive: true });
  const stopPerfMonitor = await monitor();
  const summary = await runK6('k6/scenarios/phase3-thundering-herd.js', {
    BASE_URL: base, CONCURRENCY: concurrency, SLOT_AT: perfSlotAt,
    MESSAGE_PREFIX: `phase3-herd-${label}`, BARRIER_AT: Date.now() + 5000
  }, summaryPath);
  const perfLocks = await stopPerfMonitor();
  const perf = k6Measurements(summary);
  const row = (await pool.query('SELECT attempt_count, winner_message FROM hour_slots WHERE slot_start = $1', [perfSlotAt])).rows[0];
  Object.assign(perf, {
    concurrency, slotAt: perfSlotAt, dispatchSpreadMs: round3(perf.lastDispatchEpochMs - perf.firstDispatchEpochMs),
    acceptanceRate: perf.accepted / perf.requested, unexpectedErrorRate: perf.unexpectedFailed / perf.requested,
    dbAttemptCount: row ? Number(row.attempt_count) : null,
    winnerMessageValid: row?.winner_message?.startsWith(`phase3-herd-${label}-vu-`) ?? false
  });
  assert(perf.requested === concurrency && perf.accepted >= 1 && perf.winnerCount === 1
    && perf.requested === perf.accepted + perf.registrationClosed + perf.unexpectedFailed
    && perf.unexpectedFailed === 0 && perf.dbAttemptCount === perf.accepted && perf.winnerMessageValid,
  `k6 herd ${concurrency} failed`);
  await save(`${dir}/performance.json`, perf);
  await save(`${dir}/postgres-locks.json`, perfLocks);
  console.log(`Herd ${concurrency}: spread ${perf.dispatchSpreadMs}ms, p95 ${perf.p95Ms}ms`);
  return { integrity, performance: perf, contention: { integrity: locks, performance: perfLocks } };
}

try {
  console.log(`Phase 3 run ${runId}`);
  const found = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', ['hourboard_loadtest']);
  if (!found.rowCount) await admin.query('CREATE DATABASE hourboard_loadtest');
  pool = new pg.Pool({ connectionString: loadUrl.toString(), max: 3 });
  monitorPool = new pg.Pool({ connectionString: loadUrl.toString(), max: 1 });
  await pool.query(await readFile('db/migrations/001_create_hour_slots.sql', 'utf8'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test', PORT: String(port), DATABASE_URL: loadUrl.toString() },
    stdio: 'ignore', windowsHide: true
  });
  await until(async () => {
    if (app.exitCode !== null) throw new Error('Fastify exited');
    return (await fetch(`${base}/health`)).ok;
  });
  const initialRound = await jsonGet(`${base}/api/round`);
  const initialOpenResponse = await fetch(`${base}/api/open-state`);
  assert(initialOpenResponse.ok && initialOpenResponse.headers.get('cache-control') === 'public, max-age=0, s-maxage=1',
    'Open-state cache contract mismatch');
  const initialOpen = await initialOpenResponse.json();
  assert(initialRound.currentSlot.startsAt === initialOpen.slotAt
    && initialOpen.roundEndsAt === initialRound.currentSlot.endsAt, 'Open-state contract mismatch');
  const dbVersion = (await pool.query('SHOW server_version')).rows[0].server_version;
  const environment = {
    measuredAt: new Date().toISOString(), target: 'local', os: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model ?? null, logicalCores: cpus().length, memoryBytes: totalmem(),
    nodeVersion: process.version, postgresVersion: dbVersion, k6Version: k6Version.stdout.trim(),
    dockerDesktop: 'not observed (Docker API inaccessible)', postgresContainerResourceLimit: null,
    database: 'hourboard_loadtest', databaseDisposition: 'retained', registrationWindowSeconds: 10,
    sharedCacheTtlMs: 1000, postgresSamplingIntervalMs: 75, apiBase: base
  };
  if (mode === 'open-state-herd') {
    const baseline = JSON.parse(await readFile(`${root}/baseline-summary.json`, 'utf8'));
    assert(baseline.openState?.roundBoundary && baseline.thunderingHerd?.length === 4,
      'A completed Phase 3 baseline is required for the supplemental run');
    const openStateHerd = [];
    for (const concurrency of [10, 50, 100, 200]) openStateHerd.push(await openStateHerdStage(base, concurrency));
    baseline.openState.herd = openStateHerd;
    await save(`${root}/baseline-summary.json`, baseline);
    console.log(`Phase 3 open-state herd passed: ${root}/baseline-summary.json`);
  } else {
    await save(`${root}/environment.json`, environment);
    const window = await checkWindow(base);
    const registrationRace = [];
    for (const concurrency of [10, 50, 100, 200]) registrationRace.push(await raceStage(base, concurrency));
    cache = await startSharedCache(base, 1000);
    const roundBoundary = await roundBoundaryStage(base);
    const directPolling = [];
    for (const clients of [100, 500, 1000]) directPolling.push(await openPollingStage(base, 'direct-polling', clients));
    const cachedPolling = [];
    for (const clients of [100, 500, 1000]) cachedPolling.push(await openPollingStage(base, 'cached-polling', clients));
    await cache.close();
    cache = null;
    const openStateHerd = [];
    for (const concurrency of [10, 50, 100, 200]) openStateHerd.push(await openStateHerdStage(base, concurrency));
    const thunderingHerd = [];
    for (const concurrency of [10, 50, 100, 200]) thunderingHerd.push(await herdStage(base, concurrency));
    const baseline = {
      environment, registrationWindow: window, registrationRace,
      openState: { clientTimer: roundBoundary.clientTimer, roundBoundary, directPolling, cachedPolling, herd: openStateHerd },
      thunderingHerd
    };
    await save(`${root}/baseline-summary.json`, baseline);
    console.log(`Phase 3 passed: ${root}/baseline-summary.json`);
  }
} finally {
  if (cache) await cache.close();
  if (app && app.exitCode === null) app.kill();
  if (monitorPool) await monitorPool.end();
  if (pool) await pool.end();
  await admin.end();
}
