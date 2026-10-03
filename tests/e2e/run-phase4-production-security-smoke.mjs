import { mkdir, writeFile } from 'node:fs/promises';

const base = process.env.PRODUCTION_BASE_URL;
if (base !== 'https://hourboard.duckdns.org') {
  throw new Error('Production security smoke requires the production HTTPS URL');
}

const artifact = {
  scenario: 'production-http-security-smoke',
  startedAt: new Date().toISOString(),
  measurementVantage: 'work PC LAN via public HTTPS origin',
  responses: {},
  checks: {}
};
const artifactPath = 'tests/e2e/artifacts/phase4-production-security-smoke.json';

function check(name, condition) {
  artifact.checks[name] = Boolean(condition);
  if (!condition) throw new Error(`Production security smoke failed: ${name}`);
}

try {
  for (const path of ['/', '/health', '/api/round']) {
    const response = await fetch(base + path, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
    artifact.responses[path] = {
      status: response.status,
      csp: response.headers.get('content-security-policy'),
      nosniff: response.headers.get('x-content-type-options'),
      referrerPolicy: response.headers.get('referrer-policy')
    };
    await response.arrayBuffer();
  }
  check('root, health, and round are available with security headers',
    Object.values(artifact.responses).every(item => item.status === 200 &&
      item.csp?.includes("default-src 'self'") && item.nosniff === 'nosniff' &&
      item.referrerPolicy === 'no-referrer'));

  const unknown = await fetch(`${base}/api/no-such-route`, { signal: AbortSignal.timeout(10_000) });
  const unknownBody = await unknown.json();
  artifact.responses.unknownApi = { status: unknown.status, contentType: unknown.headers.get('content-type'),
    code: unknownBody.code, hasStack: Object.hasOwn(unknownBody, 'stack') };
  check('unknown API returns JSON 404 without stack', unknown.status === 404 &&
    unknown.headers.get('content-type')?.includes('application/json') &&
    unknownBody.code === 'NOT_FOUND' && !Object.hasOwn(unknownBody, 'stack'));

  const large = await fetch(`${base}/api/attempts`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slotAt: new Date().toISOString(), message: 'x'.repeat(5_000) }),
    signal: AbortSignal.timeout(10_000)
  });
  const largeBody = await large.json();
  artifact.responses.largeBody = { status: large.status, contentType: large.headers.get('content-type'),
    code: largeBody.code, hasStack: Object.hasOwn(largeBody, 'stack') };
  check('oversized body returns JSON 400 without stack', large.status === 400 &&
    large.headers.get('content-type')?.includes('application/json') &&
    largeBody.code === 'INVALID_REQUEST' && !Object.hasOwn(largeBody, 'stack'));
  console.log('Production HTTP security smoke passed');
} catch (error) {
  artifact.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.error(artifact.error);
} finally {
  artifact.finishedAt = new Date().toISOString();
  await mkdir('tests/e2e/artifacts', { recursive: true });
  await writeFile(artifactPath, JSON.stringify(artifact, null, 2) + '\n');
}
