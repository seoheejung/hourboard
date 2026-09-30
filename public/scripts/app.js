"use strict";
function element(id) {
    const found = document.getElementById(id);
    if (!found)
        throw new Error(`Missing UI element: ${id}`);
    return found;
}
const board = element('board-message');
const boardHeading = element('board-heading');
const endsAt = element('ends-at');
const countdown = element('countdown');
const roundStatus = element('round-status');
const form = element('attempt-form');
const input = element('message-input');
const remaining = element('remaining');
const submitButton = element('submit-button');
const result = element('result');
const HOUR_MS = 3_600_000;
const BUTTON_PREVIEW_MS = 5 * 60_000;
const OPEN_STATE_POLL_MS = 1000;
const MAX_MESSAGE_LENGTH = 120;
let serverOffsetMs = 0;
let round = null;
let targetSlotAt = null;
let registrationClosesAt = null;
let localWinner = null;
let pending = false;
let syncInFlight = false;
let openStateInFlight = false;
let roundError = false;
let openStateError = false;
let observedBoundary = null;
let boundaryRetryCount = 0;
let displayedBoardMessage = '';
let clearedClosedSlotAt = null;
function serverNow() { return Date.now() + serverOffsetMs; }
function validMessage() {
    const value = input.value;
    return value.trim().length > 0 && Array.from(value).length <= MAX_MESSAGE_LENGTH && !/[\r\n\u2028\u2029]/u.test(value);
}
function canSubmit() {
    if (!targetSlotAt || round?.currentSlot.registrationOpen === false || pending || !validMessage())
        return false;
    const now = serverNow();
    const start = Date.parse(targetSlotAt);
    return now >= start && now < start + HOUR_MS
        && (!registrationClosesAt || now < Date.parse(registrationClosesAt));
}
function formatTime(value) {
    return new Intl.DateTimeFormat('ko-KR', {
        timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23'
    }).format(new Date(value));
}
function formatHour(value) {
    const parts = new Intl.DateTimeFormat('ko-KR', {
        timeZone: 'Asia/Seoul', hour: 'numeric', hour12: false, hourCycle: 'h23'
    }).formatToParts(new Date(value));
    return Number(parts.find(part => part.type === 'hour')?.value);
}
function showBoardMessage(message) {
    if (displayedBoardMessage === message)
        return;
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
function showResult(state, title, detail) {
    result.replaceChildren();
    result.dataset.state = state;
    const heading = document.createElement('h2');
    heading.textContent = title;
    result.append(heading);
    const description = document.createElement('p');
    description.textContent = detail;
    result.append(description);
}
function advanceRound() {
    if (!round)
        return;
    const startsAt = new Date(Math.max(Date.parse(round.nextSlotAt), Math.floor(serverNow() / HOUR_MS) * HOUR_MS)).toISOString();
    const endsAt = new Date(Date.parse(startsAt) + HOUR_MS).toISOString();
    applyRound({
        serverTime: new Date(serverNow()).toISOString(),
        currentSlot: {
            startsAt, endsAt, message: null, attemptCount: null,
            registrationOpen: true, registrationClosesAt: null
        },
        nextSlotAt: endsAt
    });
    void syncRound();
}
function applyRound(next) {
    const previousSlot = round?.currentSlot.startsAt;
    round = next;
    if (previousSlot && previousSlot !== next.currentSlot.startsAt) {
        localWinner = null;
        registrationClosesAt = null;
        openStateError = false;
        boundaryRetryCount = 0;
        result.replaceChildren();
        delete result.dataset.state;
    }
    targetSlotAt = next.currentSlot.startsAt;
    registrationClosesAt = next.currentSlot.registrationClosesAt ?? registrationClosesAt;
    if (localWinner?.slotAt !== next.currentSlot.startsAt)
        localWinner = null;
    boardHeading.textContent = `${formatHour(next.currentSlot.startsAt)}시 전광판`;
    showBoardMessage(next.currentSlot.message ?? localWinner?.message ?? '아직 등록된 문구가 없습니다.');
    endsAt.textContent = `이 문구는 ${formatTime(next.currentSlot.endsAt)}까지 표시됩니다.`;
    observedBoundary = null;
    tick();
}
async function syncRound() {
    if (syncInFlight)
        return;
    syncInFlight = true;
    const sentAt = Date.now();
    try {
        const response = await fetch('/api/round', { cache: 'no-store' });
        if (!response.ok)
            throw new Error('Round unavailable');
        const data = await response.json();
        if (!data.currentSlot || !data.serverTime || !data.nextSlotAt
            || typeof data.currentSlot.registrationOpen !== 'boolean'
            || (data.currentSlot.registrationClosesAt !== null && !Number.isFinite(Date.parse(data.currentSlot.registrationClosesAt)))) {
            throw new Error('Invalid round response');
        }
        serverOffsetMs = Date.parse(data.serverTime) - (sentAt + Date.now()) / 2;
        roundError = false;
        applyRound(data);
    }
    catch {
        roundError = true;
        if (!round) {
            showBoardMessage('전광판을 불러오지 못했습니다.');
            endsAt.textContent = '서버 연결을 확인해 주세요.';
        }
    }
    finally {
        syncInFlight = false;
        tick();
        if (!syncInFlight && round && serverNow() >= Date.parse(round.nextSlotAt) && boundaryRetryCount < 20) {
            boundaryRetryCount++;
            setTimeout(() => { void syncRound(); }, 100);
        }
    }
}
async function syncOpenState() {
    if (openStateInFlight || !round || pending || round.currentSlot.registrationOpen === false
        || registrationClosesAt || serverNow() >= Date.parse(round.currentSlot.endsAt))
        return;
    openStateInFlight = true;
    const requestedSlot = round.currentSlot.startsAt;
    try {
        const response = await fetch('/api/open-state');
        if (!response.ok)
            throw new Error('Open state unavailable');
        const data = await response.json();
        if (!Number.isFinite(Date.parse(data.slotAt)) || typeof data.winnerExists !== 'boolean'
            || typeof data.registrationOpen !== 'boolean'
            || (data.registrationClosesAt !== null && !Number.isFinite(Date.parse(data.registrationClosesAt)))
            || (data.winnerExists && data.registrationClosesAt === null)) {
            throw new Error('Invalid open state response');
        }
        if (!round || round.currentSlot.startsAt !== requestedSlot)
            return;
        if (data.slotAt !== requestedSlot) {
            if (Date.parse(data.slotAt) > Date.parse(requestedSlot))
                void syncRound();
            return;
        }
        openStateError = false;
        if (data.registrationClosesAt) {
            registrationClosesAt = data.registrationClosesAt;
            round.currentSlot.registrationClosesAt = data.registrationClosesAt;
            round.currentSlot.registrationOpen = data.registrationOpen;
            void syncRound();
        }
        else if (!data.registrationOpen) {
            round.currentSlot.registrationOpen = false;
            void syncRound();
        }
    }
    catch {
        if (round?.currentSlot.startsAt === requestedSlot)
            openStateError = true;
    }
    finally {
        openStateInFlight = false;
        tick();
    }
}
function tick() {
    if (!round) {
        roundStatus.textContent = roundError ? '서버 연결을 확인해 주세요.' : '서버 시각을 확인하는 중입니다.';
        submitButton.hidden = true;
        submitButton.disabled = true;
        return;
    }
    const now = serverNow();
    const remainingMs = Math.max(0, Date.parse(round.nextSlotAt) - now);
    const registrationClosed = round.currentSlot.registrationOpen === false
        || (registrationClosesAt !== null && now >= Date.parse(registrationClosesAt));
    submitButton.hidden = registrationClosed && remainingMs > BUTTON_PREVIEW_MS;
    if (submitButton.hidden && !pending && clearedClosedSlotAt !== round.currentSlot.startsAt) {
        clearedClosedSlotAt = round.currentSlot.startsAt;
        input.value = '';
        remaining.textContent = `${MAX_MESSAGE_LENGTH}자 남음`;
        input.setAttribute('aria-invalid', 'false');
        result.replaceChildren();
        delete result.dataset.state;
    }
    const minutes = Math.floor(remainingMs / 60_000);
    const seconds = Math.floor((remainingMs % 60_000) / 1000);
    countdown.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    if (pending)
        roundStatus.textContent = '등록 결과를 기다리는 중입니다.';
    else if (roundError)
        roundStatus.textContent = '전광판 갱신이 지연되고 있습니다.';
    else if (openStateError && !registrationClosesAt)
        roundStatus.textContent = '등록 상태 갱신이 지연되고 있습니다.';
    else if (targetSlotAt && serverNow() < Date.parse(targetSlotAt))
        roundStatus.textContent = '문구를 미리 입력하고 다음 정각에 등록해 주세요.';
    else if (targetSlotAt && serverNow() >= Date.parse(targetSlotAt) + HOUR_MS)
        roundStatus.textContent = '새 라운드를 확인하는 중입니다.';
    else if (registrationClosed && remainingMs <= BUTTON_PREVIEW_MS)
        roundStatus.textContent = '다음 정각에 등록 버튼이 활성화됩니다.';
    else if (registrationClosed)
        roundStatus.textContent = '다음 정각 5분 전에 등록 버튼이 나타납니다.';
    else if (registrationClosesAt)
        roundStatus.textContent = `등록 마감까지 ${Math.ceil((Date.parse(registrationClosesAt) - serverNow()) / 1000)}초`;
    else
        roundStatus.textContent = '현재 라운드에 등록할 수 있습니다.';
    submitButton.disabled = !canSubmit();
    submitButton.textContent = pending ? '등록 중…' : '등록하기';
    if (remainingMs === 0 && observedBoundary !== round.nextSlotAt) {
        observedBoundary = round.nextSlotAt;
        advanceRound();
    }
}
function updateInputCount() {
    const characters = Array.from(input.value);
    if (characters.length > MAX_MESSAGE_LENGTH)
        input.value = characters.slice(0, MAX_MESSAGE_LENGTH).join('');
    remaining.textContent = `${MAX_MESSAGE_LENGTH - Array.from(input.value).length}자 남음`;
    input.setAttribute('aria-invalid', 'false');
    tick();
}
input.addEventListener('input', event => {
    if (!(event instanceof InputEvent && event.isComposing))
        updateInputCount();
});
input.addEventListener('compositionend', updateInputCount);
form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!canSubmit() || !targetSlotAt)
        return;
    const slotAt = targetSlotAt;
    const message = input.value.trim();
    pending = true;
    tick();
    try {
        const response = await fetch('/api/attempts', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ slotAt, message })
        });
        const data = await response.json();
        if (response.ok && data.slotAt === slotAt && data.code === 'WINNER' && data.position === 1 && data.winner === true) {
            if (round?.currentSlot.startsAt === slotAt && data.registrationClosesAt)
                registrationClosesAt = data.registrationClosesAt;
            showResult('winner', '축하합니다!', data.message);
            localWinner = { slotAt, message };
            if (round?.currentSlot.startsAt === slotAt)
                showBoardMessage(message);
        }
        else if (response.ok && data.slotAt === slotAt && data.code === 'RANKED' && Number.isInteger(data.position) && data.position >= 2 && data.winner === false) {
            if (round?.currentSlot.startsAt === slotAt && data.registrationClosesAt)
                registrationClosesAt = data.registrationClosesAt;
            showResult('ranked', '아쉽군요!', data.message);
            void syncRound();
        }
        else if (!response.ok && data.code === 'INVALID_REQUEST') {
            showResult('error', '입력을 확인해 주세요.', '문구를 1~120자로 입력해 주세요.');
        }
        else if (!response.ok && data.code === 'INVALID_SLOT') {
            showResult('error', '라운드 정보를 확인해 주세요.', '현재 라운드 정보를 다시 불러옵니다.');
            void syncRound();
        }
        else if (!response.ok && data.code === 'ROUND_NOT_STARTED') {
            showResult('error', '아직 시작 전입니다.', '다음 정각에 다시 등록해 주세요.');
            void syncRound();
        }
        else if (!response.ok && data.code === 'ROUND_ENDED') {
            showResult('error', '이미 종료된 라운드입니다.', '현재 라운드 정보를 다시 불러옵니다.');
            void syncRound();
        }
        else if (!response.ok && data.code === 'REGISTRATION_CLOSED') {
            if (round?.currentSlot.startsAt === slotAt)
                registrationClosesAt = new Date(serverNow()).toISOString();
            showResult('error', '등록이 마감되었습니다.', data.message);
            void syncRound();
        }
        else {
            showResult('error', '등록 결과를 확인하지 못했습니다.', '다시 등록하면 새로운 도전으로 처리됩니다.');
        }
    }
    catch {
        showResult('error', '등록 결과를 확인하지 못했습니다.', '다시 등록하면 새로운 도전으로 처리됩니다.');
    }
    finally {
        pending = false;
        tick();
    }
});
void syncRound();
setInterval(tick, 50);
setInterval(() => { void syncRound(); }, 10_000);
setInterval(() => { void syncOpenState(); }, OPEN_STATE_POLL_MS);
