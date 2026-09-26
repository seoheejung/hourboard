# HourBoard MVP 구현 지시서

> 대상: OpenAI Codex
> 목표: 한 번의 작업 흐름으로 HourBoard MVP(Phase 1 + Phase 2)를 구현하고 실제 PostgreSQL 기반 E2E 검증, 결과 문서화, Phase별 commit까지 완료

---

## 0. 실행 모드

이 지시서는 **중간 승인 대기 없이 MVP 완료까지 연속으로 진행하는 단일 작업 지시서**다.

작업 우선순위는 저장소의 `AGENTS.md`를 따른다.

```text
사용자의 현재 명시적 지시
↓
.project/plan.md
↓
docs/instructions/mvp.md
↓
DESIGN.md
↓
AGENTS.md
↓
README.md
```

현재 작업에서 구현할 범위는 `.project/plan.md`의 아래 두 Phase뿐이다.

```text
Phase 1 — Concurrency Core
Phase 2 — Ticketing UI
```

Phase 3 이후 기능은 구현하지 않는다.

이 작업이 끝나면 **MVP 완료 상태에서 멈춘다.**

---

## 1. 이번 작업에서 명시적으로 승인된 항목

`AGENTS.md`의 의존성 승인 규칙에 대해, 이번 지시 자체를 아래 범위의 명시적 승인으로 취급한다.

### 승인

- MVP 구현에 필요한 npm 패키지 설치
- `package.json` 생성 및 수정
- `package-lock.json` 생성 및 갱신
- TypeScript 설정 파일 생성
- 로컬 개발 및 E2E용 `compose.yaml` 생성
- 실제 PostgreSQL 18.x 컨테이너 실행
- DB migration 실행
- E2E 실행을 위해 필요한 로컬 프로세스 실행
- Phase 1 완료 후 commit 1회
- Phase 2 완료 후 commit 1회

### 승인하지 않음

- `git push`
- OCI 리소스 생성
- 실제 운영 배포
- 유료 서비스 생성
- prerelease dependency 설치
- Redis 도입
- ORM 도입
- 테스트 프레임워크를 이용한 단위 테스트 작성
- Phase 3 k6 부하 테스트 구현
- Phase 4 OCI 배포 작업

필요한 dependency는 현재 MVP 기능을 구현하는 최소 범위로 제한한다.

---

## 2. 작업 시작 전 반드시 읽을 파일

코드를 작성하기 전에 아래 파일을 모두 읽는다.

```text
.project/plan.md
AGENTS.md
DESIGN.md
README.md
.gitignore
```

특히 아래 항목을 구현 전에 다시 확인한다.

- 서비스 규칙
- 시간 모델
- 문구 정책
- 기능 요구사항 FR-01 ~ FR-12
- 비기능 요구사항 NFR-01 ~ NFR-10
- `hour_slots` 데이터 모델
- atomic UPSERT
- API 계약
- 오류 계약
- 등록 critical path
- E2E 불변식
- MVP 완료 판정 체크리스트
- 디자인 상태 정의

문서와 이 지시서가 충돌하면 `.project/plan.md`를 우선한다.

기획 변경이 필요하다고 판단해도 임의로 범위를 확장하지 않는다.

---

## 3. 구현 전 실패 경로 작성

`AGENTS.md` 규칙에 따라 코드 작성 전에 시스템이 실패할 수 있는 경로를 먼저 정리한다.

별도 단위 테스트를 만들지 않는다.

최소한 아래 실패 경로를 작업 메모 수준으로 먼저 확인하고 구현에 반영한다.

```text
1. 동시에 여러 요청이 모두 Winner라고 판단하는 문제
2. Position 중복
3. Position 누락
4. Position 2 이후 요청이 Winner 문구를 덮어쓰는 문제
5. 정각 이전 요청이 DB에 기록되는 문제
6. 지난 Slot 요청이 현재 Slot에 반영되는 문제
7. 브라우저 시간 오차로 등록 가능 시점이 어긋나는 문제
8. 같은 버튼을 빠르게 여러 번 눌러 중복 요청이 발생하는 문제
9. DB 처리 후 HTTP 응답 유실 시 자동 재시도로 순위가 추가 소비되는 문제
10. PostgreSQL 연결 실패인데 임의 Position을 반환하는 문제
11. HTML/Script 문자열이 실제 markup으로 렌더링되는 문제
12. 80자 초과 또는 줄바꿈 문구가 DB까지 도달하는 문제
13. Slot 전환 후 이전 Winner가 계속 표시되는 문제
14. request마다 PostgreSQL connection을 새로 만드는 문제
15. 등록 처리 전후 SELECT가 추가되어 정상 경로 DB query가 2회 이상이 되는 문제
16. 서버 재시작으로 Winner/Position이 초기화되는 문제
17. production 오류 응답에 stack trace 또는 DB 정보가 노출되는 문제
```

