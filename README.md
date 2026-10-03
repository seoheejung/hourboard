# HourBoard

### [**한 시간 동안 띄워드립니다**](https://hourboard.duckdns.org/)

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
→ 서버는 첫 등록 후 10초 동안 다른 후속 등록과 Position 부여 허용
→ 정상 등록 응답을 받은 현재 페이지 세션은 즉시 참여 완료 상태
→ 10초 경과 후 서버는 REGISTRATION_CLOSED
→ Winner 문구는 다음 정각까지 유지
```
### Round

- Round는 매시 `00분 00초 000ms`에 시작한다.
- Round 길이는 1시간이다.
- 사용자는 Round 시작 전에 문구를 미리 입력할 수 있다.
- 등록 요청은 대상 Slot이 실제로 시작된 뒤에만 처리한다.
- 서버의 Registration Window는 첫 정상 등록 이후 10초 미만 동안 유지되며 마감 시각은 다음 정각을 넘지 않는다.
- `WINNER` 또는 `RANKED` 응답을 받은 현재 페이지 세션은 해당 Round에서 등록 버튼을 즉시 숨기고 추가 UI 제출을 막는다.
- 등록에 성공하면 제출한 문구를 입력창에서 비운다. 전광판과 결과 카드는 유지하며, 다음 Round용 문구는 다시 입력할 수 있다.
- 정상 등록 응답을 받은 현재 페이지에는 Registration Window countdown을 표시하지 않고 결과 카드는 유지한다.
- 아직 등록하지 않은 다른 브라우저는 서버 Registration Window가 열려 있는 동안 기존 규칙대로 등록할 수 있다.
- Registration Window가 끝난 뒤 미등록 사용자에게는 등록 마감 상태를 표시한다.
- 참여 완료 상태는 브라우저 영속 저장소에 기록하지 않는다. 페이지 새로고침 후에는 복원되지 않으며, 서버에 사용자 식별 기능이 없어 등록 버튼이 다시 나타날 수 있다.
- 현재 페이지에서 새 Round를 감지하면 참여 완료 상태를 초기화하고 등록 UI를 다시 사용할 수 있게 한다.
- 실제 등록 허용 여부와 Position은 서버와 PostgreSQL이 최종 판정한다.
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
- API를 직접 반복 호출하는 행위까지 사용자 단위로 식별·차단하지 않는다.
- 정상 UI에서는 제출 중 중복 클릭을 막고, 정상 등록 응답을 받은 현재 페이지 세션에서는 해당 Round의 등록 버튼을 숨긴다.
- 이 UI 제한은 서버의 10초 Registration Window를 변경하지 않는다.

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
    F -->|position = 1| G[Winner 결과]
    F -->|position > 1| H[N번째 결과]
    G --> I[현재 페이지 등록 버튼 즉시 숨김]
    H --> I
    I --> J[결과 카드 유지]
    F -->|REGISTRATION_CLOSED| K[등록 마감 안내]
    J --> L[다른 사용자는 10초 Window 안에서 계속 등록 가능]
    L --> M[10초 후 서버 등록 마감]
    G --> N[Winner 문구는 다음 정각까지 유지]
    M --> O[다음 Round에서 참여 완료 상태 초기화]
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

### Phase 4B 운영 배포
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
미니PC에서 운영 Compose를 기동했고, 외부 LTE/5G에서 HTTPS 화면과 API 접속을 확인했다. Windows 재부팅 후에도 컨테이너와 외부 HTTPS가 복구되고 이전 Winner·attemptCount가 유지됐다. 외부 LTE/5G 핫스팟에서 Registration Race와 GET/POST latency, TCP 443 연결 시간을 측정했다.

운영 화면:

| Winner 표시 | 등록 가능 상태 |
| --- | --- |
| <img src="docs/image/Screenshot_1.png" alt="HourBoard 모바일 화면의 Winner 전광판" width="280"> | <img src="docs/image/Screenshot_2.png" alt="HourBoard 모바일 화면의 등록 가능 상태" width="280"> |

### Phase 4A OCI 시도

OCI Japan East (Tokyo) A1 Flex를 무료 배포 후보로 검증했으나 Compute Capacity Report와 실제 생성 시도에서 host capacity 부족이 확인됐다.

유료 shape 또는 다른 Region으로 자동 전환하지 않고 Phase 4B 자체 호스팅 경로로 전환했다. OCI 진행 사실은 [Phase 4 OCI 진행 기록](docs/progress/phase4-oci-deployment.md)에 보존한다.

---

## Beta UI · Web 품질 보강

기본 Beta UI/Web 품질 변경은 commit `6455d7b`에, 등록 완료 UI와 보안 헤더는 commit `7ba177e`에 반영했다. 최신 변경은 Production에 배포했고 실제 HTTPS 응답과 브라우저에서 확인했다. [로컬 검증 결과](docs/results/phase4-local-ui-security-followup.md)에 초기 확인 범위를 기록했다.

- 모바일 제목 줄바꿈과 overflow 보정
- 입력 오류 안내 개선
- 요청 제한 시 HTTP `429` 사용자 안내 추가
- 페이지 제목과 Open Graph metadata 설정
- `public/og-image.png` 추가
- `public/robots.txt` 추가
- `public/sitemap.xml` 추가
- `/api` 미정의 경로에 JSON 404 응답 추가
- Production Traefik에서 `POST /api/attempts`에만 rate limit middleware 적용
- 등록 성공 후 버튼·마감 안내를 숨기고 제출한 입력 문구를 비움. 결과 카드와 Winner 전광판은 유지
- 응답에 CSP, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` 추가
- 전광판·버튼·disabled 상태의 색상 대비 계산값 4.79:1 이상 확인
- 프런트엔드 정적 파일에서 운영 secret 관련 문자열 미검출 확인

