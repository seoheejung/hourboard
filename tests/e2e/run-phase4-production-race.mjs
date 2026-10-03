import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const base = process.env.PRODUCTION_BASE_URL;
const targetSlotAt = process.env.TARGET_SLOT_AT;
const network = process.env.PRODUCTION_NETWORK ?? 'lan';
const requested = Number(process.env.RACE_REQUESTS ?? 100);
const mode = process.env.RACE_MODE ?? 'next';
if (base !== 'https://hourboard.duckdns.org' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/.test(targetSlotAt ?? '') ||
    !['lan', 'external'].includes(network) ||
    !Number.isInteger(requested) || requested < 2 || requested > 100 ||
    !['current', 'next'].includes(mode)) {
  throw new Error('Production race E2E requires production URL, target UTC hour, and valid network vantage');
}

const path = network === 'external'
  ? 'tests/e2e/artifacts/phase4-production-external-race-window-latency.json'
  : 'tests/e2e/artifacts/phase4-production-race-window-latency.json';
const artifact = {
  scenario: mode === 'next'
    ? 'production-hour-boundary-race-window-latency'
    : 'production-current-round-race-window-latency',
  startedAt: new Date().toISOString(), targetSlotAt, mode,
  measurementVantage: network === 'external'
    ? 'work PC via user-confirmed external network'
    : 'work PC LAN via public HTTPS origin',
  race: { requested, succeeded: 0, failed: requested, winnerCount: 0,
    minPosition: null, maxPosition: null, duplicatePositions: null,
    missingPositions: null, winnerMessageMutations: null },
  checks: {}
};

function check(name, condition) {
  artifact.checks[name] = Boolean(condition);
  if (!condition) throw new Error(`Production race E2E failed: ${name}`);
}