이 목록을 별도 장문 문서로 확장할 필요는 없다.

구현 시 실제 방어가 필요한 항목을 놓치지 않는 것이 목적이다.

---

## 4. MVP 기술 구성

아래 구성을 사용한다.

```text
Runtime      Node.js 24 LTS
Language     TypeScript
Backend      Fastify 5.x
Database     PostgreSQL 18.x
Package      npm
Frontend     HTML + CSS + Browser TypeScript
Dev DB       Docker Compose + official PostgreSQL image
Testing      실제 서버 + 실제 PostgreSQL 기반 E2E
```

### 최소 runtime dependency

필요성이 확인되는 범위에서 아래 계열만 사용한다.

```text
fastify
@fastify/static
pg
```

### 최소 dev dependency

```text
typescript
tsx
@types/node
@types/pg
```

추가 dependency가 정말 필요한 경우에만 추가한다.

아래는 추가하지 않는다.

```text
ORM
Redis client
React
Vue
Svelte
Next.js
NestJS
Jest
Vitest
Mocha
Playwright
Cypress
k6 npm wrapper
외부 validation framework
외부 date/time library
```

Fastify JSON Schema와 표준 Web API / Node API로 해결 가능한 문제는 dependency를 늘리지 않는다.

---

## 5. 목표 프로젝트 구조

기존 구조를 존중하면서 MVP 구현에 필요한 파일만 추가한다.

권장 최종 구조는 아래와 같다.

```text
hourboard/
├─ .project/
│  └─ plan.md
├─ db/
│  └─ migrations/
│     └─ 001_create_hour_slots.sql
├─ docs/
│  ├─ instructions/
│  │  └─ mvp.md
│  └─ results/
│     ├─ phase1-concurrency-core.md
│     └─ phase2-ticketing-ui.md
├─ src/
│  ├─ client/
│  │  └─ app.ts
│  ├─ config/
│  │  └─ env.ts
│  ├─ db/
│  │  ├─ pool.ts
│  │  └─ slots.ts
│  ├─ routes/
│  │  ├─ attempts.ts
│  │  ├─ health.ts
│  │  └─ round.ts
│  ├─ schemas/
│  │  └─ api.ts
│  ├─ services/
│  │  ├─ attempt-service.ts
│  │  └─ slot-time.ts
│  ├─ shared/
│  │  └─ types.ts
│  └─ server.ts
├─ public/
│  ├─ scripts/
│  │  └─ app.js
│  ├─ styles/
│  │  └─ app.css
│  └─ index.html
├─ tests/
│  └─ e2e/
│     ├─ artifacts/
│     ├─ run-e2e.ts
│     └─ run-ui-e2e.ts
├─ .env.example
├─ .gitignore
├─ compose.yaml
├─ package.json
├─ package-lock.json
├─ tsconfig.json
├─ tsconfig.server.json
├─ tsconfig.client.json
├─ AGENTS.md
├─ DESIGN.md
└─ README.md
```

파일명은 실제 구현 책임상 더 자연스러운 경우 최소한으로 조정할 수 있다.

불필요한 계층과 generic abstraction은 만들지 않는다.

---

# Phase 1 — Concurrency Core

## 6. Phase 1 목표

실제 PostgreSQL을 사용하여 아래 흐름을 완성한다.

```text
HTTP request
→ Fastify validation
→ server time / target slot validation
→ PostgreSQL atomic UPSERT 1회
→ position / winner 결정
→ JSON response
```

Phase 1 완료 전에 UI 작업으로 넘어가지 않는다.

---

## 7. 개발용 PostgreSQL

MVP 로컬 검증을 위해 `compose.yaml`에 PostgreSQL 18.x를 구성한다.

목적은 **실제 PostgreSQL 기반 E2E 재현 환경 제공**이다.

개발용 설정만 포함한다.

요구사항:

- official PostgreSQL image 사용
- 로컬 개발용 database/user/password만 사용
- credential은 운영 값과 분리
- persistent named volume 사용 가능
- healthcheck 제공
- 불필요한 관리 UI 추가 금지

