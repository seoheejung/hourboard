# HourBoard 프로젝트 기획서

## 1. 프로젝트 정의

- **프로젝트명:** HourBoard
- **사이트명:** 한시간동안 띄워드립니다
- **GitHub Repository:** `hourboard`
- **한 줄 설명:** 매 정각 가장 먼저 등록된 한 문구를 한 시간 동안 노출하고, 모든 참가자에게 서버 처리 기준 순위를 반환하는 선착순 동시성 실험 서비스

HourBoard는 정각에 동시에 몰리는 요청을 하나의 시간 슬롯에 경쟁시키는 웹 서비스다. 가장 먼저 처리된 요청의 문구만 해당 시간의 전광판을 차지한다. 이후 요청은 전광판을 변경하지 못하며 자신이 몇 번째로 처리되었는지 즉시 확인한다.

사용자에게는 정각 티켓팅 연습 서비스로 보이고, 개발 관점에서는 동일 자원을 동시에 선점하는 요청의 정합성·순서·성능을 검증하는 프로젝트다.

---

## 2. 핵심 규칙

1. 한 라운드는 매시 정각에 시작하고 1시간 동안 유지한다.
2. 라운드 시작 전에 사용자는 문구를 미리 입력할 수 있다.
3. 등록 요청은 목표 시간 슬롯이 실제로 시작된 뒤에만 허용한다.
4. 해당 슬롯에서 PostgreSQL이 처음 확정한 요청 1건만 승자가 된다.
5. 승자의 문구는 다음 정각 전까지 전광판에 노출한다.
6. 모든 성공 요청은 `1, 2, 3 ... N` 형태의 고유 순위를 받는다.
7. 순위 기준은 브라우저 클릭 시각이 아니라 서버와 PostgreSQL이 요청을 처리한 순서다.
8. 한 HTTP 등록 요청을 한 번의 도전으로 취급한다.
9. 초기 버전은 로그인, 사용자 계정, 과거 순위 복구를 제공하지 않는다.
10. 전광판 문구에는 HTML을 허용하지 않고 일반 문자열만 저장·출력한다.

### 사용자 문구

**1등**

> 축하합니다!  ~`
> 가장 먼저 등록하셨습니다.  
> 작성하신 문구를 다음 정각까지 띄워드립니다.

**2등 이후**

> 아쉽군요!  
> {position}번째로 등록하셨습니다!

---

## 3. 목표

### 제품 목표

- 정각 선착순 경쟁을 누구나 바로 이해할 수 있는 단순한 웹 서비스 제공
- 현재 전광판 문구와 남은 표시 시간을 명확하게 노출
- 등록 직후 사용자의 처리 순위를 즉시 반환
- 모바일 환경에서도 별도 설명 없이 사용할 수 있는 티켓팅 연습 UX 제공

### 기술 목표

- 동시에 들어온 요청에서 승자를 정확히 1명만 확정
- 모든 처리 성공 요청에 중복 없는 순번 부여
- hot path의 DB 접근을 등록 요청당 1회로 제한
- API 서버와 PostgreSQL을 동일 OCI VM에 배치해 외부 DB RTT 제거
- PostgreSQL row contention과 atomic UPSERT 동작 직접 검증
- 동시 요청 증가에 따른 p50 / p95 / p99 latency 변화 측정
- E2E 부하 테스트 결과를 반복 가능한 아티팩트로 저장

---

## 4. 범위 제외

초기 프로젝트 범위에 포함하지 않는다.

- 회원가입 및 로그인
- 소셜 로그인
- 사용자 프로필
- 과거 도전 기록 조회
- 사용자별 중복 등록 제한
- 관리자 페이지
- Redis~
- 메시지 큐
- 다중 API 서버 인스턴스
- 별도 managed database
- WebSocket 기반 채팅
- 결제
- 광고
- 알림
- AI 기능

범위 추가는 기획 변경으로 취급하고 `.project/plan.md`를 먼저 수정한다.

---

## 5. 기술 스택

| 영역 | 선택 | 기준 |
| --- | --- | --- |
| Runtime | Node.js 24 LTS | 안정 LTS 사용 |
| Language | TypeScript | 서버·브라우저 공통 타입 관리 |
| Backend | Fastify 5.x | 낮은 오버헤드, JSON Schema 기반 검증 |
| Database | PostgreSQL 18.x | UPSERT, row locking, MVCC 기반 동시성 검증 |
| Infrastructure | OCI Compute Always Free | 단일 Linux VM |
| Region | OCI Seoul | OCI home region이 서울인 계정 기준 |
| Load Test | k6 | 동시 요청 및 latency 측정 |
| Process | systemd | API 프로세스 상시 실행 |

### 버전 정책

- prerelease 버전 사용 금지
- PostgreSQL 19 Beta 계열 사용 금지
- 구현 시작 시 안정 버전의 최신 patch/minor를 확인한 뒤 고정
- lock file 갱신은 사용자 승인 이후 수행

---

## 6. 인프라 구조

```mermaid
flowchart LR
    U[Browser] -->|HTTPS| A[Fastify API\nOCI Seoul VM]
    K[k6] -->|Load Test| A
    A -->|localhost:5432| P[(PostgreSQL)]
