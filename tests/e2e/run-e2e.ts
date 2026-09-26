import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import pg from 'pg';

if (process.env.NODE_ENV !== 'test' || !process.env.DATABASE_URL) {
  throw new Error('E2E requires NODE_ENV=test and DATABASE_URL for a local development database');
}
const baseUrl = new URL(process.env.DATABASE_URL);
if (!['localhost', '127.0.0.1'].includes(baseUrl.hostname)) {
  throw new Error('E2E is limited to a local PostgreSQL server');
}
const testUrl = new URL(baseUrl);
testUrl.pathname = '/hourboard_e2e';
const admin = new pg.Pool({ connectionString: baseUrl.toString() });
let pool: pg.Pool | undefined;
let child: ReturnType<typeof spawn> | undefined;
const artifact: Record<string, unknown> = {
  phase: 'phase1', scenario: 'concurrent-attempts', requested: 100,
  succeeded: 0, failed: 100, winnerCount: 0, minPosition: null,
  maxPosition: null, duplicatePositions: null, missingPositions: null,
  winnerMessageMutations: null, p50Ms: null, p95Ms: null, p99Ms: null,
  checks: {} as Record<string, boolean>
};

function check(name: string, condition: boolean) {
  (artifact.checks as Record<string, boolean>)[name] = condition;
  if (!condition) throw new Error(`E2E check failed: ${name}`);
}

async function openPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local port');
  const port = address.port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

