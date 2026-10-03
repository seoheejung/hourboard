import { mkdir, writeFile } from 'node:fs/promises';

const base = process.env.PRODUCTION_BASE_URL;
const cdpUrl = process.env.CHROME_CDP_URL;
if (base !== 'https://hourboard.duckdns.org' || !cdpUrl ||
    !['127.0.0.1', 'localhost'].includes(new URL(cdpUrl).hostname)) {
  throw new Error('Production page-load check requires production URL and local Chrome CDP');
}

const artifact = { scenario: 'production-browser-page-load',
  measurementVantage: 'work PC LAN via public HTTPS origin',
  sampledAt: new Date().toISOString(), samples: [] };
const path = 'tests/e2e/artifacts/phase4-production-page-load.json';

async function until(action) {
  for (let index = 0; index < 100; index++) {
    const value = await action();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for browser page load');
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.ceil(sorted.length * fraction) - 1] * 100) / 100;
}

let socket;
try {
  const browserInfo = await (await fetch(new URL('/json/version', cdpUrl))).json();
  const browser = new WebSocket(browserInfo.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    browser.addEventListener('open', resolve, { once: true });
    browser.addEventListener('error', reject, { once: true });
  });
  const { targetId } = await new Promise((resolve, reject) => {
    browser.addEventListener('message', event => {
      const response = JSON.parse(event.data);
      if (response.id === 1) response.error ? reject(new Error(response.error.message)) : resolve(response.result);
    });
    browser.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: base } }));
  });
  socket = browser;
  const target = await until(async () => {
    const tabs = await (await fetch(new URL('/json', cdpUrl))).json();
    return tabs.find(item => item.id === targetId);
  });
  const page = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    page.addEventListener('open', resolve, { once: true });
    page.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  page.addEventListener('message', event => {
    const response = JSON.parse(event.data);
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    response.error ? request.reject(new Error(response.error.message)) : request.resolve(response.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const next = ++id;
    pending.set(next, { resolve, reject });
    page.send(JSON.stringify({ id: next, method, params }));
  });
  const evaluate = async expression => {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
    return response.result.value;
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  let previousOrigin = 0;
  for (let index = 0; index < 10; index++) {
    if (index > 0) await send('Page.reload', { ignoreCache: true });
    const sample = await until(async () => evaluate(`(() => {
      if (performance.timeOrigin === ${previousOrigin} || document.readyState !== 'complete' ||
          typeof round === 'undefined' || round === null) return null;
      const navigation = performance.getEntriesByType('navigation')[0];
      return navigation?.loadEventEnd > 0 ? {
        timeOrigin: performance.timeOrigin,
        documentLoadMs: navigation.loadEventEnd,
        roundReadyMs: performance.now()
      } : null;
    })()`));
    previousOrigin = sample.timeOrigin;
    artifact.samples.push({ documentLoadMs: sample.documentLoadMs,
      roundReadyMs: sample.roundReadyMs });
  }
  artifact.documentLoad = { sampleCount: artifact.samples.length,
    p50Ms: percentile(artifact.samples.map(item => item.documentLoadMs), 0.5),
    p95Ms: percentile(artifact.samples.map(item => item.documentLoadMs), 0.95),
    p99Ms: percentile(artifact.samples.map(item => item.documentLoadMs), 0.99) };
  artifact.roundReady = { sampleCount: artifact.samples.length,
    p50Ms: percentile(artifact.samples.map(item => item.roundReadyMs), 0.5),
    p95Ms: percentile(artifact.samples.map(item => item.roundReadyMs), 0.95),
    p99Ms: percentile(artifact.samples.map(item => item.roundReadyMs), 0.99) };
  page.close();
  console.log('Production browser page-load check passed');
} catch (error) {
  artifact.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.error(artifact.error);
} finally {
  socket?.close();
  await mkdir('tests/e2e/artifacts', { recursive: true });
  await writeFile(path, JSON.stringify(artifact, null, 2) + '\n');
}
