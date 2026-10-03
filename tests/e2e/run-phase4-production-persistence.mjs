import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const base = process.env.PRODUCTION_BASE_URL;
const stage = process.env.PERSISTENCE_STAGE;
if (base !== 'https://hourboard.duckdns.org' || !['before', 'after'].includes(stage)) {
  throw new Error('Production persistence E2E requires production URL and before/after stage');
}
const path = 'tests/e2e/artifacts/phase4-production-db-recreate.json';

async function snapshot() {
  const [health, round] = await Promise.all([
    fetch(`${base}/health`, { signal: AbortSignal.timeout(10_000) }),
    fetch(`${base}/api/round`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
  ]);
  if (health.status !== 200 || round.status !== 200) return null;
  const body = await round.json();
  if (!body.currentSlot.message || !Number.isInteger(body.currentSlot.attemptCount)) return null;
  return {
    sampledAt: new Date().toISOString(),
    slotAt: body.currentSlot.startsAt,
    attemptCount: body.currentSlot.attemptCount,
    winnerMessageSha256: createHash('sha256').update(body.currentSlot.message).digest('hex'),
    healthStatus: health.status,
    roundStatus: round.status
  };
}

await mkdir('tests/e2e/artifacts', { recursive: true });
if (stage === 'before') {
  const before = await snapshot();
  if (!before) throw new Error('Production winner snapshot is unavailable');
  await writeFile(path, JSON.stringify({ scenario: 'production-db-container-recreation',
    volume: 'hourboard-prod_postgres_data', before, after: null, preserved: null }, null, 2) + '\n');
  console.log('Production DB pre-recreation snapshot recorded');
} else {
  const artifact = JSON.parse(await readFile(path, 'utf8'));
  if (!artifact.before) throw new Error('Pre-recreation snapshot is missing');
  let after;
  for (let index = 0; index < 60; index++) {
    try { after = await snapshot(); } catch {}
    if (after) break;
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  if (!after) throw new Error('Production API did not recover after DB recreation');
  artifact.after = after;
  artifact.preserved = artifact.before.slotAt === after.slotAt &&
    artifact.before.attemptCount === after.attemptCount &&
    artifact.before.winnerMessageSha256 === after.winnerMessageSha256;
  await writeFile(path, JSON.stringify(artifact, null, 2) + '\n');
  if (!artifact.preserved) throw new Error('Production winner or attemptCount changed after DB recreation');
  console.log('Production DB container recreation preserved winner and attemptCount');
}