예상 개발 환경 변수 이름은 `.project/plan.md`와 맞춘다.

```text
NODE_ENV
PORT
DATABASE_URL
MAX_MESSAGE_LENGTH
```

`.env.example`에는 비밀 운영값을 넣지 않는다.

---

## 8. Migration

`db/migrations/001_create_hour_slots.sql`에 `hour_slots`를 생성한다.

Schema 의미는 `.project/plan.md`와 동일해야 한다.

```sql
CREATE TABLE hour_slots (
    slot_start      TIMESTAMPTZ PRIMARY KEY,
    winner_message  TEXT NOT NULL,
    attempt_count   BIGINT NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT hour_slots_attempt_count_check
        CHECK (attempt_count >= 1),

    CONSTRAINT hour_slots_winner_message_length_check
        CHECK (char_length(winner_message) BETWEEN 1 AND 80)
);
```

migration 실행 방법을 npm script 또는 명확한 CLI 절차로 제공한다.

migration framework는 도입하지 않는다.

---

## 9. 환경 변수 처리

`src/config/`에서 환경 변수를 읽고 검증한다.

원칙:

- 필수 환경 변수 누락 시 startup fail-fast
- `PORT` 숫자 변환 검증
- `MAX_MESSAGE_LENGTH` 숫자 변환 검증
- 기본 최대 길이는 80
- 운영 DB credential 기본값 금지
- production에서 stack trace 노출 금지

주석이 필요하면 `AGENTS.md`의 짧은 명사형 주석 규칙을 따른다.

---

## 10. PostgreSQL Pool

애플리케이션 시작 시 pool을 1회 생성한다.

금지:

```text
request마다 new Pool()
request마다 신규 물리 connection 생성 의도
등록마다 pool 종료/재생성
```

초기 pool size를 임의로 성능 최적화하지 않는다.

`pg`의 합리적인 기본 동작을 우선 사용하고, 실제 필요가 없는 tuning 값을 미리 넣지 않는다.

애플리케이션 shutdown 시 pool을 정상 종료한다.

---

## 11. 시간 슬롯 계산

서버 시간이 공식 기준이다.

내부 DB/API 시간은 UTC ISO-8601로 처리한다.

현재 시각이:

```text
2026-09-26T10:37:21.480Z
```

이면 현재 Slot은:

```text
startsAt = 2026-09-26T10:00:00.000Z
endsAt   = 2026-09-26T11:00:00.000Z
```

이어야 한다.

외부 date library를 설치하지 않는다.

`Date` 기반으로 시간 단위 truncate를 명확하게 구현한다.

---

## 12. 문구 정규화 및 검증

MVP 문구 규칙:

```text
plain text
trim 이후 1자 이상
최대 80자
줄바꿈 금지
공백-only 금지
```

Fastify JSON Schema로 구조 validation을 처리하고, trim 및 줄바꿈 등 도메인 조건은 명확한 애플리케이션 로직으로 검증한다.

DB CHECK constraint도 유지한다.

사용자 입력을 HTML로 해석하지 않는다.

---

## 13. API 구현

### `GET /health`

애플리케이션과 PostgreSQL 연결 상태를 확인한다.

### `GET /api/round`

현재 Slot, Winner, 서버 시각, 다음 Round 정보를 반환한다.

Countdown은 응답의 `serverTime`을 기준으로 브라우저 시각과 보정한다.

### `POST /api/attempts`

클라이언트는 도전하려는 Round의 `slotAt`을 전달한다.  
서버는 자신의 시스템 시간을 기준으로 `slotAt`의 형식과 현재 Round 여부를 검증한다.

#### 요청

```json
{
  "message": "오늘은 칼퇴합니다",
  "slotAt": "2026-09-26T10:00:00.000Z"
}
```

- `slotAt`은 UTC ISO 8601 형식으로 전달한다.
- `slotAt`은 반드시 정각(`mm:ss.SSS = 00:00.000`)이어야 한다.
- 서버 시각 기준 현재 Round와 일치하는 Slot에만 등록할 수 있다.

#### Winner 결과

```json
{
  "code": "WINNER",
  "message": "가장 먼저 등록하셨습니다. 작성하신 문구를 한 시간 동안 띄워드립니다.",
  "position": 1,
  "winner": true
}
```

#### 2등 이후 결과

```json
{
  "code": "RANKED",
  "message": "37번째로 등록하셨습니다.",
  "position": 37,
  "winner": false
}
```

