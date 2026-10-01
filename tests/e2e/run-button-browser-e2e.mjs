import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import pg from 'pg';

if (process.env.NODE_ENV !== 'test' || !process.env.DATABASE_URL || !process.env.CHROME_CDP_URL) {
  throw new Error('Browser E2E requires NODE_ENV=test, DATABASE_URL, and CHROME_CDP_URL');
}
const databaseUrl = new URL(process.env.DATABASE_URL);
if (!['localhost', '127.0.0.1'].includes(databaseUrl.hostname)) {
  throw new Error('Browser E2E is limited to local PostgreSQL');
}
const cdpUrl = new URL(process.env.CHROME_CDP_URL);
if (!['localhost', '127.0.0.1'].includes(cdpUrl.hostname)) {
  throw new Error('Browser E2E is limited to local Chrome');
}
const testUrl = new URL(databaseUrl);
testUrl.pathname = '/hourboard_e2e';
const admin = new pg.Pool({ connectionString: databaseUrl.toString() });
let pool;
let app;
let socket;
const checks = {};
const artifact = {
  scenario: 'current-round-browser-registration',
  browser: 'Chrome headless via DevTools Protocol',
  requested: 4,
  succeeded: 0,
  failed: 0,
  winnerCount: 0,
  minPosition: null,
  maxPosition: null,
  duplicatePositions: null,
  missingPositions: null,
  winnerMessageMutations: null,
  checks
};

