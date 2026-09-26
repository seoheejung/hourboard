# HourBoard MVP 구현 지시서

> 대상: OpenAI Codex
>
> 목표: 한 번의 작업 흐름으로 HourBoard MVP(Phase 1 + Phase 2)를 구현하고 실제 PostgreSQL 기반 E2E 검증, 결과 문서화, Phase별 commit까지 완료

---

## 0. 실행 모드

이 지시서는 중간 승인 대기 없이 MVP 완료까지 연속으로 진행하는 단일 작업 지시서다.

작업 우선순위:

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

현재 작업 범위:

```text
Phase 1 — Concurrency Core
Phase 2 — Ticketing UI
```

Phase 3 이후 기능은 구현하지 않는다.

Phase 1과 Phase 2를 모두 구현하고 검증한 MVP 완료 상태에서 작업을 종료한다.

---

## 1. 이번 작업에서 명시적으로 승인된 항목

`AGENTS.md`의 의존성 승인 규칙에 대해 이번 지시 자체를 아래 범위의 명시적 승인으로 취급한다.

### 승인

- MVP 구현에 필요한 npm 패키지 설치
- `package.json` 생성 및 수정
- `package-lock.json` 생성 및 갱신
- TypeScript 설정 파일 생성 및 수정
- 로컬 개발 및 E2E용 `compose.yaml` 생성
- 실제 PostgreSQL 18.x 컨테이너 실행
- DB migration 실행
- E2E 실행을 위한 로컬 프로세스 실행
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
- Queue 도입
- WebSocket / SSE 도입
- 테스트 프레임워크 기반 단위 테스트 작성
- Phase 3 k6 부하 테스트 구현
- Phase 4 OCI 배포 작업

필요한 dependency는 MVP 구현에 필요한 최소 범위로 제한한다.

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

구현 전 확인 항목:

- 서비스 규칙
- Round / Slot 시간 모델
- 문구 정책
- `hour_slots` 데이터 모델
- atomic UPSERT
- `GET /health`
- `GET /api/round`
- `POST /api/attempts`
- 성공 응답 계약
- 오류 응답 계약
- 등록 critical path
- E2E 불변식
- Phase 1 / Phase 2 완료 기준
- 디자인 상태 정의

기획 변경이 필요하다고 판단해도 임의로 범위를 확장하지 않는다.

---

## 3. 구현 전 실패 경로 확인

`AGENTS.md` 규칙에 따라 코드 작성 전에 실패 가능한 경로를 먼저 확인한다.

단위 테스트를 만들지 않는다.

최소 실패 경로:

```text
1. 동시에 여러 요청이 모두 Winner로 판정되는 문제
2. Position 중복
3. Position 누락
4. Position 2 이후 요청이 Winner 문구를 덮어쓰는 문제
5. 시작하지 않은 Slot 요청이 DB에 기록되는 문제
6. 종료된 Slot 요청이 DB에 기록되는 문제
7. 잘못된 slotAt 형식 또는 정각이 아닌 slotAt이 처리되는 문제
8. 브라우저 시간 오차로 등록 가능 시점이 어긋나는 문제
9. 빠른 중복 클릭으로 동일 사용자의 의도하지 않은 다중 요청이 발생하는 문제
10. DB 처리 후 HTTP 응답 유실 시 자동 재시도로 Position이 추가 소비되는 문제
11. PostgreSQL 연결 실패인데 임의 Position을 반환하는 문제
12. 사용자 입력 HTML/Script가 markup으로 실행되는 문제
13. 120자 초과 문구가 DB까지 도달하는 문제
14. 공백-only 또는 줄바꿈 문구가 DB까지 도달하는 문제
15. Slot 전환 후 이전 Winner가 현재 전광판에 남는 문제
16. request마다 PostgreSQL connection을 새로 만드는 문제
17. 등록 정상 경로에 불필요한 SELECT가 추가되는 문제
18. 서버 재시작으로 Winner/Position이 초기화되는 문제
19. production 오류 응답에 SQL, stack trace, 환경 변수 값이 노출되는 문제
20. WINNER / RANKED code와 position / winner 값이 서로 모순되는 문제
```

이 목록을 별도 장문 문서로 확장할 필요는 없다.

---

## 4. MVP 기술 구성