#### 아직 시작하지 않은 Slot

```json
{
  "code": "ROUND_NOT_STARTED",
  "message": "아직 시작하지 않은 Round입니다.",
  "position": null,
  "winner": false
}
```

#### 이미 종료된 Slot

```json
{
  "code": "ROUND_ENDED",
  "message": "이미 종료된 Round입니다.",
  "position": null,
  "winner": false
}
```

#### 유효하지 않은 Slot

```json
{
  "code": "INVALID_SLOT",
  "message": "유효하지 않은 Round입니다.",
  "position": null,
  "winner": false
}
```

#### 등록 가능 시간

```text
slotAt <= serverTime < slotAt + 1 hour
```

- `serverTime < slotAt` → `ROUND_NOT_STARTED`
- `serverTime >= slotAt + 1 hour` → `ROUND_ENDED`
- `slotAt` 형식이 잘못되었거나 정각이 아님 → `INVALID_SLOT`

응답은 `code`, `message`, `position`, `winner` 구조를 공통으로 사용한다.

서버는 클라이언트가 전달한 `slotAt`을 그대로 신뢰하지 않는다.

정상 등록 경로에서는 동일 Slot row에 대한 atomic UPSERT 한 번으로 순번 증가와 Winner 보존을 처리한다.

---

## 14. 등록 핵심 SQL

등록 정상 경로는 반드시 **PostgreSQL query 1회**로 처리한다.

아래 의미를 보존한다.

```sql
INSERT INTO hour_slots (
    slot_start,
    winner_message,
    attempt_count
)
VALUES ($1, $2, 1)
ON CONFLICT (slot_start)
DO UPDATE
SET attempt_count = hour_slots.attempt_count + 1
RETURNING
    slot_start,
    winner_message,
    attempt_count,
    created_at;
```

금지:

```text
SELECT → INSERT
SELECT → UPDATE
UPSERT → SELECT
Winner 별도 query
Position 별도 query
```

`attempt_count`가 반환 Position이다.

```text
1      → winner = true
2 이상 → winner = false
```

Winner 문구는 conflict update에서 절대 수정하지 않는다.

애플리케이션 mutex로 순서를 만들지 않는다.

---

## 15. 오류 계약

아래 계약을 구현한다.

| HTTP | Code | 조건 |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | body 또는 message validation 실패 |
| 409 | `ROUND_EXPIRED` | Target Slot 종료 |
| 425 | `TOO_EARLY` | Target Slot 시작 전 |
| 500 | `INTERNAL_ERROR` | 예측하지 못한 서버 오류 |
| 503 | `DATABASE_UNAVAILABLE` | PostgreSQL 처리 불가 |

공통 오류 형태:

```json
{
  "error": {
    "code": "TOO_EARLY",
    "message": "아직 시작 전입니다."
  }
}
```

내부 SQL, stack trace, 환경 변수 값을 응답하지 않는다.

---

## 16. Phase 1 E2E

단위 테스트를 작성하지 않는다.

실제 Fastify 서버와 실제 PostgreSQL을 연결한 E2E script를 작성한다.

테스트용 mock DB 금지.

### E2E-01 최초 등록

- 빈 Slot
- Attempt 1건
- `position = 1`
- `winner = true`
- GET round에서 Winner 문구 확인

### E2E-02 후속 등록

- 같은 Slot 추가 Attempt
- `position >= 2`
- `winner = false`
- 기존 Winner 문구 불변

### E2E-03 동시 등록

독립 HTTP request N건을 실제 병렬로 보낸다.

MVP E2E 기본 N은 **100**으로 사용한다.

검증:

```text
winner count = 1
positions = 1..100
duplicate position = 0
missing position = 0
winner message mutation = 0
```

이 E2E는 성능 benchmark가 아니다.

Phase 3의 10/50/100/200 k6 측정을 선반영하지 않는다.

### E2E-04 TOO_EARLY

미래 Target Slot 요청이 DB write 없이 425로 거부되는지 확인한다.

### E2E-05 ROUND_EXPIRED

종료된 Target Slot이 409로 거부되는지 확인한다.

### E2E-06 문구 validation

최소:

```text
빈 문자열
공백-only
81자
줄바꿈 포함
```

모두 거부되는지 확인한다.

### E2E-07 Slot 조회

현재 Slot에 row가 없으면 Winner 없는 정상 응답을 반환하는지 확인한다.

---

## 17. Phase 1 E2E Artifact

