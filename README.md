# HourBoard

> **한 시간 동안 띄워드립니다**
>
> 매 정각 가장 먼저 등록된 한 문구를 한 시간 동안 노출하고, 첫 등록 후 10초 안의 참가자에게 서버 처리 기준 순위를 반환하는 선착순 동시성 실험 서비스

## 프로젝트 개요

HourBoard는 매시 정각 하나의 시간 슬롯을 열고, 해당 슬롯에 가장 먼저 등록된 문구 하나만 한 시간 동안 전광판에 노출하는 웹 서비스다.

사용자는 정각이 되기 전에 문구를 입력해두고 등록 버튼을 누른다. 같은 순간 여러 사용자가 요청을 보내면 서버와 PostgreSQL이 동일한 시간 슬롯을 두고 요청을 처리한다. 가장 먼저 확정된 요청은 `1등`이 되고, 해당 문구가 그 시간의 전광판을 차지한다.

첫 등록 이후 10초 안에 처리된 후속 요청은 전광판을 바꾸지 못하지만 자신의 처리 순위를 바로 확인할 수 있다. Registration Window가 종료된 뒤의 요청은 순위를 받지 않고 등록이 거부된다.

서비스 표면에서는 정각 티켓팅 연습과 가벼운 경쟁 경험을 제공한다. 개발 관점에서는 하나의 자원에 동시 요청이 몰릴 때 발생하는 race condition, atomic update, row contention, connection pool, 서버 시간 기준 처리, 부하 증가에 따른 latency 변화를 실제 서비스 규칙 안에서 구현하고 검증한다.

---

## 학습 범위

### Phase 1~2 구현·검증

- Race Condition
- PostgreSQL UPSERT
- Row Contention
- Atomic Counter
- MVCC
- Connection Pool
- Server Time Synchronization
- E2E Concurrency Test
- Registration Window
- 브라우저 핵심 사용자 흐름

### Phase 3 구현·검증

- Load Test
- p50 / p95 / p99 Latency
- Thundering Herd
- Client / Server Time Offset 비교
- Polling
- HTTP Shared Cache
- Cache Hit / Miss
- Open-State Propagation Delay

실제 로컬 PostgreSQL과 Fastify를 사용한 Phase 3 측정 결과는 [결과 문서](docs/results/phase3-load-race-verification.md)에 기록했다.

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

동시성 동작, 부하 특성, 실제 운영 배포 환경을 검증한다.

- 동시 요청 정합성 검증
- PostgreSQL row contention 관찰
- latency 측정
- E2E 동시성 검증
- k6 부하 테스트
- 외부 HTTPS 및 운영 복구 검증

---

## Service Rule

```text
하나의 Round 시작
→ 첫 정상 등록 = position 1 / Winner
→ 첫 등록 후 10초 동안 후속 등록 및 Position 부여
→ 10초 경과 후 REGISTRATION_CLOSED
→ Winner 문구는 다음 정각까지 유지
```

### Round

- Round는 매시 `00분 00초 000ms`에 시작한다.
- Round 길이는 1시간이다.
- 사용자는 Round 시작 전에 문구를 미리 입력할 수 있다.
- 등록 요청은 대상 Slot이 실제로 시작된 뒤에만 처리한다.
- 첫 정상 등록 이후 10초 미만 동안만 추가 등록을 허용한다. 마감 시각은 다음 정각을 넘지 않는다.
- 등록 마감 뒤에는 등록 버튼을 숨기고, 다음 정각 5분 전부터 비활성 상태로 다시 표시한다.
- 보정된 서버 시각이 정각에 도달하면 새 Round로 전환하며, 유효한 문구가 입력된 경우 버튼을 활성화한다.
- 실제 등록 허용 여부와 결과는 서버가 최종 판정한다.
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
    D --> E[등록 요청]
    E --> F{서버 처리 결과}
    F -->|position = 1| G[Winner]
    G --> H[10초 Registration Window 시작]
    F -->|position > 1| I[N번째 결과]
    F -->|REGISTRATION_CLOSED| J[등록 마감 안내]
    H --> K[10초 후 등록 마감]
    G --> L[Winner 문구는 다음 정각까지 유지]
```

---

## 시간 기준

- DB 저장 타입: `TIMESTAMPTZ`
- API와 DB 내부 기준: UTC
- 사용자 화면 표시: `Asia/Seoul`
- Slot 길이: 1시간
- Round 경계: 매시 정각
- Round 시작/종료 판정 기준: API 서버 시스템 시간
- Registration Window 시작 시각: PostgreSQL `created_at`
- Registration Window 최종 마감 판정: PostgreSQL `clock_timestamp()`
- 브라우저 시각: Countdown 표시용 보정에만 사용

브라우저 시간은 Countdown 보정에만 사용하고 등록 허용 여부의 최종 판정에는 사용하지 않는다.

`GET /api/round` 응답의 `serverTime`을 기준으로 브라우저 시각 차이를 보정한다.

---

## 문구 규칙

MVP 기준:

- 한 줄 텍스트만 허용
- 최대 120자
- 공백만 있는 문구 등록 금지
- 줄바꿈 금지
- 사용자 입력을 HTML로 실행하지 않음

문구 최대 길이 120자는 애플리케이션 입력 검증과 DB 제약 조건에서 동일하게 적용한다.

---

## 아키텍처

### 로컬 개발

```mermaid
flowchart LR
    Browser --> Fastify[Fastify API + Static Web]
    Fastify --> PostgreSQL[(PostgreSQL)]