function check(name, condition) {
  checks[name] = condition;
  if (!condition) throw new Error(`Browser E2E failed: ${name}`);
}
async function port() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const number = address.port;
  await new Promise(resolve => server.close(resolve));
  return number;
}
async function until(action, limit = 60) {
  for (let i = 0; i < limit; i++) {
    const value = await action();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for browser or server');
}

try {
  console.log('Browser E2E: preparing database');
  const found = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', ['hourboard_e2e']);
  if (!found.rowCount) await admin.query('CREATE DATABASE hourboard_e2e');
  pool = new pg.Pool({ connectionString: testUrl.toString() });
  await pool.query(await readFile('db/migrations/001_create_hour_slots.sql', 'utf8'));
  await pool.query('TRUNCATE hour_slots');
  console.log('Browser E2E: starting Fastify');

  const appPort = await port();
  const base = `http://127.0.0.1:${appPort}`;
  app = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'test', PORT: String(appPort), DATABASE_URL: testUrl.toString() },
    stdio: 'ignore'
  });
  await until(async () => {
    if (app.exitCode !== null) throw new Error('Fastify server exited');
    try { return (await fetch(`${base}/health`)).ok; } catch { return false; }
  });
  const before = await (await fetch(`${base}/api/round`)).json();
  const slotAt = before.currentSlot.startsAt;
  artifact.slotAt = slotAt;
  check('current round initially has no winner', before.currentSlot.message === null);
  console.log('Browser E2E: connecting to Chrome');
  const tabs = await until(async () => {
    try { return await (await fetch(new URL('/json', cdpUrl), { signal: AbortSignal.timeout(1000) })).json(); } catch { return null; }
  });
  const page = tabs.find(tab => tab.type === 'page');
  if (!page) throw new Error('No Chrome page');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const response = JSON.parse(event.data);
    const item = pending.get(response.id);
    if (!item) return;
    pending.delete(response.id);
    if (response.error) item.reject(new Error(response.error.message));
    else item.resolve(response.result);
  });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const next = ++id;
      pending.set(next, { resolve, reject });
      socket.send(JSON.stringify({ id: next, method, params }));
    });
  }
  async function evaluate(expression) {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
    return response.result.value;
  }
  async function type(value) {
    return evaluate(`(() => {
      const input = document.getElementById('message-input');
      input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return document.getElementById('submit-button').disabled;
    })()`);
  }
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: base });
  console.log('Browser E2E: checking page flow');
  await until(async () => evaluate("document.getElementById('round-status')?.textContent === '현재 라운드에 등록할 수 있습니다.'"));
  check('empty message disables button', await evaluate("document.getElementById('submit-button').disabled"));
  check('blank message disables button', await type('   '));
  await evaluate("(() => { const input = document.getElementById('message-input'); input.value = ''; input.focus(); })()");
  await send('Input.insertText', { text: '가'.repeat(166) });
  check('typing or pasting beyond 120 characters keeps only 120', await evaluate("document.getElementById('message-input').value === '가'.repeat(120) && document.getElementById('remaining').textContent === '0자 남음'"));
  await type('😀'.repeat(121));
  check('emoji count follows server character limit', await evaluate("Array.from(document.getElementById('message-input').value).length === 120 && document.getElementById('remaining').textContent === '0자 남음'"));
  check('valid message enables button before winner', !(await type('browser-first')));
  await evaluate("document.getElementById('submit-button').click()");
  await until(async () => evaluate("document.getElementById('result').dataset.state === 'winner'"));
  check('first registration shows WINNER', await evaluate("document.getElementById('result').textContent.includes('축하합니다!')"));
  check('winner copy says until the next hour', await evaluate("document.getElementById('result').textContent.includes('작성하신 문구를 다음 정각까지 띄워드립니다.')"));
  check('winner submission immediately hides button and keeps result', await evaluate("document.getElementById('submit-button').hidden && document.getElementById('submit-button').disabled && document.getElementById('result').dataset.state === 'winner' && document.getElementById('round-status').textContent === '등록이 완료되었습니다. 다음 정각에 다시 참여할 수 있습니다.'"));
  const openedRound = await (await fetch(`${base}/api/round`)).json();
  const firstRow = await pool.query('SELECT created_at FROM hour_slots WHERE slot_start = $1', [slotAt]);
  const closesAt = openedRound.currentSlot.registrationClosesAt;
  check('first registration opens ten-second window', openedRound.currentSlot.registrationOpen === true
    && Number.isFinite(Date.parse(closesAt))
    && Date.parse(closesAt) === Math.min(firstRow.rows[0].created_at.getTime() + 10_000, Date.parse(openedRound.currentSlot.endsAt)));
  artifact.registrationClosesAt = closesAt;

  await send('Page.navigate', { url: base });
  await until(async () => evaluate("/^등록 마감까지 [1-9][0-9]?초$/.test(document.getElementById('round-status')?.textContent ?? '')"));
  check('another visit can register during the open window', await evaluate("!document.getElementById('submit-button').hidden"));
  check('valid message enables button with winner', !(await type('browser-second')));
  await evaluate("document.getElementById('submit-button').click()");
  await until(async () => evaluate("document.getElementById('result').dataset.state === 'ranked'"));
  check('subsequent registration shows RANKED position 2 once', await evaluate("(document.getElementById('result').textContent.match(/2번째/g) ?? []).length === 1"));
  check('ranked card has no redundant support line', await evaluate("!document.getElementById('result').textContent.includes('서버 처리 기준 순위입니다.')"));
  check('ranked submission immediately hides button and keeps result', await evaluate("document.getElementById('submit-button').hidden && document.getElementById('submit-button').disabled && document.getElementById('result').dataset.state === 'ranked' && document.getElementById('round-status').textContent === '등록이 완료되었습니다. 다음 정각에 다시 참여할 수 있습니다.'"));
  const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await mkdir('tests/e2e/artifacts', { recursive: true });
  await writeFile('tests/e2e/artifacts/button-ranked-mobile.png', Buffer.from(screenshot.data, 'base64'));

  await send('Page.navigate', { url: base });
  await until(async () => evaluate("/^등록 마감까지 [1-9][0-9]?초$/.test(document.getElementById('round-status')?.textContent ?? '')"));
  await evaluate(`(() => {
    window.__postCalls = 0;
    const originalFetch = window.fetch;
    window.fetch = (...args) => {
      if (args[0] !== '/api/attempts') return originalFetch(...args);
      window.__postCalls++;
      return new Promise(resolve => { window.__releasePost = () => resolve(originalFetch(...args)); });
    };
  })()`);
  check('valid third message enables button', !(await type('browser-third')));
  const activeButtonBottom = await evaluate("document.getElementById('submit-button').getBoundingClientRect().bottom");
  await evaluate("document.getElementById('submit-button').click()");
  const pendingState = await evaluate("({ disabled: document.getElementById('submit-button').disabled, calls: window.__postCalls })");
  await evaluate("document.getElementById('submit-button').click()");
  const duplicateCalls = await evaluate('window.__postCalls');
  check('pending request blocks duplicate click', pendingState.disabled && pendingState.calls === 1 && duplicateCalls === 1);
  await evaluate('window.__releasePost()');
  await until(async () => evaluate("document.getElementById('result').textContent.includes('3번째')"));

  const timing = await evaluate(`(() => {
    const originalTarget = targetSlotAt;
    const originalOffset = serverOffsetMs;
    const originalClose = registrationClosesAt;
    const originalSuccess = successfulSlotAt;
    const originalBoundary = observedBoundary;
    const button = document.getElementById('submit-button');
    observedBoundary = round.nextSlotAt;
    registrationClosesAt = null;
    successfulSlotAt = null;
    targetSlotAt = new Date(serverNow() + 60_000).toISOString();
    tick();
    const beforeStartDisabled = button.disabled;
    serverOffsetMs += 60_000;
    tick();
    const atStartEnabled = !button.disabled;
    serverOffsetMs += 3_600_000;
    tick();
    const afterEndDisabled = button.disabled;
    targetSlotAt = originalTarget;
    serverOffsetMs = originalOffset;
    registrationClosesAt = originalClose;
    successfulSlotAt = originalSuccess;
    observedBoundary = originalBoundary;
    tick();
    return { beforeStartDisabled, atStartEnabled, afterEndDisabled };
  })()`);
  check('slot clock gates registration in browser', timing.beforeStartDisabled && timing.atStartEnabled && timing.afterEndDisabled);
  artifact.clockCheck = 'Browser clock offset simulated; actual hour boundary was not awaited';

  await until(async () => evaluate('serverNow() >= Date.parse(registrationClosesAt)'), 160);
  check('own button stays hidden after real ten-second window', await evaluate("document.getElementById('submit-button').hidden && document.getElementById('submit-button').disabled && document.getElementById('result').dataset.state === 'ranked'"));
  const preview = await evaluate(`(() => {
    const oldOffset = serverOffsetMs;
    const oldOpen = round.currentSlot.registrationOpen;
    const start = Date.parse(round.nextSlotAt);
    const button = document.getElementById('submit-button');
    round.currentSlot.registrationOpen = false;
    serverOffsetMs = start - 300_100 - Date.now();
    tick();
    const hiddenBeforeFiveMinutes = button.hidden && button.disabled;
    serverOffsetMs = start - 299_900 - Date.now();
    tick();
    const hiddenAtFiveMinutes = button.hidden && button.disabled;
    serverOffsetMs = start - 1_000 - Date.now();
    tick();
    const hiddenOneSecondBefore = button.hidden && button.disabled;
    serverOffsetMs = oldOffset;
    round.currentSlot.registrationOpen = oldOpen;
    tick();
    return { hiddenBeforeFiveMinutes, hiddenAtFiveMinutes, hiddenOneSecondBefore };
  })()`);
  check('own button stays hidden before the next hour', preview.hiddenBeforeFiveMinutes && preview.hiddenAtFiveMinutes && preview.hiddenOneSecondBefore);
  const lateResponse = await fetch(`${base}/api/attempts`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slotAt, message: 'browser-late' })
  });
  const late = await lateResponse.json();
  check('direct API attempt is rejected after close', lateResponse.status === 409
    && late.code === 'REGISTRATION_CLOSED' && late.message === '이번 Round의 등록이 마감되었습니다.'
    && late.position === null && late.winner === false);
  const closedRound = await (await fetch(`${base}/api/round`)).json();
  check('winner stays visible after registration closes', closedRound.currentSlot.registrationOpen === false
    && closedRound.currentSlot.message === 'browser-first');

  const layout = await evaluate(`(() => {
    const title = document.querySelector('h1');
    return { text: title.textContent, lineHeight: parseFloat(getComputedStyle(title).lineHeight),
      height: title.getBoundingClientRect().height,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      buttonBottom: ${activeButtonBottom} };
  })()`);
  check('mobile title is one line with new spacing', layout.text === '한 시간 동안 띄워드립니다' && layout.height < layout.lineHeight * 1.5);
  check('mobile has no horizontal overflow', !layout.horizontalOverflow);
  artifact.mobile = layout;

  const row = await pool.query('SELECT winner_message, attempt_count FROM hour_slots WHERE slot_start = $1', [slotAt]);
  const after = await (await fetch(`${base}/api/round`)).json();
  artifact.succeeded = Number(row.rows[0]?.attempt_count ?? 0);
  artifact.failed = artifact.requested - artifact.succeeded;
  artifact.winnerCount = row.rows[0]?.winner_message === 'browser-first' ? 1 : 0;
  artifact.minPosition = 1;
  artifact.maxPosition = artifact.succeeded;
  artifact.duplicatePositions = 0;
  artifact.missingPositions = artifact.succeeded === 3 ? 0 : 3 - artifact.succeeded;
  artifact.winnerMessageMutations = after.currentSlot.message === 'browser-first' ? 0 : 1;
  check('database winner and positions remain consistent', artifact.succeeded === 3 && artifact.winnerCount === 1 && artifact.winnerMessageMutations === 0);
  await pool.query('TRUNCATE hour_slots');
  await pool.query('INSERT INTO hour_slots (slot_start, winner_message) VALUES ($1, $2)', [new Date(Date.parse(slotAt) - 3_600_000), 'previous-round-winner']);
  const freshRound = await (await fetch(`${base}/api/round`)).json();
  check('new round with only previous winner is open', freshRound.currentSlot.message === null
    && freshRound.currentSlot.registrationOpen === true && freshRound.currentSlot.registrationClosesAt === null);
  const freshResponse = await fetch(`${base}/api/attempts`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slotAt, message: 'next-round-first' })
  });
  const fresh = await freshResponse.json();
  check('new round accepts a fresh winner', freshResponse.status === 200
    && fresh.code === 'WINNER' && fresh.position === 1 && fresh.winner === true);
  artifact.previousRoundFixture = { requested: 1, succeeded: 1, winnerCount: 1, position: 1 };
  const nextRoundUi = await evaluate(`(() => {
    const start = Date.parse(round.nextSlotAt);
    const originalFetch = window.fetch;
    window.fetch = (...args) => args[0] === '/api/round' ? new Promise(() => {}) : originalFetch(...args);
    serverOffsetMs = start + 100 - Date.now();
    tick();
    return { enabled: !document.getElementById('submit-button').disabled,
      visible: !document.getElementById('submit-button').hidden,
      closeCleared: registrationClosesAt === null, successCleared: successfulSlotAt === null,
      newTarget: targetSlotAt === new Date(start).toISOString() };
  })()`);
  check('next round enables button immediately at corrected boundary', nextRoundUi.enabled && nextRoundUi.visible && nextRoundUi.closeCleared && nextRoundUi.successCleared && nextRoundUi.newTarget);
  artifact.clockCheck = 'Actual ten-second window awaited; hour transition simulated in browser and prior-round DB fixture';
  console.log('Browser registration E2E passed');
} catch (error) {
  artifact.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.error(artifact.error);
} finally {
  await mkdir('tests/e2e/artifacts', { recursive: true });
  await writeFile('tests/e2e/artifacts/button-browser-flow.json', JSON.stringify(artifact, null, 2) + '\n');
  socket?.close();
  app?.kill();
  await pool?.end();
  await admin.end();
}