`tests/e2e/artifacts/`에 사람이 다시 확인할 수 있는 JSON artifact를 생성한다.

예시 구조:

```json
{
  "phase": "phase1",
  "scenario": "concurrent-attempts",
  "slotAt": "...",
  "requested": 100,
  "succeeded": 100,
  "failed": 0,
  "winnerCount": 1,
  "minPosition": 1,
  "maxPosition": 100,
  "duplicatePositions": 0,
  "missingPositions": 0,
  "winnerMessageMutations": 0,
  "p50Ms": 12.3,
  "p95Ms": 27.4,
  "p99Ms": 34.8
}
```

실제로 측정한 값만 기록한다.

측정하지 않은 값은 0으로 꾸미지 않는다.

실패가 있으면 artifact에도 그대로 남긴다.

---

## 18. Phase 1 완료 처리

아래가 모두 확인된 뒤에만 Phase 1을 완료로 판정한다.

```text
[ ] 실제 PostgreSQL 연결
[ ] migration 성공
[ ] GET /health
[ ] GET /api/round
[ ] POST /api/attempts
[ ] 문구 validation
[ ] TOO_EARLY
[ ] ROUND_EXPIRED
[ ] atomic UPSERT 1회
[ ] Winner 1명
[ ] Position 1..N
[ ] 중복 Position 0
[ ] 누락 Position 0
[ ] Winner 문구 불변
[ ] E2E artifact 생성
```

완료 후 `docs/results/phase1-concurrency-core.md`를 작성한다.

결과 문서에는 사실만 기록한다.

최소 내용:

```text
구현 범위
변경 파일
DB schema
핵심 SQL
실행한 E2E
실제 결과
artifact 경로
확인된 제한사항
```

그 후 commit:

```text
feat: phase1-concurrency-core
```

commit에 Phase 2 작업을 섞지 않는다.

---

# Phase 2 — Ticketing UI

## 19. Phase 2 목표

Phase 1 API 위에 실제 사용자가 MVP 전체 흐름을 사용할 수 있는 단일 화면 UI를 구현한다.

Frontend와 API는 같은 Fastify 애플리케이션에서 제공한다.

별도 frontend framework를 도입하지 않는다.

---

## 20. 정적 파일 제공

Fastify에서 `public/`을 정적으로 제공한다.

필요 파일:

```text
public/index.html
public/styles/app.css
public/scripts/app.js
```

Browser TypeScript 원본은 `src/client/app.ts`에 둔다.

TypeScript build로 `public/scripts/app.js`를 생성한다.

직접 수정한 source와 generated output의 관계가 명확해야 한다.

---

## 21. 화면 구성

`DESIGN.md`를 그대로 따른다.

핵심 구조:

```text
한시간동안 띄워드립니다

현재 전광판
┌─────────────────────────────┐
│                             │
│     오늘은 칼퇴합니다       │
│                             │
└─────────────────────────────┘

이 문구는 18:00까지 표시됩니다.

다음 도전까지
00:27.381

[ 띄우고 싶은 문구 입력      ]
[          등록하기           ]

결과 영역
```

우선순위:

```text
1. 현재 전광판
2. 현재 문구 종료 시각
3. 다음 정각 countdown
4. 문구 입력
5. 등록 버튼
6. 결과
7. 규칙 설명
```

---

## 22. 전광판 상태

### Winner 존재

Winner message를 plain text로 표시한다.

HTML 삽입 금지.

`innerHTML`에 사용자 입력을 전달하지 않는다.

### Winner 없음

```text
아직 등록된 문구가 없습니다.
```

이전 Slot Winner를 현재 Slot에 보여주지 않는다.

---

## 23. Countdown

표시:

```text
00:27.381
```

`GET /api/round`의 `serverTime`을 이용해 client/server offset을 계산한다.

브라우저 로컬 시계를 authoritative clock으로 사용하지 않는다.

UI countdown은 부드럽게 갱신하되 fetch 등록 자체를 지연시키면 안 된다.

정각이 지나면 현재 Round 상태를 재조회해 새 Slot을 반영한다.

WebSocket/SSE는 사용하지 않는다.

필요한 경우 정각 전환 시점 또는 명시적 상태 변화 때 `GET /api/round`를 다시 호출하는 수준으로 유지한다.

---

## 24. 입력 및 제출

문구는 정각 전에 미리 입력할 수 있다.

UI 규칙:

