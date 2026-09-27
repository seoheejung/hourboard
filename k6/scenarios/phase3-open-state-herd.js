import http from 'k6/http';
import { sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const concurrency = Number(__ENV.CONCURRENCY);
export const options = {
  scenarios: { openStateHerd: { executor: 'per-vu-iterations', vus: concurrency, iterations: 1, maxDuration: '45s' } },
  summaryTrendStats: ['min', 'med', 'p(95)', 'p(99)', 'max']
};
const accepted = new Counter('phase3_open_state_accepted');
const unexpectedFailed = new Counter('phase3_unexpected_failed');
const dispatchEpoch = new Trend('phase3_dispatch_epoch_ms');

export default function () {
  while (Date.now() < Number(__ENV.BARRIER_AT)) sleep(0.001);
  dispatchEpoch.add(Date.now());
  const response = http.get(`${__ENV.BASE_URL}/api/open-state`, { timeout: '25s' });
  let state;
  try { state = response.json(); } catch { state = null; }
  if (response.status === 200 && state?.slotAt === __ENV.SLOT_AT
    && state.winnerExists === false && state.registrationOpen === true
    && state.registrationClosesAt === null) accepted.add(1);
  else unexpectedFailed.add(1);
}

export function handleSummary(data) {
  return { [__ENV.SUMMARY_PATH]: JSON.stringify(data, null, 2) };
}
