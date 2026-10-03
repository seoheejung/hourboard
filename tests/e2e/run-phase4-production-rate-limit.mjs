import { mkdir, writeFile } from 'node:fs/promises';

const base = process.env.PRODUCTION_BASE_URL;
const average = Number(process.env.RATE_LIMIT_AVERAGE);
const burst = Number(process.env.RATE_LIMIT_BURST);
const period = process.env.RATE_LIMIT_PERIOD;
if (base !== 'https://hourboard.duckdns.org' || !Number.isInteger(average) || average < 1 ||
    !Number.isInteger(burst) || burst < 1 || period !== '1s') {
  throw new Error('Production rate-limit E2E requires the production URL and inspected rate-limit labels');
}

const artifact = {
  scenario: 'production-post-attempts-rate-limit',
  startedAt: new Date().toISOString(),
  measurementVantage: 'work PC LAN via public HTTPS origin',
  configuredFromRunningContainer: { average, period, burst },
  requested: Math.max(300, burst + average * 3 + 1),
  postStatusCounts: {},
  healthStatuses: [],
  roundStatuses: [],
  checks: {}
};
const artifactPath = 'tests/e2e/artifacts/phase4-production-rate-limit.json';

function check(name, condition) {
  artifact.checks[name] = Boolean(condition);
  if (!condition) throw new Error(`Production rate-limit E2E failed: ${name}`);
}

async function status(path) {
  try {
    const response = await fetch(base + path, { cache: 'no-store', signal: AbortSignal.timeout(5_000) });
    await response.arrayBuffer();
    return response.status;
  } catch {
    return null;
  }
}

try {
  let postsDone = false;
  const monitor = (async () => {
    const started = Date.now();
    while (!postsDone || Date.now() - started < 3_000) {
      const [health, round] = await Promise.all([status('/health'), status('/api/round')]);
      artifact.healthStatuses.push(health);
      artifact.roundStatuses.push(round);
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  })();
  const posts = await Promise.all(Array.from({ length: artifact.requested }, async () => {
    try {
      const response = await fetch(`${base}/api/attempts`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: '{"slotAt":', signal: AbortSignal.timeout(10_000)
      });
      await response.arrayBuffer();
      return response.status;
    } catch {
      return null;
    }
  }));
  postsDone = true;
  await monitor;
  for (const code of posts) {
    const key = String(code);
    artifact.postStatusCounts[key] = (artifact.postStatusCounts[key] ?? 0) + 1;
  }
  artifact.rateLimited = artifact.postStatusCounts['429'] ?? 0;
  artifact.rejectedInvalid = artifact.postStatusCounts['400'] ?? 0;
  artifact.networkFailed = artifact.postStatusCounts.null ?? 0;
  check('POST rate limit returned 429', artifact.rateLimited > 0);
  check('unlimited POST remained invalid rather than registering',
    artifact.rateLimited + artifact.rejectedInvalid === artifact.requested);
  check('health GET remained 200', artifact.healthStatuses.length > 0 &&
    artifact.healthStatuses.every(code => code === 200));
  check('round GET remained 200', artifact.roundStatuses.length > 0 &&
    artifact.roundStatuses.every(code => code === 200));
  console.log('Production POST rate-limit E2E passed');
} catch (error) {
  artifact.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.error(artifact.error);
} finally {
  artifact.finishedAt = new Date().toISOString();
  await mkdir('tests/e2e/artifacts', { recursive: true });
  await writeFile(artifactPath, JSON.stringify(artifact, null, 2) + '\n');
}
