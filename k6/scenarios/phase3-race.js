import http from 'k6/http';
import { sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const concurrency = Number(__ENV.CONCURRENCY);
export const options = {
  scenarios: { race: { executor: 'per-vu-iterations', vus: concurrency, iterations: 1, maxDuration: '45s' } },
  summaryTrendStats: ['min', 'med', 'p(95)', 'p(99)', 'max']
};
const accepted = new Counter('phase3_accepted');
const winner = new Counter('phase3_winner');
const registrationClosed = new Counter('phase3_registration_closed');
const unexpectedFailed = new Counter('phase3_unexpected_failed');
const dispatchEpoch = new Trend('phase3_dispatch_epoch_ms');

export default function () {
  while (Date.now() < Number(__ENV.BARRIER_AT)) sleep(0.001);
  const message = `${__ENV.MESSAGE_PREFIX}-vu-${String(__VU).padStart(3, '0')}`;
  dispatchEpoch.add(Date.now());
  const response = http.post(`${__ENV.BASE_URL}/api/attempts`, JSON.stringify({ slotAt: __ENV.SLOT_AT, message }), {
    headers: { 'content-type': 'application/json' }, timeout: '25s'
  });
  let body;
  try { body = response.json(); } catch { body = null; }
  if (response.status === 200 && ((body?.code === 'WINNER' && body.position === 1 && body.winner === true)
    || (body?.code === 'RANKED' && Number.isInteger(body.position) && body.position >= 2 && body.winner === false))) {
    accepted.add(1);
    if (body.code === 'WINNER') winner.add(1);
  } else if (response.status === 409 && body?.code === 'REGISTRATION_CLOSED'
    && body.position === null && body.winner === false) {
    registrationClosed.add(1);
  } else {
    unexpectedFailed.add(1);
  }
}

export function handleSummary(data) {
  return { [__ENV.SUMMARY_PATH]: JSON.stringify(data, null, 2) };
}
