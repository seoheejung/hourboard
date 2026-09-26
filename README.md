# HourBoard

> **한 시간 동안 띄워드립니다**
>
> 매 정각 가장 먼저 등록된 한 문구를 한 시간 동안 노출하고, 첫 등록 후 10초 안의 참가자에게 서버 처리 기준 순위를 반환하는 선착순 동시성 실험 서비스

## 프로젝트 개요

HourBoard는 매시 정각 하나의 시간 슬롯을 열고, 해당 슬롯에 가장 먼저 등록된 문구 하나만 한 시간 동안 전광판에 노출하는 웹 서비스다.

사용자는 정각이 되기 전에 문구를 입력해두고 등록 버튼을 누른다.   
같은 순간 여러 사용자가 요청을 보내면 서버와 PostgreSQL이 동일한 시간 슬롯을 두고 요청을 처리한다.   
가장 먼저 확정된 요청은 `1등`이 되고, 해당 문구가 그 시간의 전광판을 차지한다.   
이후 요청은 전광판을 바꾸지 못하지만 자신의 처리 순위를 바로 확인할 수 있다.  

서비스 표면에서는 정각 티켓팅 연습과 가벼운 경쟁 경험을 제공한다.    
개발 관점에서는 하나의 자원에 동시 요청이 몰릴 때 발생하는 race condition, atomic update, row contention, connection pool, 서버 시간 기준 처리, 부하 증가에 따른 latency 변화를 실제 서비스 규칙 안에서 구현하고 검증한다.

---

## 학습 범위

- Race Condition
- PostgreSQL UPSERT
- Row Contention
- Atomic Counter
- MVCC
- Connection Pool
- Server Time Synchronization
- E2E Concurrency Test
- Load Test
- p50 / p95 / p99 Latency

---

## 사용자 유형

### 참가자

정각에 등록 버튼을 눌러 자신의 처리 순위를 확인하는 사용자다.

- 티켓팅 클릭 타이밍 연습
- 현재 네트워크 환경에서 자신의 처리 결과 확인
- 1등 전광판 점유 도전

### 관람 사용자

등록하지 않고 현재 전광판을 보는 사용자다.

- 현재 Winner 문구 확인
- 현재 Round 종료 시각 확인
- 다음 정각까지 남은 시간 확인
- 서비스 규칙 확인

### 개발자 / 운영자

MVP 이후 부하 검증과 운영 환경 검증을 포함해 시스템 동작을 확인한다.

- 동시 요청 정합성 검증
- PostgreSQL row contention 관찰
- latency 측정
- E2E 동시성 검증
- k6 부하 테스트
- OCI 배포 환경 검증

## Service Rule

```text
하나의 Round
→ 요청 순번 결정
→ position = 1만 Winner
→ Winner 문구 고정
```

### Round

- Round는 매시 `00분 00초 000ms`에 시작한다.
- Round 길이는 1시간이다.
- 사용자는 Round 시작 전에 문구를 미리 입력할 수 있다.
- 등록 요청은 대상 Slot이 실제로 시작된 뒤에만 처리한다.
- 첫 정상 등록 이후 10초 미만 동안만 추가 등록을 허용한다. 마감 시각은 다음 정각을 넘지 않는다.
- 새로운 Slot이 시작되면 이전 Winner 문구는 더 이상 현재 전광판에 표시하지 않는다.
- 새 Slot에 Winner가 아직 없다면 전광판은 빈 상태를 표시한다.

### Winner

- 각 Slot의 Winner는 한 명뿐이다.
- `position = 1`인 요청만 Winner다.
- Winner 문구는 최초 등록 시점에만 저장한다.
- 2등 이후 요청은 Winner 문구를 변경할 수 없다.
- 등록 마감 뒤에도 Winner 문구는 해당 Round 종료까지 전광판에 남는다.

1등 사용자:

```text
축하합니다!
가장 먼저 등록하셨습니다.
작성하신 문구를 다음 정각까지 띄워드립니다.
```

2등 이후:

```text
아쉽군요!
37번째로 등록하셨습니다!
```

### 순위 기준

순위는 브라우저에서 버튼을 누른 시각 순서가 아니다.

> 동일 시간 슬롯에 도착한 유효한 등록 요청이 서버를 거쳐 PostgreSQL의 해당 Slot row에 반영된 순서

네트워크 RTT, 서버 event loop scheduling, connection pool 대기, PostgreSQL row lock 획득 순서가 결과에 영향을 줄 수 있다.

### 반복 등록

MVP에서는 로그인이나 사용자 식별을 구현하지 않는다.

- HTTP 등록 요청 하나를 Attempt 하나로 취급한다.
- 같은 사용자가 여러 번 요청하면 각각 새로운 Attempt로 처리한다.
- 정상 UI에서는 제출 직후 중복 클릭을 막는다.
- API를 직접 반복 호출하는 행위까지 사용자 단위로 차단하지 않는다.

### 등록 결과를 확인하지 못한 경우

등록 API는 클라이언트에서 자동 재시도하지 않는다.

DB 처리는 완료됐지만 응답을 받기 전에 연결이 끊긴 경우, MVP에서는 기존 Attempt 결과를 다시 식별할 수 없다.

```text
등록 결과를 확인하지 못했습니다.
```

사용자가 직접 다시 등록하면 새로운 Attempt로 처리한다.

---

## 사용자 흐름

```mermaid
flowchart TD
    A[사이트 접속] --> B[현재 전광판 확인]
    B --> C[다음 정각 Countdown 확인]
    C --> D[문구 사전 입력]
    D --> E[정각 등록]
    E --> F{서버 처리 결과}
    F -->|position = 1| G[1등 결과 표시]
    G --> H[작성 문구 전광판 노출]
    F -->|position > 1| I[N번째 결과 표시]
```

