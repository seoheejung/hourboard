type RoundResponse = {
  serverTime: string;
  currentSlot: { startsAt: string; endsAt: string; message: string | null; attemptCount: number | null };
  nextSlotAt: string;
};

type AttemptResponse = {
  code: string;
  message: string;
  position: number | null;
  winner: boolean;
  slotAt?: string;
};

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing UI element: ${id}`);
  return found as T;
}

const board = element<HTMLElement>('board-message');
const endsAt = element<HTMLElement>('ends-at');
const countdown = element<HTMLElement>('countdown');
const roundStatus = element<HTMLElement>('round-status');
const form = element<HTMLFormElement>('attempt-form');
const input = element<HTMLInputElement>('message-input');
const remaining = element<HTMLElement>('remaining');
const submitButton = element<HTMLButtonElement>('submit-button');
const result = element<HTMLElement>('result');
const HOUR_MS = 3_600_000;

let serverOffsetMs = 0;
let round: RoundResponse | null = null;
let targetSlotAt: string | null = null;
let localWinner: { slotAt: string; message: string } | null = null;
let pending = false;
let syncInFlight = false;
let roundError = false;
let observedBoundary: string | null = null;
let preferCurrentOnNextSync = false;

function serverNow() { return Date.now() + serverOffsetMs; }
function validMessage() {
  const value = input.value.trim();
  return value.length > 0 && Array.from(value).length <= 120 && !/[\r\n\u2028\u2029]/u.test(value);
}
function canSubmit() {
  if (!targetSlotAt || pending || !validMessage()) return false;
  const now = serverNow();
  const start = Date.parse(targetSlotAt);
  return now >= start && now < start + HOUR_MS;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23'
  }).format(new Date(value));
}

function showResult(state: 'winner' | 'ranked' | 'error', title: string, detail: string, position?: number) {
  result.replaceChildren();
  result.dataset.state = state;
  const heading = document.createElement('h2');
  heading.textContent = title;
  result.append(heading);
  if (position !== undefined) {
    const rank = document.createElement('p');
    rank.className = 'position';
    rank.textContent = `${position}번째`;
    result.append(rank);
  }
  const description = document.createElement('p');
  description.textContent = detail;
  result.append(description);
  if (state === 'ranked') {
    const support = document.createElement('p');
    support.className = 'support';
    support.textContent = '서버 처리 기준 순위입니다.';
    result.append(support);
  }
}

function applyRound(next: RoundResponse) {
  const previousSlot = round?.currentSlot.startsAt;
  round = next;
  if (previousSlot && previousSlot !== next.currentSlot.startsAt) {
    localWinner = null;
    result.replaceChildren();
    delete result.dataset.state;
  }
  if (preferCurrentOnNextSync) {
    targetSlotAt = next.currentSlot.startsAt;
    preferCurrentOnNextSync = false;
  } else if (!targetSlotAt || serverNow() >= Date.parse(targetSlotAt) + HOUR_MS) {
    targetSlotAt = next.nextSlotAt;
  }
  if (localWinner?.slotAt !== next.currentSlot.startsAt) localWinner = null;
  board.textContent = next.currentSlot.message ?? localWinner?.message ?? '아직 등록된 문구가 없습니다.';
  endsAt.textContent = `이 문구는 ${formatTime(next.currentSlot.endsAt)}까지 표시됩니다.`;
  observedBoundary = null;
  tick();
}

async function syncRound() {
  if (syncInFlight) return;
  syncInFlight = true;
  const sentAt = Date.now();
  try {
    const response = await fetch('/api/round', { cache: 'no-store' });
    if (!response.ok) throw new Error('Round unavailable');
    const data = await response.json() as RoundResponse;
    if (!data.currentSlot || !data.serverTime || !data.nextSlotAt) throw new Error('Invalid round response');
    serverOffsetMs = Date.parse(data.serverTime) - (sentAt + Date.now()) / 2;
    roundError = false;
    applyRound(data);
  } catch {
    roundError = true;
    if (!round) {
      board.textContent = '현재 전광판을 불러오지 못했습니다.';
      endsAt.textContent = '서버 연결을 확인해 주세요.';
    }
  } finally {
    syncInFlight = false;
    tick();
  }
}

function tick() {
  if (!round) {
    roundStatus.textContent = roundError ? '서버 연결을 확인해 주세요.' : '서버 시각을 확인하는 중입니다.';
    submitButton.disabled = true;
    return;
  }
  const remainingMs = Math.max(0, Date.parse(round.nextSlotAt) - serverNow());
  const minutes = Math.floor(remainingMs / 60_000);
  const seconds = Math.floor((remainingMs % 60_000) / 1000);
  const millis = Math.floor(remainingMs % 1000);
  countdown.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
  if (pending) roundStatus.textContent = '등록 결과를 기다리는 중입니다.';
  else if (roundError) roundStatus.textContent = '전광판 갱신이 지연되고 있습니다.';
  else if (targetSlotAt && serverNow() < Date.parse(targetSlotAt)) roundStatus.textContent = '문구를 미리 입력하고 다음 정각에 등록해 주세요.';
  else roundStatus.textContent = '현재 라운드에 등록할 수 있습니다.';
  submitButton.disabled = !canSubmit();
  submitButton.textContent = pending ? '등록 중…' : '등록하기';
  if (remainingMs === 0 && observedBoundary !== round.nextSlotAt) {
    observedBoundary = round.nextSlotAt;
    void syncRound();
  }
}

input.addEventListener('input', () => {
  const chars = Array.from(input.value);
  if (chars.length > 120) input.value = chars.slice(0, 120).join('');
  remaining.textContent = `${120 - Array.from(input.value).length}자 남음`;
  tick();
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!canSubmit() || !targetSlotAt) return;
  const slotAt = targetSlotAt;
  const message = input.value.trim();
  pending = true;
  tick();
  try {
    const response = await fetch('/api/attempts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slotAt, message })
    });
    const data = await response.json() as AttemptResponse;
    if (response.ok && data.slotAt === slotAt && data.code === 'WINNER' && data.position === 1 && data.winner === true) {
      showResult('winner', '축하합니다!', data.message);
      localWinner = { slotAt, message };
      if (round?.currentSlot.startsAt === slotAt) board.textContent = message;
    } else if (response.ok && data.slotAt === slotAt && data.code === 'RANKED' && Number.isInteger(data.position) && data.position! >= 2 && data.winner === false) {
      showResult('ranked', '아쉽군요!', data.message, data.position!);
      void syncRound();
    } else if (!response.ok && data.code === 'INVALID_REQUEST') {
      showResult('error', '입력을 확인해 주세요.', '한 줄의 문구를 1~120자로 입력해 주세요.');
    } else if (!response.ok && data.code === 'INVALID_SLOT') {
      showResult('error', '라운드 정보를 확인해 주세요.', '현재 라운드 정보를 다시 불러옵니다.');
      preferCurrentOnNextSync = true;
      void syncRound();
    } else if (!response.ok && data.code === 'ROUND_NOT_STARTED') {
      showResult('error', '아직 시작 전입니다.', '다음 정각에 다시 등록해 주세요.');
    } else if (!response.ok && data.code === 'ROUND_ENDED') {
      showResult('error', '이미 종료된 라운드입니다.', '현재 라운드 정보를 다시 불러옵니다.');
      preferCurrentOnNextSync = true;
      void syncRound();
    } else {
      showResult('error', '등록 결과를 확인하지 못했습니다.', '다시 등록하면 새로운 도전으로 처리됩니다.');
    }
  } catch {
    showResult('error', '등록 결과를 확인하지 못했습니다.', '다시 등록하면 새로운 도전으로 처리됩니다.');
  } finally {
    pending = false;
    tick();
  }
});

void syncRound();
setInterval(tick, 50);
setInterval(() => { void syncRound(); }, 10_000);
