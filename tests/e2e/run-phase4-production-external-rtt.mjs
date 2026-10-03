import { lookup } from 'node:dns/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { performance } from 'node:perf_hooks';

const base = process.env.PRODUCTION_BASE_URL;
if (base !== 'https://hourboard.duckdns.org' || process.env.PRODUCTION_NETWORK !== 'external') {
  throw new Error('External RTT measurement requires the production URL and confirmed external network');
}

const artifactPath = 'tests/e2e/artifacts/phase4-production-external-rtt.json';
const artifact = {
  scenario: 'production-external-tcp-rtt',
  startedAt: new Date().toISOString(),
  measurementVantage: 'work PC via user-confirmed external network',
  method: 'TCP connect to public HTTPS endpoint on port 443',
  requested: 20,
  succeeded: 0,
  failed: 0,
  samplesMs: []
};

function connectRtt(address) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const socket = createConnection({ host: address, port: 443 });
    socket.setTimeout(5_000);
    socket.once('connect', () => {
      const elapsed = performance.now() - started;
      socket.destroy();
      resolve(elapsed);
    });
    socket.once('timeout', () => { socket.destroy(new Error('TCP connect timed out')); });
    socket.once('error', reject);
  });
}

try {
  const { address } = await lookup(new URL(base).hostname);
  for (let index = 0; index < artifact.requested; index++) {
    try {
      artifact.samplesMs.push(Math.round((await connectRtt(address)) * 100) / 100);
      artifact.succeeded++;
    } catch {
      artifact.failed++;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (artifact.succeeded < 10) throw new Error('Fewer than ten TCP RTT samples succeeded');
  const sorted = [...artifact.samplesMs].sort((a, b) => a - b);
  const percentile = fraction => sorted[Math.ceil(sorted.length * fraction) - 1];
  artifact.p50Ms = percentile(0.5);
  artifact.p95Ms = percentile(0.95);
  artifact.p99Ms = percentile(0.99);
  console.log('External Production TCP RTT measurement passed');
} catch (error) {
  artifact.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.error(artifact.error);
} finally {
  artifact.finishedAt = new Date().toISOString();
  await mkdir('tests/e2e/artifacts', { recursive: true });
  await writeFile(artifactPath, JSON.stringify(artifact, null, 2) + '\n');
}