로컬에서 `npm run build`, 실제 PostgreSQL Phase 1·2 E2E, 실제 Chrome 두 브라우저 컨텍스트 등록 E2E, 보안 헤더·본문 제한·JSON 404 HTTP 확인을 통과했다. Production Compose 설정 검사는 앞선 Beta 작업에서 통과했다.

Production 확인 결과:

- 작업 PC의 동일 LAN에서 공개 HTTPS 주소를 통한 실제 Chrome 세 브라우저 컨텍스트로 Winner / Ranked / 미등록 브라우저의 10초 내 참여, 입력창 초기화, 결과 카드 유지, 등록 버튼 숨김, 다음 Round 초기화 확인
- HTTPS 루트·`/health`·`/api/round` 응답에서 CSP·`nosniff`·`no-referrer` 확인
- 미정의 `/api` 경로는 JSON 404, 4 KiB 초과 등록 본문은 stack trace 없는 JSON 400 확인
- 등록 API 전용 rate limit의 HTTP 429와 GET 경로의 정상 응답 확인
- 정각 경계의 병렬 등록 100건과 후속 등록 1건에서 Winner 1명, 중복·누락 순위 0건 확인
- PostgreSQL 컨테이너 재생성 후 Winner와 attemptCount 유지 확인
- 페이지 로드는 작업 PC의 동일 LAN에서 공개 HTTPS 주소로 측정했다. GET/POST 지연 시간은 동일 LAN과 외부 LTE/5G 핫스팟에서 각각 측정했고, 외부 TCP 443 연결 시간도 기록했다

HTTPS는 현재 TCP 443 전용으로 운영하며 HTTP 80 → HTTPS redirect는 구성하지 않는다.

현재 GitHub Actions는 사용하지 않는다. 빌드·Compose 검사는 작업 PC에서 수행하고 Production 배포는 미니PC에서 수동으로 진행한다.

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
- 서버의 첫 등록 후 10초 Registration Window
- `REGISTRATION_CLOSED` 처리
- 미등록 사용자의 Registration Window 상태 처리
- Winner 없는 Round에서 등록 가능
- `WINNER` / `RANKED` 성공 응답을 받은 현재 페이지의 등록 버튼 즉시 숨김·비활성화
- 정상 등록 응답을 받은 현재 페이지에 10초 마감 countdown 미표시
- 등록 성공 결과 카드 유지
- 등록 성공 후 입력창의 제출 문구 비움
- 현재 페이지에서 다음 Round 감지 시 참여 완료 상태 초기화
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