```text
Runtime      Node.js 24 LTS
Language     TypeScript
Backend      Fastify 5.x
Database     PostgreSQL 18.x
Package      npm
Frontend     HTML + CSS + Browser TypeScript
Dev DB       Docker Compose + official PostgreSQL image
Testing      실제 Fastify 서버 + 실제 PostgreSQL 기반 E2E
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

추가 dependency가 필요한 경우 현재 MVP 기능에 직접 필요한지 먼저 확인한다.

아래 계열은 추가하지 않는다.

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
Cypress
k6 npm wrapper
외부 validation framework
외부 date/time library
```

Fastify JSON Schema와 Node.js / Browser 표준 API로 해결 가능한 문제는 dependency를 늘리지 않는다.

---

## 5. 목표 프로젝트 구조

기존 구조를 존중하면서 MVP 구현에 필요한 파일만 추가한다.

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

파일명은 실제 책임상 더 자연스러운 경우 최소한으로 조정할 수 있다.

불필요한 계층과 범용 abstraction은 만들지 않는다.

---

# Phase 1 — Concurrency Core

## 6. Phase 1 목표

실제 PostgreSQL을 사용해 아래 흐름을 완성한다.

```text
HTTP request
→ Fastify request validation
→ server time / slotAt validation
→ PostgreSQL atomic UPSERT 1회
→ position / winner 결정
→ code / message 생성
→ JSON response
```

Phase 1 검증이 끝나기 전에 Phase 2 UI 구현으로 넘어가지 않는다.

---

## 7. 개발용 PostgreSQL

`compose.yaml`에 PostgreSQL 18.x 개발 환경을 구성한다.

요구사항:

- official PostgreSQL image 사용
- 로컬 개발 전용 database / user / password 사용
- 운영 credential과 분리
- persistent named volume 사용 가능
- healthcheck 제공
- 불필요한 DB 관리 UI 추가 금지

환경 변수는 아래 세 개만 사용한다.

```text
NODE_ENV
PORT
DATABASE_URL
```

`.env.example`에는 비밀 운영값을 넣지 않는다.

---

## 8. Migration

`db/migrations/001_create_hour_slots.sql`에 `hour_slots`를 생성한다.

최소 schema 의미:

```sql
CREATE TABLE hour_slots (
    slot_start      TIMESTAMPTZ PRIMARY KEY,
    winner_message  TEXT NOT NULL,
    attempt_count   BIGINT NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT hour_slots_attempt_count_check
        CHECK (attempt_count >= 1),

    CONSTRAINT hour_slots_winner_message_length_check
        CHECK (char_length(winner_message) BETWEEN 1 AND 120)
);
```

문구 최대 길이 120자는 애플리케이션 입력 검증과 DB 제약 조건에서 동일하게 적용한다.

migration framework는 도입하지 않는다.

`npm run db:migrate` 또는 동일 목적의 명확한 npm script를 제공한다.

---

## 9. 환경 변수 처리

`src/config/`에서 환경 변수를 읽고 검증한다.

필수 변수:

```text
NODE_ENV
PORT
DATABASE_URL
```

원칙:

- 필수 환경 변수 누락 시 startup fail-fast
- `PORT` 숫자 변환 검증
- 운영 DB credential 기본값 금지
- production에서 stack trace 노출 금지
- 비밀값 로그 출력 금지

문구 최대 길이 120자는 현재 MVP 도메인 규칙으로 코드와 DB constraint에 고정한다.

별도 `MAX_MESSAGE_LENGTH` 환경 변수는 만들지 않는다.

---

## 10. PostgreSQL Pool

애플리케이션 시작 시 pool을 1회 생성하고 재사용한다.

금지:

```text
request마다 new Pool()
request마다 신규 물리 connection 생성 의도
등록마다 pool 종료/재생성
```

초기 pool size는 측정 없이 임의 튜닝하지 않는다.

애플리케이션 종료 시 pool을 정상 종료한다.

---

## 11. 시간 및 Slot 계산

서버 시간이 공식 기준이다.

DB/API 내부 시간은 UTC로 처리하고 ISO 8601 문자열로 응답한다.

현재 서버 시각이:

```text
2026-09-26T10:37:21.480Z
```

이면 현재 Slot은:

```text
startsAt = 2026-09-26T10:00:00.000Z
endsAt   = 2026-09-26T11:00:00.000Z
```

외부 date/time library는 설치하지 않는다.

### 11.1 `slotAt` 형식

클라이언트가 보내는 `slotAt`은:

- UTC ISO 8601 형식
- 반드시 정각
- `mm:ss.SSS = 00:00.000`

이어야 한다.

형식 오류 또는 정각이 아닌 값은 `400 INVALID_SLOT`로 처리한다.

### 11.2 등록 가능 시간

```text
slotAt <= serverTime < slotAt + 1 hour
```

첫 정상 등록 전에는 현재 Round의 등록을 허용한다. 첫 등록 시각부터 10초 미만 동안만 후속 등록을 허용한다. 마감 시각은 `min(firstRegisteredAt + 10 seconds, slotAt + 1 hour)`이다. 10초 경계와 row lock 대기 후의 판정은 PostgreSQL UPSERT 안에서 수행한다.

판정:

```text
serverTime < slotAt
→ 425 ROUND_NOT_STARTED

serverTime >= slotAt + 1 hour
→ 409 ROUND_ENDED

slotAt <= serverTime < slotAt + 1 hour
→ 첫 등록 또는 10초 Window 안의 등록 처리
```

Slot 형식 및 시간 검증은 PostgreSQL write 전에 수행한다.

서버는 클라이언트가 전달한 `slotAt`을 그대로 신뢰하지 않는다.

---

## 12. 문구 정규화 및 검증

MVP 문구 규칙:

```text
plain text
trim 이후 1자 이상
최대 120자
공백-only 금지
줄바꿈 금지
```

Fastify JSON Schema로 body 구조 validation을 수행한다.

trim, 공백-only, 줄바꿈 등 도메인 조건은 명확한 애플리케이션 로직으로 검증한다.

DB CHECK constraint도 유지한다.

사용자 입력을 HTML로 해석하지 않는다.

---

## 13. API 구현

### 13.1 `GET /health`

애플리케이션과 PostgreSQL 연결 상태를 확인한다.

PostgreSQL 연결 실패를 정상 상태로 반환하지 않는다.

### 13.2 `GET /api/round`

현재 Slot, 현재 Winner, 서버 시각, 다음 Round 정보를 반환한다.

Frontend countdown은 응답의 `serverTime`을 기준으로 브라우저 시각과 offset을 계산한다.

현재 Slot row가 없으면 Winner가 없는 정상 상태로 반환한다.

`currentSlot`에 `registrationOpen`과 `registrationClosesAt`을 포함한다. Winner가 없으면 `registrationOpen = true`, `registrationClosesAt = null`이다. 마감 후에도 Winner 문구는 Slot 종료까지 반환한다.

이전 Slot Winner를 현재 Winner처럼 반환하지 않는다.

### 13.3 `POST /api/attempts`

클라이언트는 도전하려는 Round의 `slotAt`과 문구를 전달한다.

#### 요청

```json
{
  "slotAt": "2026-09-26T10:00:00.000Z",
  "message": "오늘도 살아남았다"
}
```

#### Winner 응답

```json
{
  "slotAt": "2026-09-26T10:00:00.000Z",
  "code": "WINNER",
  "message": "가장 먼저 등록하셨습니다. 작성하신 문구를 다음 정각까지 띄워드립니다.",
  "position": 1,
  "winner": true,
  "registrationClosesAt": "2026-09-26T10:00:10.000Z"
}
```

#### 2등 이후 응답

```json
{
  "slotAt": "2026-09-26T10:00:00.000Z",
  "code": "RANKED",
  "message": "37번째로 등록하셨습니다.",
  "position": 37,
  "winner": false,
  "registrationClosesAt": "2026-09-26T10:00:10.000Z"
}
```

성공 응답은 아래 구조를 공통으로 사용한다.

```text
slotAt
code
message
position
winner
registrationClosesAt
```

Winner가 아닌 응답에는 다른 사용자의 `winner_message`를 포함하지 않는다.

현재 Winner 문구는 `GET /api/round`에서 조회한다.

#### 성공 응답 불변식

```text
position = 1
→ code = WINNER
→ winner = true

position >= 2
→ code = RANKED
→ winner = false
```

