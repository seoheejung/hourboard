import { mkdir, writeFile } from 'node:fs/promises';

const base = process.env.PRODUCTION_BASE_URL;
const cdpUrl = process.env.CHROME_CDP_URL;
if (base !== 'https://hourboard.duckdns.org' || !cdpUrl ||
    !['127.0.0.1', 'localhost'].includes(new URL(cdpUrl).hostname)) {
  throw new Error('Production browser E2E requires the production URL and local Chrome CDP');
}

const artifactPath = 'tests/e2e/artifacts/phase4-production-browser.json';
const artifact = {
  scenario: 'production-three-browser-registration',
  startedAt: new Date().toISOString(),
  origin: base,
  measurementVantage: 'work PC LAN via public HTTPS origin',
  checks: {},
  browserRequested: 3,
  browserSucceeded: 0,
  browserFailed: 0,
  winnerCount: null,
  minPosition: null,
  maxPosition: null,
  duplicatePositions: null,
  missingPositions: null,
  winnerMessageMutations: null
};
const connections = [];

function check(name, ok) {
  artifact.checks[name] = Boolean(ok);
  if (!ok) throw new Error(`Production browser E2E failed: ${name}`);
}

async function until(action, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await action();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for Production browser state');
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  connections.push(socket);
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const response = JSON.parse(event.data);
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    if (response.error) request.reject(new Error(response.error.message));
    else request.resolve(response.result);
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const next = ++id;
    pending.set(next, { resolve, reject });
    socket.send(JSON.stringify({ id: next, method, params }));
  });
}