```text
trim 전/후 규칙 일관성 유지
최대 80자
남은 글자 수 표시
공백-only 제출 방지
줄바꿈 불가
제출 중 버튼 비활성
```

클라이언트 validation은 UX 목적이다.

최종 판정은 서버가 한다.

등록 버튼 클릭 후 API 요청 전에 animation이나 불필요한 동기 작업을 실행하지 않는다.

---

## 25. Target Slot 처리

사용자가 다음 정각을 기다리는 동안 입력한 뒤 정각에 등록하는 흐름이 핵심이다.

Frontend가 보내는 `targetSlotAt`은 사용자가 도전 중인 Slot을 명확히 가리켜야 한다.

서버가 다음 결과를 반환할 수 있음을 전제로 한다.

```text
TOO_EARLY
ROUND_EXPIRED
성공
```

클라이언트가 자체적으로 성공을 추정하지 않는다.

---

## 26. 결과 UI

### Position 1

정확한 문구:

```text
축하합니다!
가장 먼저 등록하셨습니다.
작성하신 문구를 한 시간 동안 띄워드립니다.
```

성공 응답을 받은 뒤 전광판을 해당 Winner 문구로 즉시 갱신할 수 있다.

### Position 2 이상

```text
아쉽군요!
37번째로 등록하셨습니다!
```

순위 숫자를 시각적으로 가장 명확하게 표시한다.

보조 문구:

```text
서버 처리 기준 순위입니다.
```

### TOO_EARLY

```text
아직 시작 전입니다.
다음 정각에 다시 등록해 주세요.
```

### ROUND_EXPIRED

```text
이미 종료된 라운드입니다.
현재 라운드로 다시 시도해 주세요.
```

이 경우 현재 Round를 다시 조회한다.

### 네트워크 / 5xx / 결과 미확정

```text
등록 결과를 확인하지 못했습니다.
```

자동 retry 금지.

임의 순위 추정 금지.

---

## 27. 접근성

최소 구현:

- input에 연결된 label
- 결과 영역 `aria-live`
- keyboard focus 유지
- disabled를 색상만으로 표현하지 않음
- 전광판 텍스트 대비 확보
- countdown 외 텍스트 상태 제공
- `prefers-reduced-motion` 존중

불필요한 animation은 만들지 않는다.

---

## 28. 반응형

모바일 우선.

### Mobile

- 단일 컬럼
- input/button full width
- 가로 scroll 없음
- countdown/position 우선 노출
- 긴 문구 wrap

### Desktop

- 중앙 단일 컬럼
- 과도하게 넓히지 않음
- side panel 추가 금지

---

## 29. 시각 방향

사이트명:

```text
한시간동안 띄워드립니다
```

Project name:

```text
HourBoard
```

화면은 전광판 + 티켓팅 대기 화면 성격으로 구성한다.

금지:

```text
hero video
carousel
parallax
3D
particle
과도한 gradient
과도한 animation
외부 대형 이미지
불필요한 web font
```

CSS만으로 가벼운 전광판 느낌을 표현한다.

UI보다 입력/등록 속도가 우선이다.

---

## 30. Phase 2 E2E

단위 테스트를 작성하지 않는다.

브라우저 자동화 프레임워크를 새로 도입하지 않는다.

Phase 2의 E2E는 **실제 정적 UI가 제공되고 실제 API/PostgreSQL과 연결된 상태를 검증하는 실행 가능한 script + HTTP/DOM 산출물 검증**으로 구성한다.

현재 승인 범위에서 브라우저 엔진 dependency를 추가하지 않는다.

최소 검증:

```text
1. GET / 로 index.html 제공
2. 주요 UI element 존재
3. GET /api/round와 UI가 사용할 response contract 일치
4. 최초 Attempt position 1
5. 후속 Attempt N번째
6. Winner 문구 GET /api/round에서 유지
7. 새 Slot 조회 시 이전 Winner 미노출
8. 425 TOO_EARLY contract
9. 409 ROUND_EXPIRED contract
10. frontend source에 등록 API 자동 retry 없음
11. 사용자 문구를 HTML 실행 경로로 넣지 않음
```

가능한 범위에서 실제 브라우저 수동 확인용 스크린샷 대신, 반복 실행 가능한 artifact를 우선한다.

브라우저 자동화가 없기 때문에 검증할 수 없는 시각적 항목은 검증했다고 기록하지 않는다.

---

## 31. Phase 2 E2E Artifact

`tests/e2e/artifacts/`에 Phase 2 결과 JSON 또는 HTML artifact를 생성한다.