async function round() {
  const response = await fetch(`${base}/api/round`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  if (response.status !== 200) throw new Error(`GET /api/round returned ${response.status}`);
  return response.json();
}

async function attempt(slotAt, message) {
  const started = performance.now();
  try {
    const response = await fetch(`${base}/api/attempts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slotAt, message }), signal: AbortSignal.timeout(10_000)
    });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = null; }
    return { status: response.status, body, latencyMs: performance.now() - started, sentMessage: message };
  } catch (error) {
    return { status: null, body: null, latencyMs: performance.now() - started,
      sentMessage: message, error: String(error) };
  }
}

function latency(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const value = fraction => Math.round(sorted[Math.ceil(sorted.length * fraction) - 1] * 100) / 100;
  return { sampleCount: sorted.length, p50Ms: value(0.5), p95Ms: value(0.95), p99Ms: value(0.99) };
}

try {
  const before = await round();
  if (mode === 'next') {
    check('target is the next Production hour', before.nextSlotAt === targetSlotAt &&
      Date.parse(before.serverTime) < Date.parse(targetSlotAt));
  } else {
    check('target is the current open Production hour without a winner',
      before.currentSlot.startsAt === targetSlotAt &&
      before.currentSlot.registrationOpen === true && before.currentSlot.message === null);
  }
  const future = await attempt(mode === 'current' ? before.nextSlotAt : targetSlotAt,
    'HourBoard future slot check');
  check('future slot is rejected before the hour', future.status === 425 &&
    future.body?.code === 'ROUND_NOT_STARTED');
  const previousSlotAt = new Date(Date.parse(before.currentSlot.startsAt) - 3_600_000).toISOString();
  const ended = await attempt(previousSlotAt, 'HourBoard ended slot check');
  check('ended slot is rejected', ended.status === 409 && ended.body?.code === 'ROUND_ENDED');

  let opened;
  if (mode === 'next') {
    while (Date.now() < Date.parse(targetSlotAt)) {
      await new Promise(resolve => setTimeout(resolve, Math.min(30_000, Date.parse(targetSlotAt) - Date.now())));
    }
    for (let index = 0; index < 100; index++) {
      opened = await round();
      if (opened.currentSlot.startsAt === targetSlotAt) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    check('current slot opens at the hour boundary', opened.currentSlot.startsAt === targetSlotAt &&
      opened.currentSlot.message === null && opened.currentSlot.registrationOpen === true);
  } else {
    opened = await round();
    check('current slot remains open before race', opened.currentSlot.startsAt === targetSlotAt &&
      opened.currentSlot.message === null && opened.currentSlot.registrationOpen === true);
  }
  artifact.raceStartedAt = new Date().toISOString();
  const responses = await Promise.all(Array.from({ length: artifact.race.requested }, (_, index) =>
    attempt(targetSlotAt, `HourBoard production race ${index}`)));
  const accepted = responses.filter(item => item.status === 200 &&
    ['WINNER', 'RANKED'].includes(item.body?.code));
  const followup = await attempt(targetSlotAt, 'HourBoard production window followup');
  artifact.windowFollowup = { status: followup.status, code: followup.body?.code ?? null,
    position: followup.body?.position ?? null };
  check('followup within ten seconds is ranked', followup.status === 200 &&
    followup.body?.code === 'RANKED');
  accepted.push(followup);
  const positions = accepted.map(item => item.body.position).sort((a, b) => a - b);
  const winner = accepted.find(item => item.body.code === 'WINNER');
  const after = await round();
  artifact.race.succeeded = responses.filter(item => item.status === 200).length;
  artifact.race.failed = artifact.race.requested - artifact.race.succeeded;
  artifact.race.followupRequested = 1;
  artifact.race.totalRequested = artifact.race.requested + artifact.race.followupRequested;
  artifact.race.totalSucceeded = accepted.length;
  artifact.race.statusCounts = Object.fromEntries([...new Set(responses.map(item => String(item.status)))].map(code =>
    [code, responses.filter(item => String(item.status) === code).length]));
  artifact.race.winnerCount = accepted.filter(item => item.body.code === 'WINNER').length;
  artifact.race.minPosition = positions[0] ?? null;
  artifact.race.maxPosition = positions.at(-1) ?? null;
  artifact.race.duplicatePositions = positions.length - new Set(positions).size;
  artifact.race.missingPositions = artifact.race.maxPosition - artifact.race.minPosition + 1 - new Set(positions).size;
  artifact.race.winnerMessageMutations = Number(after.currentSlot.message !== winner?.sentMessage);
  artifact.postLatency = latency(accepted.map(item => item.latencyMs));
  check('Production winner and rank invariants', artifact.race.succeeded >= 1 &&
    artifact.race.winnerCount === 1 && artifact.race.minPosition === 1 &&
    artifact.race.maxPosition === accepted.length && artifact.race.duplicatePositions === 0 &&
    artifact.race.missingPositions === 0 && artifact.race.winnerMessageMutations === 0 &&
    after.currentSlot.attemptCount === accepted.length);

  const closesAt = Date.parse(after.currentSlot.registrationClosesAt);
  if (Date.now() < closesAt + 100) {
    await new Promise(resolve => setTimeout(resolve, closesAt + 100 - Date.now()));
  }
  const countBeforeLate = (await round()).currentSlot.attemptCount;
  const late = await attempt(targetSlotAt, 'HourBoard production late check');
  const afterLate = await round();
  artifact.late = { status: late.status, code: late.body?.code ?? null,
    position: late.body?.position ?? null, countBefore: countBeforeLate,
    countAfter: afterLate.currentSlot.attemptCount };
  check('late registration is closed without consuming a position', late.status === 409 &&
    late.body?.code === 'REGISTRATION_CLOSED' && late.body.position === null &&
    countBeforeLate === afterLate.currentSlot.attemptCount &&
    afterLate.currentSlot.message === winner.sentMessage);

  const getSamples = [];
  for (let index = 0; index < 40; index++) {
    const started = performance.now();
    await round();
    getSamples.push(performance.now() - started);
  }
  artifact.getRoundLatency = latency(getSamples);
  console.log(`Production ${mode} round race, window, and latency E2E passed`);
} catch (error) {
  artifact.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.error(artifact.error);
} finally {
  artifact.finishedAt = new Date().toISOString();
  await mkdir('tests/e2e/artifacts', { recursive: true });
  await writeFile(path, JSON.stringify(artifact, null, 2) + '\n');
}
