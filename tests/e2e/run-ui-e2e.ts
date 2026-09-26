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
  phase: 'phase2', scenario: 'ticketing-ui-http-dom', requested: 6,
  succeeded: 0, failed: 0, winnerCount: 0, minPosition: null,
  maxPosition: null, duplicatePositions: null, missingPositions: null,
  winnerMessageMutations: null, checks: {} as Record<string, boolean>
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
  await pool.query(await readFile('db/migrations/001_create_hour_slots.sql', 'utf8'));
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
    try { if ((await fetch(`${base}/health`)).ok) { healthy = true; break; } } catch { /* 서버 시작 대기 */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  check('health', healthy);
  const page = await fetch(`${base}/`);
  const html = await page.text();
  artifact.indexStatus = page.status;
  check('index served', page.status === 200 && page.headers.get('content-type')?.includes('text/html') === true);
  const requiredIds = ['board-message', 'ends-at', 'countdown', 'round-status', 'attempt-form', 'message-input', 'remaining', 'submit-button', 'result'];
  check('required DOM elements', requiredIds.every(id => html.includes(`id="${id}"`)));
  check('accessible input and result', html.includes('for="message-input"') && html.includes('aria-live="polite"'));
  check('120 character UI rule', html.includes('data-max-length="120"'));
  const css = await fetch(`${base}/styles/app.css`);
  const js = await fetch(`${base}/scripts/app.js`);
  artifact.cssStatus = css.status;
  artifact.scriptStatus = js.status;
  check('static assets served', css.status === 200 && js.status === 200);
  const script = await js.text();
  const source = await readFile('src/client/app.ts', 'utf8');
  check('no automatic registration retry', (source.match(/fetch\('\/api\/attempts'/g) ?? []).length === 1 && source.includes('등록 결과를 확인하지 못했습니다.'));
  check('plain text winner rendering', source.includes('board.textContent =') && !source.includes('innerHTML'));
  check('countdown uses server time', source.includes('data.serverTime') && source.includes('serverOffsetMs') && script.includes('serverOffsetMs'));
  check('submitting blocks duplicate clicks', source.includes('if (!canSubmit()') && source.includes('pending = true') && source.includes('submitButton.disabled = !canSubmit()'));
  check('error UI states', ['INVALID_REQUEST', 'INVALID_SLOT', 'ROUND_NOT_STARTED', 'ROUND_ENDED', 'REGISTRATION_CLOSED'].every(code => source.includes(code)));

  const roundResponse = await fetch(`${base}/api/round`);
  const round = await roundResponse.json() as { serverTime: string; currentSlot: { startsAt: string; endsAt: string; message: string | null; attemptCount: number | null; registrationOpen: boolean; registrationClosesAt: string | null }; nextSlotAt: string };
  artifact.roundStatus = roundResponse.status;
  const slotAt = round.currentSlot.startsAt;
  artifact.slotAt = slotAt;
  check('round response contract', roundResponse.status === 200 && Number.isFinite(Date.parse(round.serverTime)) && round.currentSlot.message === null && round.currentSlot.attemptCount === null && round.currentSlot.registrationOpen === true && round.currentSlot.registrationClosesAt === null && Date.parse(round.currentSlot.endsAt) - Date.parse(slotAt) === 3_600_000 && round.nextSlotAt === round.currentSlot.endsAt);

  const oldSlot = new Date(Date.parse(slotAt) - 3_600_000);
  await pool.query('INSERT INTO hour_slots (slot_start, winner_message) VALUES ($1, $2)', [oldSlot, 'old winner']);
  const transition = await (await fetch(`${base}/api/round`)).json() as typeof round;
  check('previous winner hidden in empty slot', transition.currentSlot.message === null && transition.currentSlot.startsAt === slotAt);
  await pool.query('TRUNCATE hour_slots');
  const request = async (target: string, message: string) => {
    const response = await fetch(`${base}/api/attempts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slotAt: target, message })
    });
    return { status: response.status, body: await response.json() as { slotAt?: string; code: string; position: number | null; winner: boolean; registrationClosesAt?: string } };
  };
  const winnerMessage = '<img src=x onerror=alert(1)>';
  const first = await request(slotAt, winnerMessage);
  const second = await request(slotAt, 'another message');
  const invalid = await request('invalid', 'text');
  const future = await request(round.nextSlotAt, 'text');
  const ended = await request(oldSlot.toISOString(), 'text');
  const invalidTypeResponse = await fetch(`${base}/api/attempts`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slotAt, message: 123 })
  });
  const invalidType = { status: invalidTypeResponse.status, body: await invalidTypeResponse.json() as { code: string; position: number | null; winner: boolean } };
  const responses = [first, second, invalid, future, ended, invalidType];
  artifact.succeeded = responses.filter(item => item.status === 200).length;
  artifact.failed = responses.filter(item => item.status !== 200).length;
  artifact.expectedRejections = 4;
  artifact.winnerCount = responses.filter(item => item.body.code === 'WINNER').length;
  artifact.minPosition = 1;
  artifact.maxPosition = 2;
  artifact.duplicatePositions = first.body.position === second.body.position ? 1 : 0;
  artifact.missingPositions = first.body.position === 1 && second.body.position === 2 ? 0 : 1;
  const displayed = await (await fetch(`${base}/api/round`)).json() as typeof round;
  artifact.winnerMessageMutations = displayed.currentSlot.message === winnerMessage ? 0 : 1;
  check('winner contract', first.status === 200 && first.body.code === 'WINNER' && first.body.position === 1 && first.body.winner === true && first.body.slotAt === slotAt && Number.isFinite(Date.parse(first.body.registrationClosesAt ?? '')));
  check('ranked contract', second.status === 200 && second.body.code === 'RANKED' && second.body.position === 2 && second.body.winner === false && second.body.slotAt === slotAt);
  check('winner message persists as text', displayed.currentSlot.message === winnerMessage && displayed.currentSlot.attemptCount === 2 && displayed.currentSlot.registrationClosesAt === first.body.registrationClosesAt);
  await pool.query("UPDATE hour_slots SET created_at = slot_start + INTERVAL '1 hour' - INTERVAL '5 seconds' WHERE slot_start = $1", [slotAt]);
  const cappedRound = await (await fetch(`${base}/api/round`)).json() as typeof round;
  check('registration close is capped at slot end', cappedRound.currentSlot.registrationClosesAt === round.currentSlot.endsAt);
  check('invalid slot response', invalid.status === 400 && invalid.body.code === 'INVALID_SLOT');
  check('future slot response', future.status === 425 && future.body.code === 'ROUND_NOT_STARTED');
  check('ended slot response', ended.status === 409 && ended.body.code === 'ROUND_ENDED');
  check('invalid message type response', invalidType.status === 400 && invalidType.body.code === 'INVALID_REQUEST');
  check('rejected requests have no position', [invalid, future, ended, invalidType].every(item => item.body.position === null && item.body.winner === false));
  console.log('Phase 2 E2E passed');
} catch (error) {
  artifact.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.error(artifact.error);
} finally {
  await mkdir('tests/e2e/artifacts', { recursive: true });
  await writeFile('tests/e2e/artifacts/phase2-ticketing-ui.json', JSON.stringify(artifact, null, 2) + '\n');
  child?.kill();
  await pool?.end();
  await admin.end();
}