최소 포함:

```text
index response status
필수 UI element 확인 결과
API round contract 확인
winner result 확인
non-winner result 확인
slot transition 확인
TOO_EARLY 확인
ROUND_EXPIRED 확인
auto retry 미사용 확인
```

검증하지 않은 visual claim은 넣지 않는다.

---

## 32. Phase 2 완료 처리

아래가 모두 확인되어야 한다.

```text
[ ] 현재 전광판 UI
[ ] 빈 Slot UI
[ ] serverTime 기반 countdown
[ ] 문구 입력
[ ] 80자 제한
[ ] 등록 버튼
[ ] 제출 중 중복 클릭 차단
[ ] Winner 결과 UI
[ ] N번째 결과 UI
[ ] TOO_EARLY UI
[ ] ROUND_EXPIRED UI
[ ] 결과 미확정 UI
[ ] 모바일 반응형
[ ] aria-live
[ ] plain text Winner 렌더링
[ ] UI 포함 E2E artifact
```

완료 후 `docs/results/phase2-ticketing-ui.md`를 작성한다.

최소 내용:

```text
구현 범위
변경 파일
UI 상태
실행한 E2E
실제 검증 결과
artifact 경로
확인하지 못한 시각 항목
확인된 제한사항
```

README를 실제 구현 상태에 맞게 갱신한다.

Planning이라고 남겨두지 않는다.

실제로 동작하는 실행 방법만 기록한다.

그 후 commit:

```text
feat: phase2-ticketing-ui
```

push하지 않는다.

---

# MVP 전체 완료 기준

## 33. 반드시 성립해야 하는 불변식

동일 Slot에 N개의 정상 등록 요청을 보냈을 때:

```text
winner count = 1
positions = 1..N
duplicate position = 0
missing position = 0
winner message mutation = 0
```

하나라도 깨지면 MVP 완료로 처리하지 않는다.

---

## 34. MVP 체크리스트

최종적으로 `.project/plan.md`의 MVP 체크리스트를 다시 대조한다.

```text
[ ] Fastify 서버 실행
[ ] PostgreSQL 실제 연결
[ ] migration으로 hour_slots 생성
[ ] 현재 Slot 계산
[ ] GET /health
[ ] GET /api/round
[ ] POST /api/attempts
[ ] 문구 validation
[ ] TOO_EARLY
[ ] ROUND_EXPIRED
[ ] atomic UPSERT
[ ] Winner 1명 보장
[ ] Position 1..N 보장
[ ] Winner 문구 불변
[ ] 현재 전광판 UI
[ ] 빈 Slot UI
[ ] serverTime 기반 countdown
[ ] 문구 입력
[ ] 등록 버튼
[ ] Winner 결과 UI
[ ] N번째 결과 UI
[ ] 결과 미확정 UI
[ ] 모바일 반응형
[ ] 접근성 결과 알림
[ ] 실제 PostgreSQL E2E
[ ] 동시성 E2E artifact
[ ] README 현재 구현 상태 갱신
[ ] docs/results/에 실제 검증 결과 기록
```

모든 항목을 코드 존재 여부가 아니라 **실제 동작 및 검증 결과**로 판정한다.

---

## 35. npm scripts

실제 파일 구조에 맞게 최소한 아래 목적의 script를 제공한다.

명칭은 특별한 이유가 없으면 아래를 사용한다.

```text
npm run dev
npm run build
npm run start
npm run db:migrate
npm run e2e
```

필요하면 E2E 내부에서 Phase 1/2 검증을 분리할 수 있다.

```text
npm run e2e:phase1
npm run e2e:phase2
```

단위 테스트용 `test:unit` script는 만들지 않는다.

`npm test`를 제공한다면 실제 E2E를 실행하도록 명확하게 구성한다.

---

## 36. README 최종 상태

MVP 완료 시 README는 사람이 clone 후 실행할 수 있는 문서가 되어야 한다.

최소 포함:

```text
서비스 설명
현재 구현 상태: MVP
기술 스택
아키텍처
사전 요구사항
환경 변수
PostgreSQL 실행 방법
migration 방법
개발 서버 실행 방법
build/start 방법
E2E 실행 방법
핵심 동시성 설계 요약
프로젝트 구조
현재 구현 범위
아직 구현하지 않은 Phase 3/4 범위
```

구현하지 않은 기능을 완료된 것처럼 쓰지 않는다.