서로 모순되는 조합을 반환하지 않는다.

---

## 14. 등록 핵심 SQL

정상 등록 경로는 PostgreSQL write query 1회로 처리한다.

아래 의미를 보존한다.

```sql
WITH db_time AS MATERIALIZED (SELECT clock_timestamp() AS at)
INSERT INTO hour_slots (
    slot_start,
    winner_message,
    attempt_count,
    created_at
)
SELECT $1, $2, 1, db_time.at
FROM db_time
WHERE db_time.at >= $1::timestamptz
  AND db_time.at < $1::timestamptz + INTERVAL '1 hour'
ON CONFLICT (slot_start)
DO UPDATE
SET attempt_count = hour_slots.attempt_count + 1
WHERE clock_timestamp() < LEAST(hour_slots.created_at + INTERVAL '10 seconds', hour_slots.slot_start + INTERVAL '1 hour')
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
attempt_count = 1
→ WINNER
→ winner = true

attempt_count >= 2
→ RANKED
→ winner = false
```

Winner 문구는 conflict update에서 절대 수정하지 않는다.

마감 뒤의 conflict update는 row를 바꾸지 않고 `409 REGISTRATION_CLOSED`로 처리한다.

애플리케이션 mutex로 순서를 만들지 않는다.

---

## 15. HTTP 오류 계약

| HTTP | Code | 조건 | UI 처리 |
| --- | --- | --- | --- |
| 400 | `INVALID_REQUEST` | body 형식 또는 message validation 실패 | 입력 확인 안내 |
| 400 | `INVALID_SLOT` | `slotAt` 형식 오류 또는 정각이 아닌 Slot | Round 정보 재확인 |
| 409 | `ROUND_ENDED` | 목표 Slot이 이미 종료 | 현재 Round 재조회 |
| 409 | `REGISTRATION_CLOSED` | 첫 등록 후 10초 Window 종료 | 마감 표시 |
| 425 | `ROUND_NOT_STARTED` | 목표 Slot이 아직 시작 전 | countdown 유지 |
| 500 | `INTERNAL_ERROR` | 예측하지 못한 서버 오류 | 결과 미확정 표시 |
| 503 | `DATABASE_UNAVAILABLE` | PostgreSQL 처리 불가 | 결과 미확정 표시 |

오류 응답은 아래 구조를 공통으로 사용한다.

```json
{
  "code": "ROUND_NOT_STARTED",
  "message": "아직 시작하지 않은 Round입니다.",
  "position": null,
  "winner": false
}
```

오류별 필수 의미:

```text
INVALID_REQUEST
→ 요청 body 또는 message validation 실패

INVALID_SLOT
→ slotAt 파싱 실패 또는 정각이 아닌 값

ROUND_NOT_STARTED
→ serverTime < slotAt

ROUND_ENDED
→ serverTime >= slotAt + 1 hour

REGISTRATION_CLOSED
→ 첫 등록 후 10초 이상 경과

INTERNAL_ERROR
→ 예측하지 못한 내부 오류

DATABASE_UNAVAILABLE
→ PostgreSQL 연결 또는 처리 불가
```

production 응답에 SQL, stack trace, 환경 변수 값, DB credential을 포함하지 않는다.

등록 결과가 확정되지 않은 5xx / 네트워크 오류에서는 임의 Position을 반환하지 않는다.

---

## 16. Phase 1 E2E

단위 테스트를 작성하지 않는다.

실제 Fastify 서버와 실제 PostgreSQL을 연결한 E2E script를 작성한다.

mock DB만으로 완료 판정하지 않는다.

### E2E-01 최초 등록

- 빈 Slot에 Attempt 1건 전송
- `code = WINNER`
- `position = 1`
- `winner = true`
- `GET /api/round`에서 Winner 문구 확인

### E2E-02 후속 등록

- 기존 Winner가 있는 동일 Slot에 Attempt 전송
- `code = RANKED`
- `position >= 2`
- `winner = false`
- 기존 Winner 문구 불변 확인

### E2E-03 동시 등록

동일 Slot에 독립 HTTP request N건을 실제 병렬로 보낸다.

MVP 기본 N은 100으로 사용한다.

검증:

```text
winner count = 1
positions = 1..N
duplicate position = 0
missing position = 0
winner message mutation = 0
```

