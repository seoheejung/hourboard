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
const boardHeading = element<HTMLElement>('board-heading');
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
let displayedBoardMessage = '';

function serverNow() { return Date.now() + serverOffsetMs; }
function validMessage() {
  const value = input.value;
  return value.trim().length > 0 && Array.from(value).length <= 120 && !/[\r\n\u2028\u2029]/u.test(value);
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

function formatHour(value: string) {
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', hour: 'numeric', hour12: false, hourCycle: 'h23'
  }).formatToParts(new Date(value));
  return Number(parts.find(part => part.type === 'hour')?.value);
}

function showBoardMessage(message: string) {
  if (displayedBoardMessage === message) return;
  displayedBoardMessage = message;
  board.classList.remove('is-scrolling');
  board.textContent = '';
  board.parentElement?.setAttribute('aria-label', message);
  board.setAttribute('aria-hidden', 'true');
  const group = document.createElement('span');
  group.className = 'ticker-group';
  group.textContent = `${message}　　`;
  board.append(group);
  const visibleWidth = board.parentElement?.clientWidth ?? 0;
  while (group.getBoundingClientRect().width < visibleWidth + 80) {
    group.textContent += `${message}　　`;
  }
  board.append(group.cloneNode(true));
  board.style.setProperty('--ticker-duration', `${Math.max(10, group.getBoundingClientRect().width / 55)}s`);
  board.classList.add('is-scrolling');
}

function showResult(state: 'winner' | 'ranked' | 'error', title: string, detail: string) {
  result.replaceChildren();
  result.dataset.state = state;
  const heading = document.createElement('h2');
  heading.textContent = title;
  result.append(heading);
  const description = document.createElement('p');
  description.textContent = detail;
  result.append(description);
}

function applyRound(next: RoundResponse) {
  const previousSlot = round?.currentSlot.startsAt;
  round = next;
  if (previousSlot && previousSlot !== next.currentSlot.startsAt) {
    localWinner = null;
    result.replaceChildren();
    delete result.dataset.state;
  }
  targetSlotAt = next.currentSlot.startsAt;
  if (localWinner?.slotAt !== next.currentSlot.startsAt) localWinner = null;
  boardHeading.textContent = `${formatHour(next.currentSlot.startsAt)}시 전광판`;
  showBoardMessage(next.currentSlot.message ?? localWinner?.message ?? '아직 등록된 문구가 없습니다.');
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
      showBoardMessage('전광판을 불러오지 못했습니다.');
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
  else if (targetSlotAt && serverNow() >= Date.parse(targetSlotAt) + HOUR_MS) roundStatus.textContent = '새 라운드를 확인하는 중입니다.';
  else roundStatus.textContent = '현재 라운드에 등록할 수 있습니다.';
  submitButton.disabled = !canSubmit();
  submitButton.textContent = pending ? '등록 중…' : '등록하기';
  if (remainingMs === 0 && observedBoundary !== round.nextSlotAt) {
    observedBoundary = round.nextSlotAt;
    void syncRound();
  }
}

input.addEventListener('input', () => {
  const left = 120 - Array.from(input.value).length;
  remaining.textContent = left >= 0 ? `${left}자 남음` : `${-left}자 초과`;
  input.setAttribute('aria-invalid', String(left < 0));
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
      if (round?.currentSlot.startsAt === slotAt) showBoardMessage(message);
    } else if (response.ok && data.slotAt === slotAt && data.code === 'RANKED' && Number.isInteger(data.position) && data.position! >= 2 && data.winner === false) {
      showResult('ranked', '아쉽군요!', data.message);
      void syncRound();
    } else if (!response.ok && data.code === 'INVALID_REQUEST') {
      showResult('error', '입력을 확인해 주세요.', '한 줄의 문구를 1~120자로 입력해 주세요.');
    } else if (!response.ok && data.code === 'INVALID_SLOT') {
      showResult('error', '라운드 정보를 확인해 주세요.', '현재 라운드 정보를 다시 불러옵니다.');
      void syncRound();
    } else if (!response.ok && data.code === 'ROUND_NOT_STARTED') {
      showResult('error', '아직 시작 전입니다.', '다음 정각에 다시 등록해 주세요.');
    } else if (!response.ok && data.code === 'ROUND_ENDED') {
      showResult('error', '이미 종료된 라운드입니다.', '현재 라운드 정보를 다시 불러옵니다.');
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