**상태: 완료**

Phase 3 로컬 baseline을 유지한 상태에서 실제 외부 배포, HTTPS, 복구, 보안 포트, 외부 E2E와 latency를 검증한다.

#### Phase 4A — OCI

- OCI Home Region: Japan East (Tokyo) / `ap-tokyo-1`
- A1 Flex 무료 배포 경로 검토
- Compute Capacity Report에서 host capacity 부족 확인
- 실제 Compute 생성 시도에서도 capacity 부족 확인
- 유료 shape 또는 다른 Region으로 자동 전환하지 않음
- 진행 기록: [Phase 4 OCI 진행 기록](docs/progress/phase4-oci-deployment.md)

#### Phase 4B — 자체 호스팅 미니PC

현재 운영 중인 기본 배포 경로다. [운영 사이트](https://hourboard.duckdns.org/)와 [Phase 4 Production 결과](docs/results/phase4-production-deployment.md)에서 실제 확인 범위를 볼 수 있다. 초기 배포와 재부팅 이력은 [Phase 4B 진행 기록](docs/progress/phase4-self-hosted-deployment.md)에 남겼다.

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

확인 완료:

- 공유기 WAN IPv4와 외부 관측 IPv4 일치
- DuckDNS A 레코드와 현재 공인 IPv4 일치
- DuckDNS updater 반복 갱신 성공 확인
- 현재 확인 범위에서 CGNAT 징후 없음
- 미니PC Windows 11 / WSL2 / Docker Desktop 확인
- Docker Linux Engine / x86_64 확인
- 운영 배포에 충분한 저장 공간 확인
- Phase 4B 운영 Compose 실제 build 및 app·PostgreSQL·Traefik·DuckDNS updater 기동
- migration 정상 종료, PostgreSQL healthy
- host TCP 443만 publish, Fastify·PostgreSQL host port 비공개
- DHCP 예약과 공유기 TCP 443 포트포워딩
- LAN 및 외부 LTE/5G HTTPS 화면·API 응답
- Windows reboot 후 컨테이너와 외부 HTTPS 자동 복구
- reboot 후 `GET /api/round` 200 확인
- reboot 전후 Winner·attemptCount 유지로 host reboot 기준 DB persistence 확인
- Windows AC 자동 절전 비활성, 최근 Kernel-Power 42 기록 없음 확인
- Traefik Docker socket이 read-only bind mount로 직접 연결된 상태 확인
- Fastify container가 `node` 사용자로 실행됨을 확인
- 정상 상태 incident baseline 로그 수집

Production에 배포된 변경:

- 모바일 제목/overflow 보정
- 입력 오류·429 안내
- title / Open Graph / og-image / robots.txt / sitemap.xml
- `/api` JSON 404
- `POST /api/attempts` Traefik rate limit
- 등록 성공 응답을 받은 현재 페이지의 버튼 즉시 숨김·10초 안내 미표시·입력 문구 비움·다음 Round 감지 시 초기화
- CSP·`nosniff`·`no-referrer` 응답 헤더

외부 LTE/5G 핫스팟에서 병렬 등록 30건과 후속 등록 1건의 Winner·순위·10초 Window 불변식을 확인했다. 외부 TCP 443 연결 시간 20회, GET 40회, POST 31회의 p50 / p95 / p99와 동일 LAN 측정값을 분리해 [Phase 4 Production 결과](docs/results/phase4-production-deployment.md)에 기록했다. Docker socket 직접 mount는 현행 구성을 유지하고 보강을 별도 인프라 변경으로 검토한다.

작업 PC 검증 결과: [로컬 등록 완료 UI·보안 점검](docs/results/phase4-local-ui-security-followup.md)

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
│  ├─ image/
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
│  ├─ styles/
│  ├─ og-image.png
│  ├─ robots.txt
│  └─ sitemap.xml
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
| `docs/progress/phase4-self-hosted-deployment.md` | Phase 4B 초기 배포와 재부팅 진행 기록 |
| `docs/results/phase4-production-deployment.md` | Phase 4 운영 배포·외부 E2E·지연 시간 결과 |