응답 계약 검증:

```text
position = 1
→ code = WINNER
→ winner = true

position >= 2
→ code = RANKED
→ winner = false
```

이 E2E는 성능 benchmark가 아니다.

Phase 3의 k6 성능 측정을 선반영하지 않는다.

### E2E-04 INVALID_SLOT

최소 아래 요청이 PostgreSQL write 없이 `400 INVALID_SLOT`로 거부되는지 확인한다.

```text
ISO 8601 파싱 불가
분/초/밀리초가 00:00.000이 아닌 slotAt
```

### E2E-05 ROUND_NOT_STARTED

미래 Slot 요청이 PostgreSQL write 없이 `425 ROUND_NOT_STARTED`로 거부되는지 확인한다.

### E2E-06 ROUND_ENDED

종료된 Slot 요청이 PostgreSQL write 없이 `409 ROUND_ENDED`로 거부되는지 확인한다.

### E2E-07 문구 validation

최소:

```text
빈 문자열
공백-only
121자 이상
줄바꿈 포함
```

모두 `400 INVALID_REQUEST`로 거부되는지 확인한다.

### E2E-08 Slot 전환

정각 경계가 지난 뒤 이전 Winner가 현재 Round Winner로 반환되지 않는지 확인한다.

### E2E-09 결과 손실 시 자동 재시도 없음

Frontend가 등록 API 실패 또는 응답 유실을 임의로 재전송하지 않도록 구현 계약을 확인한다.

Phase 1에서는 실제 frontend가 아직 없으므로 이 항목의 최종 검증은 Phase 2에서 수행한다.

---

## 17. Phase 1 E2E Artifact

`tests/e2e/artifacts/`에 사람이 다시 확인할 수 있는 JSON artifact를 생성한다.

최소 구조:

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
  "p50Ms": null,
  "p95Ms": null,
  "p99Ms": null
}
```

실제로 측정한 값만 기록한다.

측정하지 않은 값은 생략하거나 `null`로 기록한다.

측정하지 않은 수치를 `0`으로 꾸미지 않는다.

실패가 있으면 artifact에도 그대로 남긴다.

---

## 18. Phase 1 완료 처리

아래 항목이 모두 실제 동작으로 확인된 뒤에만 Phase 1을 완료 처리한다.

```text
[ ] 실제 PostgreSQL 연결
[ ] migration 성공
[ ] GET /health
[ ] GET /api/round
[ ] POST /api/attempts
[ ] 문구 validation
[ ] INVALID_SLOT
[ ] ROUND_NOT_STARTED
[ ] ROUND_ENDED
[ ] WINNER 응답 계약
[ ] RANKED 응답 계약
[ ] atomic UPSERT 1회
[ ] Winner 1명
[ ] Position 1..N
[ ] 중복 Position 0
[ ] 누락 Position 0
[ ] Winner 문구 불변
[ ] E2E artifact 생성
```

완료 후 `docs/results/phase1-concurrency-core.md`를 작성한다.

결과 문서 최소 내용:

```text
구현 범위
변경 파일
DB schema
핵심 SQL
실행한 E2E
실제 검증 결과
artifact 경로
확인된 제한사항
```

사실만 기록한다.

그 후 commit:

```text
feat: phase1-concurrency-core
```

Phase 2 작업을 Phase 1 commit에 섞지 않는다.

---

# Phase 2 — Ticketing UI

## 19. Phase 2 목표

Phase 1 API 위에 사용자가 MVP 전체 흐름을 실제로 사용할 수 있는 단일 화면 UI를 구현한다.

Frontend와 API는 같은 Fastify 애플리케이션에서 제공한다.

별도 frontend framework를 도입하지 않는다.

---

## 20. 정적 파일 제공

Fastify에서 `public/`을 정적으로 제공한다.

필수 파일:

```text
public/index.html
public/styles/app.css
public/scripts/app.js
```

Browser TypeScript 원본은 `src/client/app.ts`에 둔다.

TypeScript build로 `public/scripts/app.js`를 생성한다.

source와 generated output의 관계를 명확히 유지한다.

---

## 21. 화면 구성

`DESIGN.md`의 정보 우선순위를 따른다.

핵심 구조:

```text
한시간동안 띄워드립니다