실제로 측정하지 않은 latency/TPS 수치를 넣지 않는다.

---

## 37. Git 처리

현재 작업 시작 전에:

```text
git status
```

를 확인한다.

기존 사용자 변경 사항을 임의로 되돌리지 않는다.

Phase 1 완료 후:

```text
feat: phase1-concurrency-core
```

Phase 2 완료 후:

```text
feat: phase2-ticketing-ui
```

총 2개의 Phase commit을 목표로 한다.

push 금지.

작업 트리에 기존 unrelated 변경이 있어서 안전한 commit이 불가능하면 해당 변경을 건드리지 않고 가능한 범위만 commit한다.

---

## 38. 범위 외 기능

이번 실행에서는 아래를 절대 선반영하지 않는다.

```text
회원가입
로그인
사용자 식별 UUID
사용자별 1회 제한
Attempt history table
개인 기록
리더보드
관리자 페이지
moderation
신고
결제
광고
알림
WebSocket
SSE
Redis
Queue
여러 API instance
외부 managed DB
ORM
AI 기능
analytics SaaS
k6 Phase 3 benchmark
OCI Phase 4 deployment
systemd
HTTPS termination
production backup automation
```

Phase 2 UI에 향후 기능 placeholder도 넣지 않는다.

---

## 39. 작업 중 판단 원칙

### 구현 선택이 여러 개일 때

아래 우선순위를 따른다.

```text
1. .project/plan.md와 일치
2. 동시성 정합성
3. 단순성
4. critical path 최소화
5. dependency 최소화
6. 가독성
7. 이후 확장성
```

현재 MVP에서 쓰이지 않는 추상화보다 직접적인 코드를 우선한다.

### 리뷰

코드 작성이 끝난 뒤 단순히 "개선할 점"을 찾기 위한 형식적 리뷰를 하지 않는다.

구현 전에 확인한 요구사항과 실패 경로를 기준으로 다음만 검토한다.

```text
요구사항 누락
동시성 invariant 위반
경계 시각 오류
DB query 증가
보안 노출
E2E가 놓친 실제 사용자 흐름
현재 Phase 범위 초과
```

리뷰에서 발견한 문제는 즉시 수정하고 동일 E2E를 다시 실행한다.

---

## 40. 막힘 처리

중간에 사용자에게 진행 허가를 다시 요청하지 않는다.

단, 아래와 같이 현재 환경에서 실제 완료가 물리적으로 불가능한 경우에는 거짓으로 완료 처리하지 않는다.

예:

```text
Docker daemon 사용 불가
PostgreSQL 실행 자체 불가
필수 CLI 부재로 대체 수단도 없음
filesystem permission 문제
기존 사용자 변경과 충돌하여 안전한 수정 불가
```

이 경우:

1. 구현 가능한 범위까지 완료
2. 실패한 명령과 원인을 확인
3. 우회 가능한 로컬 방법이 있으면 범위 내에서 수행
4. PostgreSQL을 SQLite/mock으로 임의 교체하지 않음
5. 검증하지 못한 항목을 성공 처리하지 않음
6. 결과 문서에 blocker 기록
7. 최종 보고에서 MVP 미완료 상태를 명확히 표시

---

## 41. 최종 보고 형식

작업을 마치면 장황한 설명 없이 아래 순서로 보고한다.

```text
## 작업 상태
- MVP 완료 / 부분 완료

## Phase 1
- 구현 범위
- E2E 결과
- artifact
- commit hash

## Phase 2
- 구현 범위
- E2E 결과
- artifact
- commit hash

## 주요 변경 파일
- 실제 변경 파일

## 검증
- 실행한 명령
- 실제 통과 결과

## 남은 제한사항
- 현재 확인된 사실만

## Git
- working tree 상태
- push 수행 여부: 수행하지 않음
```

실행하지 않은 테스트, 배포, 성능 수치를 완료했다고 표현하지 않는다.

---

# 최종 명령

위 지시를 읽은 뒤 추가 계획 확인이나 중간 승인 요청 없이 바로 작업을 시작한다.

**Phase 1을 완성하고 실제 PostgreSQL E2E로 검증한 뒤 결과 문서와 commit을 남기고, 이어서 Phase 2를 완성하고 MVP 전체 E2E를 검증한 뒤 결과 문서, README 갱신, commit까지 수행한다.**

MVP 완료 이후 Phase 3 또는 Phase 4 작업은 시작하지 않는다.

`git push`는 수행하지 않는다.