```

개발 환경에서는 Fastify와 Docker Compose PostgreSQL을 로컬에서 실행한다.

### Phase 4B 운영 목표

```mermaid
flowchart LR
    Browser -->|HTTPS| DuckDNS[hourboard.duckdns.org]
    DuckDNS --> Router[Home Router\nTCP 443]
    Router --> Traefik[Traefik\nEcoBe-A1 Mini PC]
    Traefik --> Fastify[Fastify API + Static Web]
    Fastify --> PostgreSQL[(PostgreSQL)]
```

Phase 4B는 EcoBe-A1 Mini PC를 실제 운영 호스트로 사용한다.

- Host OS: Windows 11
- Linux Environment: WSL2 Ubuntu
- Container Runtime: Docker Desktop
- Reverse Proxy: Traefik
- Public Hostname: `hourboard.duckdns.org`
- HTTPS: Let's Encrypt DNS-01
- Dynamic DNS: DuckDNS
- 외부 공개 포트: TCP `443`
- Fastify `3000`, PostgreSQL `5432`는 Docker 내부에서만 사용

운영 경로:

```text
hourboard.duckdns.org
→ 가정망 공인 IPv4
→ 공유기 TCP 443
→ EcoBe-A1 Mini PC
→ Docker Desktop
→ Traefik
→ Fastify
→ PostgreSQL
```

현재 미니PC에서 Windows 11, WSL2 Ubuntu, Docker Desktop Linux Engine, x86_64 환경과 충분한 저장 공간을 확인했다. 현재 TCP 80/443/3000/5432 listener와 실행 중인 Docker 컨테이너가 없는 상태에서 Phase 4B 배포를 준비하고 있다.

### Phase 4A OCI 시도

OCI Japan East (Tokyo) A1 Flex를 무료 배포 후보로 검증했으나 Compute Capacity Report와 실제 생성 시도에서 host capacity 부족이 확인됐다.

유료 shape 또는 다른 Region으로 자동 전환하지 않고 Phase 4B 자체 호스팅 경로로 전환했다. OCI 진행 사실은 [Phase 4 OCI 진행 기록](docs/progress/phase4-oci-deployment.md)에 보존한다.

---

## 기술 스택

| Category | Technology |
| --- | --- |
| Runtime | Node.js 24 LTS |
| Language | TypeScript |
| Backend | Fastify 5.x |
| Database | PostgreSQL 18.x |
| Local Infrastructure | Docker Compose |
| Production Host | EcoBe-A1 Mini PC |
| Production Host OS | Windows 11 |
| Linux Environment | WSL2 Ubuntu |
| Container Runtime | Docker Desktop |
| Reverse Proxy | Traefik |
| Public Hostname | `hourboard.duckdns.org` |
| TLS | Let's Encrypt DNS-01 |
| Dynamic DNS | DuckDNS |
| Load Test | k6 |

---

## 로컬 개발 환경 변수

| Variable | Required | Purpose |
| --- | --- | --- |
| `NODE_ENV` | Yes | 실행 환경 구분 |
| `PORT` | Yes | Fastify 서버 포트 |
| `DATABASE_URL` | Yes | 로컬 개발용 PostgreSQL 연결 문자열 |

`.env`는 저장소에 커밋하지 않는다.

`.env.example`에는 비밀값을 넣지 않고 필요한 key와 로컬 개발 기준 형식만 제공한다.

```dotenv
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://hourboard:hourboard@localhost:5432/hourboard
```

운영 환경에서는 별도의 PostgreSQL 계정과 비밀번호를 사용하며 기본 비밀번호를 코드에 포함하지 않는다.

Phase 4B 운영 설정은 Git에서 제외된 `deploy/production.env`의 `ACME_EMAIL`, `POSTGRES_PASSWORD`, `DUCKDNS_TOKEN`을 사용한다. 실제 값의 설정 방법은 [Phase 4B 배포 지침](docs/instructions/phase4-self-hosted-deployment.md)을 따른다.

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

동일 Slot의 Registration Window 안에서 `S`건의 요청이 정상 등록되었다면 아래 조건을 만족해야 한다.

```text
winner count = 1
positions = 1..S
duplicate position = 0
missing position = 0
winner message mutation = 0
```

Registration Window 종료 후 `REGISTRATION_CLOSED`로 거부된 요청은 Position을 소비하지 않는다.

---

## Phase 상태

### Phase 1 — Concurrency Core

**상태: 완료**

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

**상태: 완료**

- 현재 전광판
- 빈 전광판 상태
- server time 보정
- 초 단위 Countdown
- 문구 사전 입력
- 등록 버튼
- 중복 클릭 차단
- Winner 결과
- N번째 결과
- 오류 상태 UI
- 모바일 반응형
- 접근성 상태 알림
- 첫 등록 후 10초 Registration Window
- `REGISTRATION_CLOSED` 처리
- Registration Window 초 단위 countdown
- Winner 없는 Round에서 등록 가능
- 등록 마감 후 버튼 숨김
- 다음 정각 5분 전 버튼 비활성 재표시
- 보정된 서버 시각 기준 새 Round 전환

### Phase 3 — Load, Race & Open-State Verification

**상태: 완료**

- 전용 `hourboard_loadtest` DB에서 Registration Race와 Thundering Herd 10 / 50 / 100 / 200 검증
- `GET /api/open-state`, Client Timer, Direct Polling, 1초 TTL 로컬 공유 캐시 비교
- 실제 정각 탐지와 polling 100 / 500 / 1000 client 측정
- Winner 1명, accepted 순위 `1..S`, 중복·누락·승자 문구 변경 0건 확인
- 결과: [Phase 3 측정 및 제한사항](docs/results/phase3-load-race-verification.md)

로컬 Compose PostgreSQL 실행 후 `NODE_ENV=test`, 로컬 `DATABASE_URL`, 포터블 k6의 `K6_BIN`을 셸 환경 변수로 설정하고 `npm.cmd run load:phase3`으로 전체 측정을 재실행할 수 있다. 스크립트는 별도 load-test DB를 사용하며 실제 다음 정각을 관찰한다.

### Phase 4 — Production Deployment

**상태: 진행 중**

Phase 3 로컬 baseline을 유지한 상태에서 실제 외부 배포, HTTPS, 복구, 보안 포트, 외부 E2E와 latency를 검증한다.

#### Phase 4A — OCI

- OCI Home Region: Japan East (Tokyo) / `ap-tokyo-1`
- A1 Flex 무료 배포 경로 검토
- Compute Capacity Report에서 host capacity 부족 확인
- 실제 Compute 생성 시도에서도 capacity 부족 확인
- 유료 shape 또는 다른 Region으로 자동 전환하지 않음
- 진행 기록: [Phase 4 OCI 진행 기록](docs/progress/phase4-oci-deployment.md)

#### Phase 4B — 자체 호스팅 미니PC

현재 기본 배포 경로다.

물리 환경:

| 항목 | 내용 |
| --- | --- |
| 장비 | EcoBe-A1 Mini PC |
| CPU | Intel N100 |
| Core / Thread | 4C / 4T |
| Memory | 16GB |
| Host OS | Windows 11 |
| Linux Environment | WSL2 Ubuntu |
| Container Runtime | Docker Desktop |

사전 확인 완료:

- 공유기 WAN IPv4와 외부 관측 IPv4 일치
- DuckDNS A 레코드 정상 해석
- 현재 확인 범위에서 CGNAT 징후 없음
- 미니PC Windows 11 / WSL2 / Docker Desktop 확인
- Docker Linux Engine / x86_64 확인
- 운영 배포에 충분한 저장 공간 확인
- 현재 실행 중 Docker 컨테이너 없음
- 현재 TCP 80/443/3000/5432 listener 없음
- Phase 4B 운영 구성 작성 및 작업 PC 정적 검증 완료
- 운영 구성 커밋 및 `origin/main` 반영 완료

남은 검증:

- 미니PC에서 운영 Compose 실제 build
- PostgreSQL / Fastify / Traefik 실제 기동
- DuckDNS updater
- Let's Encrypt DNS-01
- 공유기 TCP 443 포트포워딩
- Windows 방화벽
- 실제 외부 HTTPS
- production reboot
- DB persistence
- 실제 브라우저 흐름
- 외부 E2E
- 외부 RTT 및 p50 / p95 / p99

세부 지침: [Phase 4B 자체 호스팅 배포](docs/instructions/phase4-self-hosted-deployment.md)

---

## 디렉토리 구조

```text
hourboard/
├─ .project/
│  └─ plan.md
├─ db/
│  └─ migrations/
├─ deploy/
│  └─ production.env.example
├─ docs/
│  ├─ instructions/
│  ├─ progress/
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
├─ compose.prod.yaml
├─ Dockerfile.prod
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
| `docs/progress/*` | 진행 중인 인프라 시도와 사실 기록 |
| `docs/results/*` | 완료된 구현·검증 결과 |
| `docs/instructions/phase4-self-hosted-deployment.md` | Phase 4B 미니PC 배포·검증 지침 |
| `docs/progress/phase4-oci-deployment.md` | OCI Phase 4A 시도와 capacity 결과 |