try {
  const found = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', ['hourboard_e2e']);
  if (!found.rowCount) await admin.query('CREATE DATABASE hourboard_e2e');
  pool = new pg.Pool({ connectionString: testUrl.toString() });
  const migration = await readFile('db/migrations/001_create_hour_slots.sql', 'utf8');
  await pool.query(migration);
  await pool.query('TRUNCATE hour_slots');

  const port = await openPort();
  const base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test', PORT: String(port), DATABASE_URL: testUrl.toString() },
    stdio: 'ignore'
  });
  let healthy = false;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error('Fastify server exited before health check');
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) { healthy = true; break; }
    } catch { /* 서버 시작 대기 */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  check('health', healthy);
  const request = async (slotAt: string, message: string) => {
    const response = await fetch(`${base}/api/attempts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slotAt, message })
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const roundBefore = await (await fetch(`${base}/api/round`)).json() as { currentSlot: { startsAt: string; message: string | null; attemptCount: number | null }; nextSlotAt: string };
  const slotAt = roundBefore.currentSlot.startsAt;
  artifact.slotAt = slotAt;
  check('empty current slot', roundBefore.currentSlot.message === null && roundBefore.currentSlot.attemptCount === null);
  const winnerMessage = '<script>alert(1)</script>';
  const first = await request(slotAt, winnerMessage);
  check('first attempt', first.status === 200 && first.body.code === 'WINNER' && first.body.position === 1 && first.body.winner === true);
  const second = await request(slotAt, 'second');
  check('second attempt', second.status === 200 && second.body.code === 'RANKED' && second.body.position === 2 && second.body.winner === false && !('winnerMessage' in second.body));
  const roundAfter = await (await fetch(`${base}/api/round`)).json() as typeof roundBefore;
  check('winner text stays fixed', roundAfter.currentSlot.message === winnerMessage && roundAfter.currentSlot.attemptCount === 2);

  const countBeforeInvalid = await pool.query<{ attempt_count: string }>('SELECT attempt_count FROM hour_slots WHERE slot_start = $1', [slotAt]);
  const errorCases: Array<[string, string, string, number, string]> = [
    ['invalid format', 'bad-slot', 'ok', 400, 'INVALID_SLOT'],
    ['non-hour slot', new Date(Date.parse(slotAt) + 60_000).toISOString(), 'ok', 400, 'INVALID_SLOT'],
    ['future slot', roundBefore.nextSlotAt, 'ok', 425, 'ROUND_NOT_STARTED'],
    ['ended slot', new Date(Date.parse(slotAt) - 3_600_000).toISOString(), 'ok', 409, 'ROUND_ENDED'],
    ['empty message', slotAt, '', 400, 'INVALID_REQUEST'],
    ['blank message', slotAt, '   ', 400, 'INVALID_REQUEST'],
    ['long message', slotAt, '가'.repeat(121), 400, 'INVALID_REQUEST'],
    ['multiline message', slotAt, 'a\nb', 400, 'INVALID_REQUEST']
  ];
  for (const [name, target, message, status, code] of errorCases) {
    const result = await request(target, message);
    check(name, result.status === status && result.body.code === code && result.body.position === null && result.body.winner === false);
  }
  const countAfterInvalid = await pool.query<{ attempt_count: string }>('SELECT attempt_count FROM hour_slots WHERE slot_start = $1', [slotAt]);
  check('invalid attempts do not write', countBeforeInvalid.rows[0].attempt_count === countAfterInvalid.rows[0].attempt_count);
  await pool.query('TRUNCATE hour_slots');
  const oldSlot = new Date(Date.parse(slotAt) - 3_600_000);
  await pool.query('INSERT INTO hour_slots (slot_start, winner_message) VALUES ($1, $2)', [oldSlot, 'old winner']);
  const roundTransition = await (await fetch(`${base}/api/round`)).json() as typeof roundBefore;
  check('slot transition excludes previous winner', roundTransition.currentSlot.startsAt === slotAt && roundTransition.currentSlot.message === null);
  await pool.query('TRUNCATE hour_slots');
  const requests = Array.from({ length: 100 }, (_, i) => request(slotAt, `concurrent-${i}`));
  const results = await Promise.all(requests);
  const successes = results.filter(result => result.status === 200);
  const positions = successes.map(result => Number(result.body.position));
  const sorted = [...positions].sort((a, b) => a - b);
  const duplicates = positions.length - new Set(positions).size;
  const missing = Array.from({ length: 100 }, (_, i) => i + 1).filter(position => !positions.includes(position)).length;
  const winner = successes.find(result => result.body.position === 1);
  const row = await pool.query<{ winner_message: string; attempt_count: string }>('SELECT winner_message, attempt_count FROM hour_slots WHERE slot_start = $1', [slotAt]);
  const finalRound = await (await fetch(`${base}/api/round`)).json() as typeof roundBefore;
  artifact.succeeded = successes.length;
  artifact.failed = results.length - successes.length;
  artifact.winnerCount = successes.filter(result => result.body.code === 'WINNER').length;
  artifact.minPosition = sorted[0] ?? null;
  artifact.maxPosition = sorted.at(-1) ?? null;
  artifact.duplicatePositions = duplicates;
  artifact.missingPositions = missing;
  artifact.winnerMessageMutations = winner && row.rows[0]?.winner_message === `concurrent-${results.indexOf(winner)}` && finalRound.currentSlot.message === row.rows[0].winner_message ? 0 : 1;
  check('100 successful requests', successes.length === 100);
  check('one winner', artifact.winnerCount === 1);
  check('positions 1 to 100', sorted.every((position, i) => position === i + 1) && row.rows[0]?.attempt_count === '100');
  check('position contract', successes.every(result => result.body.position === 1
    ? result.body.code === 'WINNER' && result.body.winner === true
    : result.body.code === 'RANKED' && result.body.winner === false));
  check('winner message immutability', artifact.winnerMessageMutations === 0);
  console.log('Phase 1 E2E passed');
} catch (error) {
  artifact.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.error(artifact.error);
} finally {
  await mkdir('tests/e2e/artifacts', { recursive: true });
  await writeFile('tests/e2e/artifacts/phase1-concurrency.json', JSON.stringify(artifact, null, 2) + '\n');
  child?.kill();
  await pool?.end();
  await admin.end();
}