현재 전광판
┌─────────────────────────────┐
│                             │
│      오늘은 칼퇴합니다       │
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
6. 내 등록 결과
7. 서비스 규칙 안내
```

---

## 22. 전광판 상태

### Winner 존재

Winner 문구를 plain text로 표시한다.

사용자 입력을 `innerHTML`에 전달하지 않는다.

### Winner 없음

```text
아직 등록된 문구가 없습니다.
```

이전 Slot Winner를 현재 Slot에 보여주지 않는다.

---

## 23. Countdown

표시 형식:

```text
00:27.381
```

`GET /api/round`의 `serverTime`으로 client/server offset을 계산한다.

브라우저 로컬 시계를 authoritative clock으로 사용하지 않는다.

Countdown 렌더링이 등록 fetch보다 높은 우선순위를 가져서는 안 된다.

정각 경계가 지나면 `GET /api/round`를 다시 호출해 새 Round 상태를 반영한다.

WebSocket/SSE는 사용하지 않는다.

---

## 24. 입력 및 제출

문구는 정각 전에 미리 입력할 수 있다.

UI 규칙:

```text
trim 전/후 규칙 일관성 유지
최대 120자
남은 글자 수 표시
공백-only 제출 방지
줄바꿈 불가
제출 중 버튼 비활성
첫 등록 후 10초 경과 시 버튼 비활성
```

클라이언트 validation은 UX 목적이다.

최종 판정은 서버가 한다.

등록 버튼 클릭 후 API 요청 전에 animation이나 불필요한 동기 작업을 실행하지 않는다.

---

## 25. `slotAt` 처리

Frontend는 등록 요청에 `slotAt`을 보낸다.

사용자가 도전하려는 Round의 정확한 정각 UTC 값을 사용한다.

요청 형식:

```json
{
  "slotAt": "2026-09-26T10:00:00.000Z",
  "message": "오늘도 살아남았다"
}
```

Frontend가 클라이언트 시각만으로 등록 성공 여부를 추정하지 않는다.

서버 응답 `code`를 최종 상태로 사용한다.

처리 가능한 주요 응답:

```text
WINNER
RANKED
INVALID_REQUEST
INVALID_SLOT
ROUND_NOT_STARTED
ROUND_ENDED
REGISTRATION_CLOSED
INTERNAL_ERROR
DATABASE_UNAVAILABLE
```

`ROUND_NOT_STARTED` 응답 시 자동 retry하지 않는다.

`ROUND_ENDED` 응답 시 현재 Round를 다시 조회한다.

---

## 26. 결과 UI

### WINNER

UI 제목:

```text
축하합니다!
```

API `message`:

```text
가장 먼저 등록하셨습니다. 작성하신 문구를 다음 정각까지 띄워드립니다.
```

`position = 1`, `winner = true`와 일치해야 한다.

성공 응답을 받은 뒤 전광판을 해당 사용자의 등록 문구로 즉시 갱신할 수 있다.

### RANKED

예시:

```text
아쉽군요!
37번째로 등록하셨습니다!
```

순위 숫자를 시각적으로 명확하게 표시한다.

`position >= 2`, `winner = false`와 일치해야 한다.

### INVALID_REQUEST

입력값을 확인할 수 있는 안내를 표시한다.

### INVALID_SLOT

현재 Round 정보를 다시 확인하도록 처리한다.

### ROUND_NOT_STARTED

```text
아직 시작하지 않은 Round입니다.
```

Countdown을 유지한다.

자동 retry하지 않는다.

### ROUND_ENDED

```text
이미 종료된 Round입니다.
```

현재 Round를 다시 조회한다.

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
- keyboard focus 표시 유지
- disabled 상태를 색상만으로 표현하지 않음
- 전광판 텍스트 대비 확보
- countdown 외 텍스트 상태 제공
- `prefers-reduced-motion` 존중

불필요한 animation은 만들지 않는다.

---

## 28. 반응형

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

UI 효과보다 입력/등록 속도가 우선이다.

---

## 30. Phase 2 E2E

단위 테스트를 작성하지 않는다.

새 브라우저 자동화 프레임워크는 도입하지 않는다.

현재 승인 범위에서는 실제 정적 UI 제공, 실제 API/PostgreSQL 연결, 반복 실행 가능한 HTTP/DOM 정적 검증 artifact를 우선한다.

브라우저 엔진 없이 검증할 수 없는 시각 항목은 검증했다고 기록하지 않는다.

최소 검증:

```text
1. GET / 로 index.html 제공
2. 주요 UI element 존재
3. GET /api/round response contract 일치
4. 최초 Attempt → WINNER / position 1 / winner true
5. 후속 Attempt → RANKED / position >= 2 / winner false
6. Winner 문구 GET /api/round에서 유지
7. 새 Slot 조회 시 이전 Winner 미노출
8. 400 INVALID_SLOT contract
9. 425 ROUND_NOT_STARTED contract
10. 409 ROUND_ENDED contract
11. frontend source에 등록 API 자동 retry 없음
12. 사용자 문구를 HTML 실행 경로로 넣지 않음
13. 120자 입력 제한 UI 반영
```

---

## 31. Phase 2 E2E Artifact

`tests/e2e/artifacts/`에 Phase 2 결과 JSON 또는 HTML artifact를 생성한다.

최소 포함:

```text
index response status
필수 UI element 확인 결과
API round contract 확인
WINNER 결과 확인
RANKED 결과 확인
slot transition 확인
INVALID_SLOT 확인
ROUND_NOT_STARTED 확인
ROUND_ENDED 확인
auto retry 미사용 확인
plain text rendering 확인
```

검증하지 않은 visual claim은 넣지 않는다.

---

## 32. Phase 2 완료 처리

아래가 모두 실제로 확인되어야 한다.

```text
[ ] 현재 전광판 UI
[ ] 빈 Slot UI
[ ] serverTime 기반 countdown
[ ] 문구 입력
[ ] 120자 제한
[ ] 등록 버튼
[ ] 제출 중 중복 클릭 차단
[ ] WINNER 결과 UI
[ ] RANKED 결과 UI
[ ] INVALID_SLOT UI
[ ] ROUND_NOT_STARTED UI
[ ] ROUND_ENDED UI
[ ] 결과 미확정 UI
[ ] 등록 API 자동 재시도 없음
[ ] 모바일 반응형
[ ] aria-live
[ ] plain text Winner 렌더링
[ ] UI 포함 E2E artifact
```

완료 후 `docs/results/phase2-ticketing-ui.md`를 작성한다.

결과 문서 최소 내용:

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

구현하지 않은 기능을 완료된 것처럼 기록하지 않는다.

그 후 commit:

```text
feat: phase2-ticketing-ui
```

`git push`는 수행하지 않는다.

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

응답 계약도 함께 성립해야 한다.

```text
position = 1
→ code = WINNER
→ winner = true