async function getRound() {
  const response = await fetch(`${base}/api/round`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  check('round endpoint remains available', response.status === 200);
  return response.json();
}

async function createPage(browser) {
  const { browserContextId } = await browser('Target.createBrowserContext', { disposeOnDetach: true });
  const { targetId } = await browser('Target.createTarget', { url: base, browserContextId });
  const target = await until(async () => {
    const targets = await (await fetch(new URL('/json', cdpUrl))).json();
    return targets.find(item => item.id === targetId);
  });
  const send = await connect(target.webSocketDebuggerUrl);
  await send('Page.enable');
  await send('Runtime.enable');
  async function evaluate(expression) {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
    return response.result.value;
  }
  await until(async () => evaluate("document.getElementById('message-input') && typeof targetSlotAt === 'string'"));
  return { send, evaluate };
}

async function type(page, message) {
  return page.evaluate(`(() => {
    const input = document.getElementById('message-input');
    input.value = ${JSON.stringify(message)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return !document.getElementById('submit-button').disabled;
  })()`);
}

async function submit(page, state) {
  await page.evaluate("document.getElementById('submit-button').click()");
  return until(async () => page.evaluate(`document.getElementById('result').dataset.state === '${state}'`));
}

async function state(page) {
  return page.evaluate(`(() => {
    if (typeof round === 'undefined') return null;
    return ({
    input: document.getElementById('message-input').value,
    result: document.getElementById('result').textContent,
    resultState: document.getElementById('result').dataset.state,
    board: document.getElementById('board-message').textContent,
    buttonHidden: document.getElementById('submit-button').hidden,
    statusHidden: document.getElementById('round-status').hidden,
    status: document.getElementById('round-status').textContent,
    slot: round?.currentSlot.startsAt,
    successfulSlotAt
    });
  })()`);
}

try {
  const initial = await getRound();
  check('current Production round is open without a winner',
    initial.currentSlot.message === null && initial.currentSlot.registrationOpen === true);
  artifact.slotAt = initial.currentSlot.startsAt;
  artifact.nextSlotAt = initial.nextSlotAt;
  const browserInfo = await (await fetch(new URL('/json/version', cdpUrl))).json();
  const browser = await connect(browserInfo.webSocketDebuggerUrl);
  const [a, b, c] = await Promise.all([createPage(browser), createPage(browser), createPage(browser)]);
  const aMessage = `HourBoard production check A ${artifact.slotAt}`;
  check('all three browsers can prepare a message',
    (await Promise.all([[a, aMessage], [b, 'HourBoard production check B'], [c, 'HourBoard production check C']]
      .map(([page, message]) => type(page, message)))).every(Boolean));

  check('browser A wins', await submit(a, 'winner'));
  const aState = await state(a);
  check('browser A clears its draft and keeps winner UI', aState.input === '' &&
    aState.board.includes(aMessage) && aState.result.includes('축하합니다!') &&
    aState.buttonHidden && aState.statusHidden && aState.status === '');
  check('browser B ranks inside the window', await submit(b, 'ranked'));
  const bState = await state(b);
  check('browser B clears its draft and keeps result', bState.input === '' &&
    bState.result.includes('번째') && bState.buttonHidden && bState.statusHidden && bState.status === '');
  check('unregistered browser C can still rank inside the window', await submit(c, 'ranked'));
  const cState = await state(c);
  const positions = [1, Number(bState.result.match(/(\d+)번째/u)?.[1]), Number(cState.result.match(/(\d+)번째/u)?.[1])];
  artifact.browserSucceeded = 3;
  artifact.browserPositions = positions;
  artifact.browserFailed = 0;
  check('browser positions are 1..3', positions.join(',') === '1,2,3');
  const finalRound = await getRound();
  artifact.winnerCount = positions.filter(position => position === 1).length;
  artifact.minPosition = Math.min(...positions);
  artifact.maxPosition = Math.max(...positions);
  artifact.duplicatePositions = positions.length - new Set(positions).size;
  artifact.missingPositions = artifact.maxPosition - artifact.minPosition + 1 - new Set(positions).size;
  artifact.winnerMessageMutations = Number(finalRound.currentSlot.message !== aMessage);
  check('browser winner and position invariants', artifact.winnerCount === 1 &&
    artifact.minPosition === 1 && artifact.maxPosition === 3 &&
    artifact.duplicatePositions === 0 && artifact.missingPositions === 0 &&
    artifact.winnerMessageMutations === 0 && finalRound.currentSlot.attemptCount === 3);

  await a.send('Page.reload');
  await until(async () => {
    const current = await state(a);
    return current?.slot === artifact.slotAt && current.result === '' && current.board.includes(aMessage);
  });
  const reloaded = await state(a);
  check('page refresh does not restore participation state', reloaded.successfulSlotAt === null &&
    reloaded.result === '' && reloaded.board.includes(aMessage));

  await until(async () => (await getRound()).currentSlot.registrationOpen === false, 20_000);

  for (const [page, draft] of [[a, 'HourBoard next round A'], [b, 'HourBoard next round B']]) {
    await type(page, draft);
  }
  artifact.firstRoundVerifiedAt = new Date().toISOString();
  await mkdir('tests/e2e/artifacts', { recursive: true });
  await writeFile(artifactPath, JSON.stringify(artifact, null, 2) + '\n');
  console.log('Production first-round browser checks passed; waiting for next round');

  while (Date.now() < Date.parse(artifact.nextSlotAt) + 1_000) {
    await new Promise(resolve => setTimeout(resolve, Math.min(30_000, Date.parse(artifact.nextSlotAt) + 1_000 - Date.now())));
  }
  await until(async () => {
    const [aNext, bNext] = await Promise.all([state(a), state(b)]);
    return aNext.slot === artifact.nextSlotAt && bNext.slot === artifact.nextSlotAt &&
      aNext.successfulSlotAt === null && bNext.successfulSlotAt === null &&
      aNext.result === '' && bNext.result === '' &&
      !aNext.board.includes(aMessage) && !bNext.board.includes(aMessage);
  }, 15_000);
  const next = await getRound();
  check('new round does not show previous winner', next.currentSlot.startsAt === artifact.nextSlotAt &&
    next.currentSlot.message !== aMessage);
  const [aNextEnabled, bNextEnabled] = await Promise.all([a, b].map(async page =>
    page.evaluate("!document.getElementById('submit-button').hidden && !document.getElementById('submit-button').disabled")));
  check('open pages accept new round drafts', aNextEnabled && bNextEnabled);
  artifact.nextRoundVerifiedAt = new Date().toISOString();
  console.log('Production next-round browser checks passed');
} catch (error) {
  artifact.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.error(artifact.error);
} finally {
  artifact.finishedAt = new Date().toISOString();
  await mkdir('tests/e2e/artifacts', { recursive: true });
  await writeFile(artifactPath, JSON.stringify(artifact, null, 2) + '\n');
  for (const socket of connections) socket.close();
}
