import http from 'k6/http';
import { sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

export const options = {
  scenarios: { polling: { executor: 'constant-vus', vus: Number(__ENV.CLIENTS), duration: `${__ENV.DURATION_SECONDS}s`, gracefulStop: '2s' } },
  summaryTrendStats: ['min', 'med', 'p(95)', 'p(99)', 'max']
};
const unexpectedFailed = new Counter('phase3_unexpected_failed');
const networkFailed = new Counter('phase3_network_failed');
const httpFailed = new Counter('phase3_http_failed');
const contractFailed = new Counter('phase3_contract_failed');
const wrongSlot = new Counter('phase3_wrong_slot');
const winnerDetectionCount = new Counter('phase3_winner_detection_count');
const closeDetectionCount = new Counter('phase3_close_detection_count');
const winnerDetection = new Trend('phase3_winner_detection_ms');
const closeDetection = new Trend('phase3_close_detection_ms');
const roundDetection = new Trend('phase3_round_detection_ms');
let nextPollAt = 0;
let sawWinner = false;
let sawClose = false;
let sawNextRound = false;

export default function () {
  const interval = Number(__ENV.POLL_INTERVAL_MS);
  if (!nextPollAt) nextPollAt = Date.now() + (__VU % interval);
  const delay = nextPollAt - Date.now();
  if (delay > 0) sleep(delay / 1000);
  nextPollAt = Date.now() + interval;
  const response = http.get(`${__ENV.BASE_URL}/api/open-state`, { timeout: '10s' });
  let body;
  try { body = response.json(); } catch { body = null; }
  const valid = response.status === 200 && typeof body?.slotAt === 'string'
    && typeof body.winnerExists === 'boolean' && typeof body.registrationOpen === 'boolean'
    && typeof body.roundEndsAt === 'string';
  if (!valid) {
    unexpectedFailed.add(1);
    if (response.status === 0) networkFailed.add(1);
    else if (response.status !== 200) httpFailed.add(1);
    else contractFailed.add(1);
    return;
  }
  if (body.slotAt !== __ENV.SLOT_AT && !__ENV.ALLOW_BOUNDARY) {
    unexpectedFailed.add(1);
    wrongSlot.add(1);
  }
  if (!sawWinner && body.winnerExists && body.registrationClosesAt) {
    sawWinner = true;
    winnerDetection.add(Date.now() - (Date.parse(body.registrationClosesAt) - 10_000));
    winnerDetectionCount.add(1);
  }
  if (!sawClose && body.winnerExists && !body.registrationOpen && body.registrationClosesAt) {
    sawClose = true;
    closeDetection.add(Date.now() - Date.parse(body.registrationClosesAt));
    closeDetectionCount.add(1);
  }
  if (!sawNextRound && body.slotAt !== __ENV.SLOT_AT) {
    sawNextRound = true;
    roundDetection.add(Date.now() - Date.parse(body.slotAt));
  }
}

export function handleSummary(data) {
  return { [__ENV.SUMMARY_PATH]: JSON.stringify(data, null, 2) };
}