position >= 2
→ code = RANKED
→ winner = false
```

하나라도 깨지면 MVP 완료로 처리하지 않는다.

---

## 34. MVP 체크리스트

최종적으로 `.project/plan.md`의 MVP 체크리스트와 다시 대조한다.

```text
[ ] Fastify 서버 실행
[ ] PostgreSQL 실제 연결
[ ] migration으로 hour_slots 생성
[ ] 현재 Slot 계산
[ ] GET /health
[ ] GET /api/round
[ ] POST /api/attempts
[ ] 문구 validation
[ ] INVALID_SLOT
[ ] ROUND_NOT_STARTED
[ ] ROUND_ENDED
[ ] WINNER 응답 계약
[ ] RANKED 응답 계약
[ ] atomic UPSERT
[ ] Winner 1명 보장
[ ] Position 1..N 보장
[ ] Winner 문구 불변
[ ] 현재 전광판 UI
[ ] 빈 Slot UI
[ ] serverTime 기반 countdown
[ ] 문구 입력
[ ] 120자 제한
[ ] 등록 버튼
[ ] Winner 결과 UI
[ ] N번째 결과 UI
[ ] 오류 상태 UI
[ ] 결과 미확정 UI
[ ] 등록 API 자동 재시도 없음
[ ] 모바일 반응형
[ ] 접근성 결과 알림
[ ] 실제 PostgreSQL E2E
[ ] 동시성 E2E artifact
[ ] UI E2E artifact
[ ] README 현재 구현 상태 갱신
[ ] docs/results/에 실제 검증 결과 기록
```

모든 항목은 코드 존재 여부가 아니라 실제 동작과 검증 결과로 판정한다.

체크되지 않은 기능은 완료로 표현하지 않는다.

---

## 35. npm scripts

실제 파일 구조에 맞게 최소 아래 목적의 script를 제공한다.

```text
npm run dev
npm run build
npm run start
npm run db:migrate
npm run e2e
```

필요하면 아래처럼 Phase별 E2E를 분리한다.

```text
npm run e2e:phase1
npm run e2e:phase2
```

단위 테스트용 `test:unit` script는 만들지 않는다.

`npm test`를 제공한다면 실제 E2E를 실행하도록 구성한다.

---

## 36. README 최종 상태

MVP 완료 시 README는 사람이 clone 후 실행할 수 있는 문서여야 한다.

최소 포함:

```text
서비스 설명
현재 구현 상태: MVP
학습 범위
사용자 유형
Service Rule
사용자 흐름
시간 기준
문구 규칙
기술 스택
아키텍처
환경 변수
로컬 실행 방법
API 계약
Core Invariant
MVP 범위
프로젝트 구조
문서 구조
Phase 3/4 미구현 상태
```

환경 변수는 실제 구현과 동일하게 아래만 기록한다.

```text
NODE_ENV
PORT
DATABASE_URL
```

문구 제한은 120자로 기록한다.

구현하지 않은 기능을 완료된 것처럼 쓰지 않는다.

실제로 측정하지 않은 latency/TPS 수치를 넣지 않는다.

---

## 37. Git 처리

작업 시작 전:

```text
git status
```

기존 사용자 변경 사항을 임의로 되돌리지 않는다.

Phase 1 완료 및 검증 후:

```text
feat: phase1-concurrency-core
```

Phase 2 완료 및 검증 후:

```text
feat: phase2-ticketing-ui
```

총 2개의 Phase commit을 목표로 한다.

`git push` 금지.

기존 unrelated 변경 때문에 안전한 commit이 불가능하면 해당 변경을 건드리지 않고 가능한 범위만 commit한다.

---

## 38. 범위 외 기능

이번 실행에서 선반영하지 않는다.

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

구현 선택이 여러 개일 때:

```text
1. .project/plan.md와 일치
2. 동시성 정합성
3. 사용자에게 보이는 실제 동작
4. 단순성
5. critical path 최소화
6. dependency 최소화
7. 가독성
8. 이후 확장성
```

현재 MVP에서 쓰이지 않는 abstraction보다 직접적인 코드를 우선한다.

### 리뷰

구현이 끝난 뒤 형식적인 리팩터링 리뷰를 하지 않는다.

구현 전에 확인한 요구사항과 실패 경로를 기준으로 아래만 검토한다.

```text
요구사항 누락
API 계약 불일치
동시성 invariant 위반
경계 시각 오류
DB query 증가
보안 정보 노출
E2E가 놓친 실제 사용자 흐름
현재 Phase 범위 초과
```

문제가 발견되면 수정하고 관련 E2E를 다시 실행한다.

---

## 40. 막힘 처리

중간에 사용자에게 진행 허가를 다시 요청하지 않는다.

현재 환경에서 실제 완료가 물리적으로 불가능한 경우 거짓으로 완료 처리하지 않는다.

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
2. 실패한 명령과 원인 확인
3. 범위 내 우회 방법이 있으면 수행
4. PostgreSQL을 SQLite/mock으로 임의 교체하지 않음
5. 검증하지 못한 항목을 성공 처리하지 않음
6. 결과 문서에 blocker 기록
7. 최종 보고에서 MVP 미완료 상태 명시

---

## 41. 최종 보고 형식

작업 종료 후 아래 순서로 보고한다.

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

위 지시를 모두 읽은 뒤 추가 계획 확인이나 중간 승인 요청 없이 바로 작업을 시작한다.

**Phase 1을 완성하고 실제 PostgreSQL E2E로 검증한 뒤 결과 문서와 commit을 남기고, 이어서 Phase 2를 완성하고 MVP 전체 E2E를 검증한 뒤 결과 문서, README 갱신, commit까지 수행한다.**

MVP 완료 이후 Phase 3 또는 Phase 4 작업은 시작하지 않는다.

`git push`는 수행하지 않는다.