```

### 배치 원칙

- OCI Always Free Compute는 계정 home region에서 생성
- 서울 배포는 OCI home region이 Seoul인 계정 기준
- VM.Standard.A1.Flex 2 OCPU / 12 GB 범위의 단일 VM을 우선 검토
- Always Free capacity 확보 실패 시 임의의 유료 shape로 변경 금지
- API와 PostgreSQL을 동일 VM에 배치
- PostgreSQL 5432 포트 외부 공개 금지
- PostgreSQL은 localhost 또는 private interface에서만 수신
- 외부 공개 포트는 웹 서비스에 필요한 포트만 허용
- DB connection pool은 애플리케이션 시작 시 생성하고 요청마다 재생성하지 않음
- 애플리케이션 상태를 메모리에만 저장하지 않음

---

## 7. 시간 모델

### 기준

- 저장 시간은 UTC 기반 `TIMESTAMPTZ`
- 사용자 표시는 Asia/Seoul 기준
- 라운드 경계는 매시 `00:00:00.000`
- API 서버의 시스템 시간을 authoritative clock으로 사용
- OCI VM의 시스템 시간 동기화 상태를 운영 점검 항목에 포함

### 목표 슬롯 검증

클라이언트는 등록 요청에 `slotAt`을 포함한다.

서버는 자신의 시스템 시간을 기준으로 요청의 `slotAt` 형식과 현재 Round 여부를 검증한다.

- `slotAt` 형식 오류 또는 정각이 아님: `400 INVALID_SLOT`
- 목표 Slot이 아직 시작 전: `425 ROUND_NOT_STARTED`
- 목표 Slot이 이미 종료: `409 ROUND_ENDED`
- 목표 Slot이 현재 활성 Slot: 등록 처리

등록 가능한 시간 범위:

```text
slotAt <= serverTime < slotAt + 1 hour
```

이 검증은 DB 접근 전에 수행한다.

---

## 8. 데이터 모델

### `hour_slots`

```sql
CREATE TABLE hour_slots (
    slot_start      TIMESTAMPTZ PRIMARY KEY,
    winner_message  TEXT NOT NULL,
    attempt_count   BIGINT NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

초기 버전은 시간 슬롯 하나를 row 하나로 표현한다.

- `slot_start`: 시간 슬롯 고유 키
- `winner_message`: 최초 요청의 문구
- `attempt_count`: 해당 슬롯에서 처리된 요청 수이자 최신 순번
- `created_at`: 승자 확정 시각

참가자 전체 기록을 별도 테이블에 저장하지 않는다. 등록 hot path를 단일 row write로 유지하기 위한 결정이다.

---

## 9. 핵심 동시성 처리

등록 요청은 SQL 1회로 승자 확정과 순번 증가를 처리한다.

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

### 처리 의미

- 최초 INSERT 성공 요청: `attempt_count = 1`
- 이후 충돌 요청: 기존 row의 `attempt_count + 1`
- `winner_message`는 conflict update에서 수정하지 않음
- `attempt_count === 1`이면 승자
- 반환된 `attempt_count`가 사용자 순위

### 보장해야 할 불변식

동일 슬롯에서 N건의 요청이 모두 성공했을 때:

```text
winner count = 1
positions = 1..N
duplicate position = 0
missing position = 0
winner message mutation = 0
```

순위는 브라우저 클릭 timestamp 정렬값이 아니다. 같은 row를 갱신하는 PostgreSQL 처리 결과를 기준으로 한다.

---

## 10. API 계약

### `GET /api/round`

현재 전광판과 다음 라운드 시간을 조회한다.

응답 형태:

```json
{
  "serverTime": "2026-09-26T09:32:14.120Z",
  "currentSlot": {
    "startsAt": "2026-09-26T09:00:00.000Z",
    "endsAt": "2026-09-26T10:00:00.000Z",
    "message": "오늘은 칼퇴합니다",
    "attemptCount": 438
  },
  "nextSlotAt": "2026-09-26T10:00:00.000Z"
}
```

현재 슬롯에 등록이 한 건도 없으면 `message`와 `attemptCount`는 `null`로 반환한다.

### `POST /api/attempts`

현재 Round 등록.

클라이언트는 도전하려는 Round의 `slotAt`과 문구를 전달한다. 서버는 시스템 시간을 기준으로 `slotAt`이 현재 등록 가능한 Round인지 검증한다.

#### 요청

```json
{
  "targetSlotAt": "2026-09-26T10:00:00.000Z",
  "message": "오늘도 살아남았다"
}
```

#### Winner 응답

```json
{
  "slotAt": "2026-09-26T11:00:00.000Z",
  "code": "WINNER",
  "message": "가장 먼저 등록하셨습니다. 작성하신 문구를 다음 정각까지 띄워드립니다.",
  "position": 1,
  "winner": true
}
```

#### 2등 이후 응답

```json
{
  "slotAt": "2026-09-26T11:00:00.000Z",
  "code": "RANKED",
  "message": "37번째로 등록하셨습니다.",
  "position": 37,
  "winner": false
}
```

등록 성공 응답은 slotAt, code, message, position, winner 구조를 공통으로 사용한다.

Winner가 아닌 응답에는 다른 사용자의 winner_message를 포함하지 않는다. 현재 전광판 상태와 Winner 문구는 GET /api/round에서 조회한다.

### 오류 코드

| HTTP | Code | 의미 |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | 요청 본문 또는 입력 형식 오류 |
| 400 | `INVALID_SLOT` | `slotAt` 형식 오류 또는 정각이 아닌 Slot |
| 409 | `ROUND_ENDED` | 목표 Round 종료 |
| 425 | `ROUND_NOT_STARTED` | 목표 Round 시작 전 |
| 500 | `INTERNAL_ERROR` | 서버 내부 처리 실패 |
| 503 | `DATABASE_UNAVAILABLE` | PostgreSQL 연결 불가 |

오류 응답은 `code`, `message`, `position`, `winner` 구조를 공통으로 사용한다.

```json
{
  "code": "ROUND_NOT_STARTED",
  "message": "아직 시작하지 않은 Round입니다.",
  "position": null,
  "winner": false
}
```

---

## 11. 성능 원칙

등록 요청의 critical path:

```text
request receive
→ input validation
→ slot validation
→ PostgreSQL UPSERT 1회
→ response serialize
→ response send
```

금지:

```text
SELECT 존재 확인
→ INSERT 또는 UPDATE
→ SELECT 순위 조회
```

필수 원칙:

- 등록 요청당 PostgreSQL query 1회
- DB connection pool 재사용
- winner 결정 전 외부 API 호출 금지
- winner 결정 전 로그 저장용 추가 DB write 금지
- hot row에 JSON 배열 누적 금지
- 등록 API에서 파일 I/O 금지
- 불필요한 ORM 추상화 도입 금지
- 성능 측정 전 임의의 cache/Redis 추가 금지

절대 latency 목표는 기획 단계에서 임의로 확정하지 않는다. Phase 3에서 OCI 환경의 실제 baseline을 측정한 뒤 성능 budget을 확정한다.

측정 항목:

- server processing time
- end-to-end latency
- p50
- p95
- p99
- requests/sec
- DB lock wait
- 오류율
- 중복 순위 건수
- 누락 순위 건수

---

## 12. 보안 및 입력 정책

- 문구는 일반 문자열만 허용
- HTML 저장·렌더링 금지
- 브라우저 출력은 `textContent` 또는 동등한 escaping 방식 사용
- request body 최대 크기 제한
- 문구 길이 제한 적용
- 빈 문자열 및 공백-only 문자열 거부
- DB credential은 환경 변수로 관리
- `.env` 커밋 금지
- PostgreSQL 외부 공개 금지
- production stack trace 클라이언트 노출 금지

---

## 13. Repository 구조

```text
hourboard/
├─ .project/
│  └─ plan.md
├─ db/
│  └─ migrations/
├─ docs/
│  ├─ instructions/
│  └─ results/
├─ src/
│  ├─ config/
│  ├─ db/
│  ├─ routes/
│  ├─ schemas/
│  ├─ services/
│  └─ shared/
├─ public/
│  ├─ scripts/
│  └─ styles/
├─ tests/
│  └─ e2e/
│     └─ artifacts/
├─ k6/
│  ├─ scenarios/
│  └─ results/
├─ .gitignore
├─ AGENTS.md
├─ DESIGN.md
└─ README.md
```

### 디렉토리 책임

| 경로 | 책임 |
| --- | --- |
| `src/config/` | 환경 변수 및 런타임 설정 |
| `src/db/` | PostgreSQL pool 및 query 실행 경계 |
| `src/routes/` | Fastify route 등록 |
| `src/schemas/` | request/response JSON Schema |
| `src/services/` | 슬롯·등록 도메인 로직 |
| `src/shared/` | 여러 모듈이 공유하는 최소 공통 코드 |
| `db/migrations/` | PostgreSQL schema 변경 |
| `public/` | 브라우저 정적 자산 |
| `tests/e2e/` | 사용자 흐름 및 동시성 E2E 검증 |
| `tests/e2e/artifacts/` | 반복 가능한 E2E 결과 아티팩트 |
| `k6/scenarios/` | 부하 테스트 시나리오 |
| `k6/results/` | k6 원본·요약 결과 |
| `docs/instructions/` | 현재 Phase 구현 지침 |
| `docs/results/` | 완료된 Phase 구현·검증 결과 |

구현 전 단계에서는 디렉토리만 유지하고 미완성 소스 파일을 선행 생성하지 않는다.

---

## 14. Phase 계획

### Phase 1 — Concurrency Core

범위:

- Fastify 프로젝트 초기화
- PostgreSQL 연결
- `hour_slots` schema
- 현재 슬롯 계산
- `POST /api/attempts`
- atomic UPSERT 기반 순위 반환
- `GET /api/round`
- 입력 검증
- E2E 동시성 검증

완료 기준:

- 동일 슬롯 동시 요청에서 승자 1명
- 순위 `1..N` 중복·누락 없음
- 승자 문구 변경 없음
- 등록 hot path DB query 1회
- E2E 결과 아티팩트 저장

### Phase 2 — Ticketing UI

범위:

- 전광판 화면
- 문구 사전 입력
- 다음 정각 countdown
- 서버 시간 보정
- 등록 버튼 상태 처리
- 1등 결과 UI
- N등 결과 UI
- `INVALID_SLOT` 오류 UI
- `ROUND_NOT_STARTED` 오류 UI
- `ROUND_ENDED` 오류 UI
- 모바일 대응
- 접근성 상태 알림

완료 기준:

- 다음 슬롯 시작 전/후 UI 상태 전환 정상
- `INVALID_SLOT`, `ROUND_NOT_STARTED`, `ROUND_ENDED` 처리 정상
- `WINNER`, `RANKED` 결과가 `position`과 일치
- 현재 Winner 문구가 해당 Round 종료 전까지 유지
- 새로운 Round가 시작되면 이전 Winner 문구를 현재 전광판에 표시하지 않음

### Phase 3 — Load & Race Verification

범위:

- k6 시나리오
- 동시 요청 10 / 50 / 100 / 200 단계 측정
- p50 / p95 / p99 기록
- PostgreSQL lock contention 관찰
- 순위 정합성 자동 검증
- 반복 가능한 결과 아티팩트 생성

완료 기준:

- 각 부하 단계 결과 저장
- winner 1명 검증
- 순위 중복·누락 0건 검증
- latency baseline 문서화
- 병목 위치를 측정값으로 식별

### Phase 4 — OCI Deployment

범위:

- OCI Seoul VM 배포
- Node.js 24 LTS
- PostgreSQL 18.x
- systemd 프로세스 실행
- DB localhost 제한
- 환경 변수 설정
- HTTPS 연결
- 실제 외부 RTT 측정
- 배포 환경 E2E 재검증

완료 기준:

- VM 재부팅 후 API·PostgreSQL 정상 복구
- 외부에서 PostgreSQL 5432 접근 불가
- HTTPS 서비스 접근 가능
- 배포 환경에서 Phase 3 핵심 정합성 테스트 통과

---

## 15. 현재 단계에서 구현하지 않는 확장안

아래 항목은 현재 Phase에 선반영하지 않는다.

- Redis atomic counter
- 여러 API 인스턴스
- 별도 ranking service
- historical attempts table
- 회원별 최고 기록
- 리더보드
- WebSocket/SSE
- CDN 기반 정적 배포 분리

필요성이 실제 측정으로 확인되면 기획 변경 후 별도 Phase로 추가한다.

---

## 16. GitHub Repository 정보

### Repository

```text
hourboard
```

### Description

```text
매 정각 가장 먼저 등록된 한 문구를 한 시간 동안 노출하고, 모든 참가자에게 서버 처리 기준 순위를 반환하는 선착순 동시성 실험 서비스
```

### Topics

```text
nodejs
typescript
fastify
postgresql
concurrency
race-condition
load-testing
k6
oci
```

---

## 17. 기술 기준 출처

- Node.js Downloads: https://nodejs.org/en/download/current
- Fastify Documentation: https://fastify.dev/docs/latest/
- PostgreSQL Versioning Policy: https://www.postgresql.org/support/versioning/
- OCI Free Tier: https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm
