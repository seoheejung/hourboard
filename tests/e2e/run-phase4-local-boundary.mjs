import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import pg from 'pg';

const scenario = process.argv[2];
assert.ok(scenario === 'window' || scenario === 'hour', 'Usage: node tests/e2e/run-phase4-local-boundary.mjs window|hour');
const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, 'DATABASE_URL is required');
assert.equal(new URL(databaseUrl).pathname, '/hourboard_phase4_gate', 'Dedicated gate database required');
const base = process.env.GATE_BASE_URL ?? 'http://127.0.0.1:3101';
const pool = new pg.Pool({ connectionString: databaseUrl });
const waitUntil = async timestamp => {
  const delay = timestamp - Date.now();
  if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
};
const readJson = async response => ({ status: response.status, body: await response.json() });
const getRound = async () => readJson(await fetch(`${base}/api/round`, { signal: AbortSignal.timeout(15_000) }));
const post = async (slotAt, message) => readJson(await fetch(`${base}/api/attempts`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ slotAt, message }), signal: AbortSignal.timeout(15_000)
}));
let lockClient;
let lockHeld = false;
const artifact = { scenario, startedAt: new Date().toISOString(), base, database: 'hourboard_phase4_gate' };

try {
  const db = await pool.query('SELECT current_database() AS name, clock_timestamp() AS db_time');
  assert.equal(db.rows[0].name, 'hourboard_phase4_gate');
  artifact.initialDatabaseTime = db.rows[0].db_time.toISOString();

  if (scenario === 'window') {
    await pool.query('TRUNCATE hour_slots');
    const round = await getRound();
    assert.equal(round.status, 200);
    const slotAt = round.body.currentSlot.startsAt;
    const winner = await post(slotAt, 'phase4-window-winner');
    assert.equal(winner.status, 200);
    assert.equal(winner.body.code, 'WINNER');
    const closesAt = Date.parse(winner.body.registrationClosesAt);
    artifact.slotAt = slotAt;
    artifact.registrationClosesAt = winner.body.registrationClosesAt;
    lockClient = await pool.connect();
    await lockClient.query('BEGIN');
    await lockClient.query('LOCK TABLE hour_slots IN ACCESS EXCLUSIVE MODE');
    lockHeld = true;
    artifact.lockAcquiredAt = new Date().toISOString();
    await waitUntil(closesAt - 850);
    artifact.followupSentAt = new Date().toISOString();
    assert.ok(Date.parse(artifact.followupSentAt) < closesAt, 'Request missed open Window');
    const followupPromise = post(slotAt, 'phase4-window-followup');
    await waitUntil(closesAt - 250);
    const waiting = await pool.query(`
      SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND query LIKE '%hour_slots%' AND pid <> pg_backend_pid()
    `);
    artifact.blockedQueriesBeforeClose = waiting.rows[0].count;
    assert.ok(artifact.blockedQueriesBeforeClose >= 1, 'Attempt must reach PostgreSQL before Window close');
    await waitUntil(closesAt + 250);
    await lockClient.query('COMMIT');
    lockHeld = false;
    artifact.lockReleasedAt = new Date().toISOString();
    const followup = await followupPromise;
    artifact.followup = { status: followup.status, code: followup.body.code, position: followup.body.position ?? null };
    const final = await pool.query('SELECT count(*)::int AS winner_count, max(attempt_count)::int AS attempts, max(winner_message) AS winner_message FROM hour_slots');
    artifact.winnerCount = final.rows[0].winner_count;
    artifact.requestCount = 2;
    artifact.successCount = 1;
    artifact.failureCount = 1;
    artifact.positionRange = [1, 1];
    artifact.duplicatePositionCount = 0;
    artifact.missingPositionCount = 0;
    artifact.winnerMessageMutationCount = final.rows[0].winner_message === 'phase4-window-winner' ? 0 : 1;
    artifact.finalAttemptCount = final.rows[0].attempts;
    artifact.passed = followup.status === 409 && followup.body.code === 'REGISTRATION_CLOSED'
      && artifact.winnerCount === 1 && artifact.finalAttemptCount === 1
      && artifact.winnerMessageMutationCount === 0;
  } else {
    const round = await getRound();
    assert.equal(round.status, 200);
    const boundary = Date.parse(round.body.nextSlotAt);
    assert.ok(boundary - Date.now() > 5000, 'Run earlier than five seconds before the hour');
    artifact.previousSlotAt = round.body.currentSlot.startsAt;
    artifact.boundaryAt = round.body.nextSlotAt;
    await waitUntil(boundary - 3000);
    await pool.query('TRUNCATE hour_slots');
    lockClient = await pool.connect();
    await lockClient.query('BEGIN');
    await lockClient.query('LOCK TABLE hour_slots IN ACCESS EXCLUSIVE MODE');
    lockHeld = true;
    artifact.lockAcquiredAt = new Date().toISOString();
    await waitUntil(boundary - 1000);
    artifact.requestsSentAt = new Date().toISOString();
    assert.ok(Date.parse(artifact.requestsSentAt) < boundary, 'Requests missed prior slot');
    const roundPromise = getRound();
    const attemptPromise = post(artifact.previousSlotAt, 'phase4-hour-boundary');
    await waitUntil(boundary - 250);
    const waiting = await pool.query(`
      SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND query LIKE '%hour_slots%' AND pid <> pg_backend_pid()
    `);
    artifact.blockedQueriesBeforeBoundary = waiting.rows[0].count;
    assert.ok(artifact.blockedQueriesBeforeBoundary >= 2, 'Both API queries must reach PostgreSQL before the hour');
    await waitUntil(boundary + 250);
    await lockClient.query('COMMIT');
    lockHeld = false;
    artifact.lockReleasedAt = new Date().toISOString();
    const [roundResult, attempt] = await Promise.all([roundPromise, attemptPromise]);
    artifact.round = {
      status: roundResult.status,
      serverTime: roundResult.body.serverTime,
      slotAt: roundResult.body.currentSlot?.startsAt,
      endsAt: roundResult.body.currentSlot?.endsAt
    };
    artifact.attempt = { status: attempt.status, code: attempt.body.code, position: attempt.body.position ?? null };
    const final = await pool.query('SELECT count(*)::int AS winner_count FROM hour_slots');
    artifact.winnerCount = final.rows[0].winner_count;
    artifact.requestCount = 1;
    artifact.successCount = 0;
    artifact.failureCount = 1;
    artifact.positionRange = null;
    artifact.duplicatePositionCount = 0;
    artifact.missingPositionCount = 0;
    artifact.winnerMessageMutationCount = 0;
    artifact.roundBoundaryPassed = roundResult.status === 200
      && Date.parse(roundResult.body.serverTime) >= boundary
      && Date.parse(roundResult.body.currentSlot?.startsAt) === boundary;
    artifact.dbFinalDecisionPassed = attempt.status === 409 && attempt.body.code === 'ROUND_ENDED'
      && artifact.winnerCount === 0;
    artifact.passed = artifact.roundBoundaryPassed && artifact.dbFinalDecisionPassed;
  }
} catch (error) {
  artifact.error = String(error);
  artifact.passed = false;
} finally {
  if (lockHeld) await lockClient.query('ROLLBACK');
  lockClient?.release();
  await pool.end();
  artifact.finishedAt = new Date().toISOString();
  await mkdir('tests/e2e/artifacts', { recursive: true });
  const path = `tests/e2e/artifacts/phase4-local-${scenario}-boundary.json`;
  await writeFile(path, JSON.stringify(artifact, null, 2) + '\n');
  console.log(JSON.stringify({ path, ...artifact }, null, 2));
  if (!artifact.passed) process.exitCode = 1;
}