---

## 시간 기준

- DB 저장 타입: `TIMESTAMPTZ`
- API와 DB 내부 기준: UTC
- 사용자 화면 표시: `Asia/Seoul`
- Slot 길이: 1시간
- Round 경계: 매시 정각
- 등록 가능 여부의 기준 시각: API 서버 시스템 시간

브라우저 시간은 Countdown 보정에만 사용하고 등록 허용 여부의 최종 판정에는 사용하지 않는다.

`GET /api/round` 응답의 `serverTime`을 기준으로 브라우저 시각 차이를 보정한다.

---

## 문구 규칙

MVP 기준:

- 한 줄 텍스트만 허용
- 최대 길이 기본값 `120`
- 공백만 있는 문구 등록 금지
- 줄바꿈 금지
- 사용자 입력을 HTML로 실행하지 않음

문구 최대 길이 120자는 애플리케이션 입력 검증과 DB 제약 조건에서 동일하게 적용한다.

---

## 아키텍처

```mermaid
flowchart LR
    Browser -->|HTTPS| Fastify[Fastify API\nOCI Seoul]
    k6 -->|Load Test| Fastify
    Fastify -->|localhost:5432| PostgreSQL[(PostgreSQL)]
```

API와 PostgreSQL은 동일 OCI Compute VM에서 실행한다. 외부 managed database를 사용하지 않는다.

---

## 기술 스택

| Category | Technology |
| --- | --- |
| Runtime | Node.js 24 LTS |
| Language | TypeScript |
| Backend | Fastify 5.x |
| Database | PostgreSQL 18.x |
| Infrastructure | OCI Compute Always Free |
| Region | Seoul — OCI home region이 Seoul인 계정 기준 |
| Load Test | k6 |

---

## 환경 변수

| Variable | Required | Purpose |
| --- | --- | --- |
| `NODE_ENV` | Yes | 실행 환경 구분 |
| `PORT` | Yes | Fastify 서버 포트 |
| `DATABASE_URL` | Yes | PostgreSQL 연결 문자열 |

`.env`는 저장소에 커밋하지 않는다.

`.env.example`에는 비밀값을 넣지 않고 필요한 key와 로컬 개발 기준 형식만 제공한다.

```dotenv
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://hourboard:hourboard@localhost:5432/hourboard
```

운영 환경에서는 별도의 PostgreSQL 계정과 비밀번호를 사용하며 기본 비밀번호를 코드에 포함하지 않는다.

---

## 로컬 실행 환경

### 요구사항

- Node.js 24 LTS
- npm
- Docker / Docker Compose

### 1. 저장소 설치

```bash
git clone <repository-url>
cd hourboard
npm install
```

### 2. 환경 변수 설정

```bash
cp .env.example .env
```

필요한 경우 `.env`의 `DATABASE_URL`, `PORT`를 로컬 환경에 맞게 수정한다.

서버와 migration은 실행 시 `.env`를 읽는다. 이미 셸에 설정한 환경 변수는 `.env` 값보다 우선한다.

### 3. PostgreSQL 실행

```bash
docker compose up -d
```

개발용 PostgreSQL은 `compose.yaml`에서 실행하며 운영 DB credential과 분리한다.

### 4. Migration 실행

```bash
npm run db:migrate
```

`db/migrations/`의 SQL을 기준으로 `hour_slots` 테이블을 구성한다.

### 5. 개발 서버 실행

```bash
npm run dev
```

기본 `PORT=3000` 기준:

```text
http://localhost:3000
```

상태 확인:

```text
GET http://localhost:3000/health
```

### 6. Production Build

```bash
npm run build
npm run start
```

### 7. E2E 검증

```bash
npm run e2e
```

Phase별 검증 script가 제공되는 경우:

```bash
npm run e2e:phase1
npm run e2e:phase2
```

이 프로젝트는 단위 테스트보다 실제 Fastify 서버와 실제 PostgreSQL을 연결한 E2E 검증을 우선한다.

---

## Core Invariant

동일 슬롯에서 N건의 요청이 모두 성공했다면 아래 조건을 만족해야 한다.

```text
winner count = 1
positions = 1..N
duplicate position = 0
missing position = 0
winner message mutation = 0
```

---

## MVP Scope

MVP는 아래 두 Phase 완료를 기준으로 한다.

### Phase 1 — Concurrency Core

- Fastify 서버
- 환경 변수 검증
- PostgreSQL connection pool
- migration
- 현재 Slot 계산
- `GET /health`
- `GET /api/round`
- `POST /api/attempts`
- atomic UPSERT
- 오류 계약
- 실제 PostgreSQL 기반 E2E

### Phase 2 — Ticketing UI

- 현재 전광판
- 빈 전광판 상태
- server time 보정
- millisecond Countdown
- 문구 사전 입력
- 등록 버튼
- 중복 클릭 차단
- Winner 결과
- N번째 결과
- 오류 상태 UI
- 모바일 반응형
- 접근성 상태 알림

Phase 3 부하 검증과 Phase 4 OCI 배포는 MVP 완료 이후 별도로 진행한다.

---

## 디렉토리 구조

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
├─ .env.example
├─ compose.yaml
├─ .gitignore
├─ AGENTS.md
├─ DESIGN.md
└─ README.md
```

---

## 문서

| Document | Purpose |
| --- | --- |
| `.project/plan.md` | 프로젝트 범위, 사용자 규칙, 동시성 설계, API, Phase, 완료 기준 |
| `AGENTS.md` | 저장소 작업 규칙 |
| `DESIGN.md` | 전광판 UI, 상태, 접근성, 성능 기준 |
| `docs/instructions/*` | 현재 Phase 작업 지침 |
| `docs/results/*` | 완료된 구현·검증 결과 |

---
