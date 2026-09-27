# HourBoard Phase 4 — OCI Deployment 구현 지시서

> 대상: OpenAI Codex

>

> 목표: Phase 1~3이 완료된 HourBoard를 OCI Seoul Always Free Compute에 배포하고, Node.js + PostgreSQL을 동일 VM에서 운영하며 HTTPS, systemd 자동 복구, PostgreSQL localhost 제한, 외부 E2E와 실제 외부 latency를 검증한다.

---

## 0. 실행 모드

이 지시서는 **Phase 4만 수행하는 독립 작업 지시서**다.

작업 우선순위:

```text
사용자의 현재 명시적 지시
↓
.project/plan.md
↓
docs/instructions/phase4-oci-deployment.md
↓
AGENTS.md
↓
README.md
```

작업 시작 전에 반드시 읽는다.

```text
.project/plan.md
AGENTS.md
README.md
docs/codebase-assumptions-review.md
docs/results/phase1-concurrency-core.md
docs/results/phase2-ticketing-ui.md
docs/results/phase3-load-race-verification.md
```

Phase 1~3이 실제 완료되지 않았다면 Phase 4 완료로 처리하지 않는다.

`docs/codebase-assumptions-review.md`의 분류를 그대로 따른다.

```text
검증됨
→ 실제 코드에서 확인된 사실
→ 근거 없이 변경하지 않음

추측됨
→ 코드 또는 로컬 결과만으로 보장할 수 없는 전제
→ Phase 4에서 먼저 검증
→ 실제 문제가 확인된 경우에만 최소 범위 수정
```

Phase 3 baseline, atomic UPSERT, Winner/Position semantics, 10초 Registration Window를 Phase 4 편의를 위해 임의로 재설계하지 않는다.

### 0.1 Local Pre-Deployment Gate

OCI 리소스를 생성하기 전에 로컬 코드베이스에서 아래 검증을 먼저 수행한다.

#### Gate A — 원격 Winner와 Registration Window UI 동기화

현재 구현은 브라우저가 `/api/round`로 시각을 보정하고 주기적으로 상태를 동기화하며 `/api/open-state`는 UI에서 사용하지 않는다.

먼저 실제 브라우저 또는 재현 가능한 E2E로 아래를 검증한다.

```text
Client A
→ 현재 Round에 Winner 없음

Client B
→ 등록 성공
→ Winner 확정
→ 10초 Registration Window 시작

Client A
→ 다른 사용자의 Winner 발생 인지
→ registrationClosesAt 인지
→ Window 종료 시 등록 버튼 마감 상태 반영
```

현재 구현만으로 제품이 의도한 시점에 상태가 반영되면 코드 변경 없이 유지한다.

문제가 재현될 때만 아래 최소 수정안을 검토한다.

```text
등록 가능 상태를 표시하는 동안만 GET /api/open-state polling
→ winnerExists / registrationClosesAt 수신
→ 이후 브라우저 timer로 마감 시각 계산
→ 마감 후 polling 중단
```

`/api/open-state`는 UI 상태 힌트이며 등록 승인 신호가 아니다.

최종 등록 허용 여부는 계속 `POST /api/attempts`와 PostgreSQL이 판정한다.

#### Gate B — `/api/round` 정각 경계

실제 정각 경계 E2E를 먼저 수행한다.

검증 대상:

```text
정각 직전 /api/round 요청 시작
→ DB 조회 중 정각 경과 가능
→ 응답이 어느 Slot 기준인지 확인
```

정각 경계 오류가 재현되지 않으면 코드를 변경하지 않는다.

오류가 재현될 때만 아래 최소 수정안을 검토한다.

```text
응답 직전 현재 Slot 재계산
→ 요청 시작 시 Slot과 달라졌다면 새 Slot 1회 재조회
→ 새 Slot 기준 응답
```

#### Gate C — 사전 판정과 DB 최종 판정

Node의 Round 사전 판정과 PostgreSQL의 `clock_timestamp()` 최종 판정 사이에는 요청 처리, connection pool 대기, query 실행 시간이 흐를 수 있다.

이 차이는 먼저 검증한다.

```text
API Round 사전 판정
→ request 처리
→ pool 대기 가능
→ PostgreSQL UPSERT
→ clock_timestamp() 최종 판정
```

UPSERT의 DB 최종 판정은 유지한다.

실제 경계 오류가 확인되지 않은 상태에서 시간 판정 구조를 선제 수정하지 않는다.

#### Gate D — Countdown monotonicity

검증:
- 마지막 3초 구간 관찰
- 10초 server time 재동기화와 겹치는 경우 포함
- remainingMs가 증가하는지 기록
- browser timer/rendering pause와 offset 변경을 구분

재현되지 않으면 코드 변경 없음.
재현되면 가장 좁은 수정만 검토.

#### Gate 완료 조건

```text
[ ] npm run build 성공
[ ] npm run e2e 성공
[ ] 원격 Winner / 10초 Window UI 동기화 검증
[ ] /api/round 정각 경계 검증
[ ] 사전 판정 / DB 최종 판정 경계 검증
[ ] 필요한 경우에만 최소 수정
[ ] 수정 발생 시 build / E2E 재통과
```

Gate 결과는 `docs/results/phase4-oci-deployment.md`에 실제 결과만 기록한다.

---

## 1. 외부 전제 조건

Phase 4는 실제 OCI 리소스를 다루므로 아래 조건을 먼저 확인한다.

```text
OCI 계정 존재
OCI home region 확인
home region = Seoul
현재 계정에서 Always Free eligible Compute 사용 가능 여부 확인
현재 계정의 실제 무료 quota 확인
SSH key 준비
OCI 인증 가능
공개 HTTPS에 사용할 domain 준비
DNS 변경 권한 보유
```

### 중요

이 문서에 적힌 과거 무료 사양 숫자만 근거로 리소스를 생성하지 않는다.

리소스 생성 직전에 아래 두 정보를 기준으로 실제 무료 여부를 확인한다.

```text
1. 현재 OCI Console에 표시되는 eligibility / quota
2. 실행 시점의 OCI 공식 Free Tier / Always Free 문서
```

현재 계정에서 무료임이 명확하게 확인되는 범위 안에서만 구성한다.

home region이 Seoul이 아니거나 Seoul에서 현재 Phase의 무료 Compute 조건을 충족할 수 없으면 다른 region 또는 유료 리소스로 임의 변경하지 않고 blocker로 기록한다.

### Compute 구성

A1을 사용할 수 있다면 실제 Console에서 무료로 확인되는 OCPU / memory 범위 안에서 필요한 최소 구성을 선택한다.

고정값을 무료 최대치로 간주하지 않는다.

기존 무료 리소스가 quota를 사용 중이면 잔여 quota를 확인한다.

무료 여부가 불명확하면 생성하지 않는다.

---

## 2. 이번 작업에서 승인된 항목

### 승인

- OCI에서 현재 계정 기준 Always Free eligible로 확인된 Compute 1대 생성
- Seoul home region 내 VCN/subnet/security rule 구성
- 무료 범위의 public IPv4 할당
- SSH 접속
- 프로젝트와 호환되는 안정 Linux image 선택
- 선택한 VM architecture에서 Node.js 24 LTS 설치 가능성 확인
- 선택한 VM architecture에서 PostgreSQL 18.x 설치 가능성 확인
- Node.js 24 LTS 설치
- PostgreSQL 18.x 설치
- HTTPS 종료 방식 결정
- reverse proxy를 선택한 경우 reverse proxy 1개 설치
- 공개 HTTPS 인증서 발급
- systemd service 생성
- application 배포
- 별도 production environment file 생성
- production에서 저장소 `.env` 자동 fallback 차단
- production 최소 구조화 오류 로그 적용
- PostgreSQL local-only 구성
- firewall 설정
- 외부 E2E 수행
- VM reboot 수행 및 recovery 검증
- Phase 4 결과 아티팩트 생성
- README 배포 섹션 갱신
- `docs/results/phase4-oci-deployment.md` 생성
- Phase 4 commit 1회

### 승인하지 않음

- 무료 여부를 확인하지 않은 Compute shape
- 유료 Compute shape
- 유료 Load Balancer
- 유료 managed database
- OCI Autonomous Database
- 여러 VM 생성
- Redis
- Queue
- Kubernetes
- Docker Swarm
- Terraform/Ansible 신규 도입
- CI/CD 신규 도입
- 별도 monitoring SaaS
- domain 구매
- 사용자 동의 없는 paid resource 전환
- Phase 3 baseline 수정
- atomic UPSERT 재설계
- `git push`

---

## 3. 비용 안전 규칙

리소스 생성 전에 해당 shape/resource가 Always Free eligible인지 확인한다.

아래 상황이면 즉시 생성 작업을 중단한다.

```text

예상 비용이 0이 아님

Always Free 표시 없음

A1 무료 quota 초과

추가 block volume이 무료 범위를 넘음

유료 public IP 또는 load balancer 필요

```

무료인지 추측하지 않는다.

실제 billing/eligibility를 확인할 수 없는 환경에서는 인프라 생성 단계를 완료했다고 기록하지 않는다.

---

## 4. Capacity 실패 처리

OCI Always Free는 capacity 부족으로 instance 생성이 실패할 수 있다.

`Out of host capacity` 또는 이에 준하는 오류가 발생하면:

```text

1. 같은 home region 내 허용 가능한 availability domain 재시도

2. 무료 범위를 넘는 shape으로 변경하지 않음

3. 유료 계정 업그레이드를 자동 수행하지 않음

4. 반복 실패 시 blocker 기록

```

무료 capacity 부족을 코드 오류로 기록하지 않는다.

---

## 5. VM 기준 구성

VM image를 먼저 확정하고 Node.js 24 / PostgreSQL 18 설치 가능성을 smoke 확인한 뒤 HTTPS 종료 방식을 결정한다.

기본 배치 원칙:

```text
Internet
   │
   │ HTTPS :443
   ▼
HTTPS termination
   │
   │ 127.0.0.1:<APP_PORT>
   ▼
Node.js 24 / Fastify
   │
   │ localhost:5432
   ▼
PostgreSQL 18
```

HTTPS termination 구현은 Phase 4 시작 시 실제 환경을 보고 결정한다.

reverse proxy를 채택하는 경우:

```text
Internet
→ 80 / 443
→ Reverse Proxy
→ 127.0.0.1:<APP_PORT>
→ Fastify
→ localhost:5432
→ PostgreSQL
```

Fastify의 현재 `127.0.0.1` bind는 운영 구조와 호환되는 한 유지한다.

외부에서 application internal port를 직접 열지 않는다.

외부 공개 포트는 실제 선택한 HTTPS 구성에 필요한 최소 범위로 제한한다.

일반적인 reverse proxy 구성에서는:

```text
22/tcp   SSH
80/tcp   HTTP redirect / ACME가 필요한 경우
443/tcp  HTTPS
```

`5432/tcp`는 OCI Security List/NSG에서 열지 않는다.

---

## 6. SSH 보안

SSH는 key authentication을 사용한다.

가능한 경우:

```text

PasswordAuthentication no

PermitRootLogin no

```

설정 변경 전에 현재 SSH 접속이 유지되는지 확인한다.

접속 가능한 key를 확인하지 않은 상태에서 SSH를 잠그지 않는다.

---

## 7. 애플리케이션 사용자

Node.js 애플리케이션을 root로 실행하지 않는다.

전용 system user를 사용한다.

권장 이름:

```text

hourboard

```

권장 경로:

```text

/opt/hourboard/current

/etc/hourboard/hourboard.env

/var/log/hourboard/   # 별도 파일 로그가 실제로 필요한 경우만

```

systemd journal을 기본 로그로 사용한다.

불필요한 파일 로그 시스템을 추가하지 않는다.

---

## 8. Node.js 24 LTS

VM architecture와 일치하는 Node.js 24 LTS를 설치한다.

설치 후 실제 버전을 기록한다.

```text

node --version

npm --version

```

prerelease 버전은 사용하지 않는다.

Node.js 설치 경로는 systemd에서 안정적으로 접근 가능해야 한다.

shell profile에만 의존하는 nvm path를 systemd ExecStart에 숨겨 사용하지 않는다.

---

## 9. PostgreSQL 18

PostgreSQL 18.x를 설치한다.

설치 후 버전을 기록한다.

```text

psql --version

```

운영 database/user를 로컬 개발 credential과 분리한다.

예상 구조:

```text

database: hourboard

user: hourboard_app

password: 강한 랜덤 비밀번호

```

비밀번호를 repository에 저장하지 않는다.

---

## 10. PostgreSQL localhost 제한

PostgreSQL은 외부 network interface에서 listen하지 않는다.

목표:

```text

listen_addresses = 'localhost'

```

또는 동등하게 loopback만 허용한다.

`pg_hba.conf`는 application user의 local connection만 필요한 범위로 허용한다.

검증:

```text

VM 내부 127.0.0.1:5432 → 연결 가능

VM public IP:5432 → 외부 연결 불가

```

OCI Security List/NSG에서도 5432 inbound rule이 없어야 한다.

두 계층을 모두 확인한다.

---

## 11. Migration

운영 application 시작 전에 기존 migration을 실행한다.

```text
npm run db:migrate
```

Phase 4에서 production-only schema를 별도로 만들지 않는다.

로컬과 운영 schema 계약은 동일해야 한다.

migration 성공 여부를 실제 명령 결과로 확인한다.

새 DB에 migration을 적용한 직후 `hour_slots` metadata를 읽기 전용으로 확인한다.

최소 대조:

```text
column 이름
column type
NOT NULL
PRIMARY KEY
DEFAULT
attempt_count CHECK
winner_message length CHECK
```

migration이 `IF NOT EXISTS`를 사용한다는 이유만으로 schema가 올바르다고 가정하지 않는다.

새 migration framework나 schema 관리 도구는 도입하지 않는다.

---

## 12. Production 환경 변수

운영 환경 변수는 repository의 `.env`로 배포하지 않는다.

권장 파일:

```text
/etc/hourboard/hourboard.env
```

최소 변수:

```text
NODE_ENV=production
PORT=<localhost application port>
DATABASE_URL=<production local PostgreSQL URL>
```

이 파일은 **systemd가 명시적으로 읽는 운영 EnvironmentFile**이다.

저장소 루트의 `.env` 자동 fallback과 구분한다.

production에서는 저장소 `.env` fallback을 사용하지 않도록 한다.

운영 EnvironmentFile 권한을 제한한다.

권장:

```text
owner: hourboard
mode: 600
```

실제 비밀번호를 README, 결과 문서, shell history를 수집한 artifact, terminal capture artifact에 남기지 않는다.

---

## 13. Build 및 배포

배포 소스는 현재 검증된 commit을 사용한다.

배포 전에 local working tree와 commit hash를 기록한다.

VM에서:

```text

npm ci

npm run build

npm run db:migrate

```

`npm install` 대신 lockfile 기반 `npm ci`를 우선한다.

build가 실패하면 service를 교체하지 않는다.

향후 zero-downtime deployment 구조는 현재 Phase 범위가 아니다.

---

## 14. systemd service

HourBoard를 systemd로 실행한다.

서비스 요구사항:

```text
User=hourboard
WorkingDirectory=/opt/hourboard/current
EnvironmentFile=/etc/hourboard/hourboard.env
Restart=on-failure
```

실제 VM의 PostgreSQL unit 이름을 확인한 뒤 필요한 기동 의존 관계를 설정한다.

존재하지 않는 unit 이름을 추측해 하드코딩하지 않는다.

운영 환경 변수는 systemd의 명시적 `EnvironmentFile`로 주입하고 저장소 `.env` 자동 fallback에 의존하지 않는다.

ExecStart는 실제 production build output을 직접 실행한다.

가능하면 npm wrapper보다:

```text
node <built-server-entry>
```

형태를 사용한다.

실제 build output 경로를 확인한 뒤 작성한다.

서비스 생성 후:

```text
systemctl daemon-reload
systemctl enable hourboard
systemctl start hourboard
systemctl status hourboard
```

재시작 검증:

```text
systemctl restart hourboard
systemctl status hourboard
GET /health
```

환경 변수, WorkingDirectory, PostgreSQL 기동 순서가 실제 reboot에서도 유지되는지 Phase 4에서 확인한다.

---

## 15. HTTPS 방식 결정 및 Reverse Proxy

HTTPS 구현체를 문서만 보고 미리 확정하지 않는다.

순서:

```text
1. VM image 확정
2. Node.js 24 / PostgreSQL 18 smoke 확인
3. domain / DNS 제어 확인
4. HTTPS 종료 방식 결정
5. 선택한 방식에 맞춰 firewall / systemd / application bind 구성
```

### Reverse Proxy 선택 시

reverse proxy를 채택한다면 하나만 사용한다.

```text
Internet
→ Reverse Proxy :80/:443
→ 127.0.0.1:<PORT>
→ Fastify
```

Fastify를 인터넷에 직접 노출하지 않는다.

Caddy, Nginx 등 특정 구현체는 Phase 4 실행 환경을 확인한 뒤 하나를 선택한다.

선택 이유와 실제 버전을 결과 문서에 기록한다.

### Domain 전제

공개적으로 신뢰되는 HTTPS 인증서를 발급하려면 사용자가 관리 가능한 domain/subdomain이 VM public IP를 가리켜야 한다.

```text
hourboard.example.com
→ OCI VM public IPv4
```

DNS 전파를 실제 조회로 확인한 뒤 인증서를 발급한다.

### HTTPS

ACME 기반 공개 인증서를 사용한다.

HTTP를 사용하는 구성이 필요하다면 HTTPS redirect를 적용한다.

검증:

```text
http://domain  → HTTPS redirect
https://domain → 200
certificate    → browser/openssl 기준 유효
```

self-signed certificate로 HTTPS 완료 처리하지 않는다.

Domain이 준비되지 않았다면 Phase 4의 HTTPS 완료 조건을 충족하지 못한 것으로 기록한다.

---

## 16. Firewall / OCI Network

OCI network rule과 VM firewall을 함께 확인한다.

허용:

```text

22

80

443

```

금지:

```text

5432

application internal port

```

SSH source IP를 제한할 수 있는 환경이면 사용자의 현재 관리 환경을 차단하지 않는 범위에서 제한한다.

무리하게 제한해 SSH 접근을 잃지 않는다.

---

## 17. 내부 Smoke Test

VM 내부에서 먼저 검증한다.

```text

GET http://127.0.0.1:\<PORT>/

GET http://127.0.0.1:\<PORT>/health

GET http://127.0.0.1:\<PORT>/api/round

```

모두 정상이어야 외부 검증으로 진행한다.

PostgreSQL 연결 실패 상태에서 외부 테스트로 넘어가지 않는다.

---

## 18. 외부 HTTPS Smoke Test

OCI VM 외부 환경에서 domain으로 확인한다.

```text

GET https://\<domain>/

GET https://\<domain>/health

GET https://\<domain>/api/round

```

HTTP status와 응답 내용을 기록한다.

localhost 검증만으로 외부 배포 완료라고 판단하지 않는다.

---

## 19. 외부 사용자 흐름 검증

공개 배포 환경에서 최소 아래를 확인한다.

```text

사이트 접속

→ 현재 전광판 표시

→ countdown 표시

→ 문구 입력

→ 등록

→ WINNER 또는 RANKED 응답

→ 결과 UI 표시

```

### 중요

등록 E2E는 실제 현재 Round 데이터를 변경한다.

공개 서비스 안내 전에 수행한다.

테스트 문구임을 식별 가능한 안전한 plain text를 사용한다.

Phase 4 검증 때문에 사용자 데이터가 있는 운영 Round를 임의 reset하지 않는다.

---

## 20. 외부 동시성 invariant 검증

실제 배포 환경에서 핵심 invariant를 최소 1회 검증한다.

서비스가 아직 공개되지 않은 상태에서 수행한다.

무리한 200 concurrency를 다시 수행할 필요는 없다.

Phase 4 목적은 배포 경로 검증이다.

권장 외부 검증 concurrency:

```text

10

```

검증:

```text

Winner 1명

Position 연속

중복 Position 0

누락 Position 0

Winner 문구 mutation 0

```

공개 사용자 트래픽이 이미 존재하면 결과가 섞이므로 정확한 Position 검증을 수행했다고 기록하지 않는다.

---

## 21. Reboot Recovery

실제 VM reboot를 수행한다.

reboot 전:

```text

systemctl is-enabled hourboard

systemctl status hourboard

```

VM reboot 후 SSH 재접속하여 확인한다.

```text

systemctl status postgresql

systemctl status hourboard

```

외부에서 다시 확인한다.

```text

GET https://\<domain>/health

GET https://\<domain>/

```

재부팅 후 수동 `npm start`가 필요하면 완료 실패다.

---

## 22. 데이터 지속성

reboot 전 현재 `hour_slots` 데이터 상태를 확인한다.

reboot 후 PostgreSQL 데이터가 유지되는지 확인한다.

VM reboot와 application restart 때문에 Winner/Position이 초기화되면 실패다.

VM terminate/recreate까지의 disaster recovery는 현재 Phase 범위가 아니다.

---

## 23. 외부 RTT 및 latency 측정

외부 client 환경에서 실제 배포 domain을 측정한다.

측정 환경을 반드시 기록한다.

```text
측정 위치: 사용자 로컬 네트워크
대상: OCI Seoul
프로토콜: HTTPS
측정 시각: ...
sample 수: ...
```

최소 측정:

```text
GET /api/round total latency
POST /api/attempts total latency
```

가능하면 여러 회 측정해 아래를 기록한다.

```text
p50
p95
p99
```

sample 수가 너무 적으면 percentile을 과장해서 해석하지 않는다.

Phase 3 local baseline은 Phase 4 외부 latency를 예측하는 값이 아니다.

Phase 4 외부 결과에는 DNS, TLS, 인터넷 RTT, reverse proxy 또는 선택한 HTTPS termination 비용이 포함될 수 있다.

Phase 3 local baseline과 Phase 4 external 결과를 동일 조건처럼 비교하지 않는다.

---

## 24. 성능 기록

결과 문서에서 최소 아래를 구분한다.

```text

Phase 3 local baseline

Phase 4 external RTT 포함 latency

```

외부 latency 증가분을 서버 처리 시간이라고 단정하지 않는다.

DNS, TLS, 인터넷 RTT가 포함됨을 명시한다.

---

## 25. 브라우저 검증

Phase 4 완료 판정에는 실제 사용자 화면 접근 확인이 포함된다.

브라우저 실행 capability가 있는 경우 실제 browser로 아래를 확인한다.

```text

HTTPS 정상 표시

현재 전광판

countdown

문구 입력

등록 버튼

WINNER/RANKED 결과

모바일 viewport 핵심 흐름

```

브라우저 capability가 없는 환경에서는 HTTP 검증만으로 시각적 UI를 검증했다고 기록하지 않는다.

이 경우 시각적 브라우저 검증 항목은 미검증으로 남긴다.

사용자가 직접 확인하기 전 Phase 4 전체를 완전 완료로 표시하지 않는다.

---

## 26. 운영 로그 및 오류 진단 검증

현재 코드에서 Fastify logger가 비활성화되어 있거나 내부 오류 원인이 외부 응답에서 숨겨지는 경로가 있다면, Phase 4 배포 전에 **production에서만 최소 구조화 오류 로그**를 검토한다.

목적은 운영 장애 원인 확인이며 요청 전체를 기록하는 것이 아니다.

최소 기록 후보:

```text
timestamp
route
HTTP status
internal error category
request correlation id가 이미 존재하면 해당 값
```

기록 금지:

```text
DATABASE_URL 전체 값
DB password
환경 변수 전체 dump
사용자 문구 전문
SSH key
OCI credential
TLS private key
```

외부 HTTP 응답에 stack trace를 노출하지 않는다.

systemd journal에서 application startup과 요청 처리 중 치명 오류가 없는지 확인한다.

```text
journalctl -u hourboard
```

내부 journal에 운영 진단용 stack trace가 남는 것은 허용할 수 있지만 비밀값 또는 사용자 입력 전문이 포함되지 않는지 확인한다.

새로운 외부 logging SaaS는 도입하지 않는다.

---

## 27. 운영 아티팩트

민감 정보를 제거한 Phase 4 artifact를 생성한다.

권장:

```text

docs/results/artifacts/phase4/

├─ deployment-summary.json

├─ external-smoke.json

├─ reboot-recovery.json

├─ network-check.json

└─ latency-summary.json

```

절대 포함하지 않음:

```text

SSH private key

DB password

full DATABASE_URL

OCI secret/auth token

TLS private key

```

---

## 28. deployment-summary.json

최소 구조:

```json
{
  "region": "ap-seoul-1",
  "shape": "...",
  "ocpus": null,
  "memoryGb": null,
  "alwaysFreeEligible": true,
  "linuxImage": "...",
  "httpsTermination": "...",
  "nodeVersion": "...",
  "postgresVersion": "...",
  "https": true,
  "postgresPubliclyReachable": false,
  "applicationPortPubliclyReachable": false,
  "systemdEnabled": true,
  "rebootRecovery": true,
  "deployedCommit": "..."
}
```

OCPU, memory, shape은 실제 OCI Console에서 무료로 확인한 값을 기록한다.

문서의 과거 예시 숫자를 실제 배포값으로 복사하지 않는다.

실제로 확인한 값만 기록한다.

---

## 29. 결과 문서

`docs/results/phase4-oci-deployment.md`를 생성한다.

최소 포함:

```text
배포 commit

Local Pre-Deployment Gate
- #13 원격 Winner / 10초 Window UI 동기화 결과
- #19 /api/round 정각 경계 결과
- #20 사전 판정 / DB 최종 판정 경계 결과
- 실제 수정 여부

OCI account / home region 확인 결과
실제 Free eligibility / quota 확인 방법
생성한 무료 리소스
VM shape / OCPU / memory
OS / Linux image
Node.js version
PostgreSQL version

migration 결과
hour_slots schema metadata 대조 결과

network 구성
PostgreSQL localhost 검증
application internal port 외부 차단
systemd 구성
운영 EnvironmentFile 구성
production .env fallback 처리
HTTPS 종료 방식 / 구현체
운영 로그 구성

외부 smoke test
외부 사용자 흐름 검증
외부 concurrency invariant
reboot recovery
외부 RTT / latency
Phase 3 baseline과 차이
browser 검증 결과

artifact 경로
미검증 항목
운영 제한사항
```

IP, domain은 공개 가능한 경우만 문서화한다.

credential은 기록하지 않는다.

검증되지 않은 항목을 성공으로 표현하지 않는다.

---

## 30. OCI Always Free 운영 위험 기록

결과 문서에 Always Free 운영 제한을 숨기지 않는다.

최소 기록:

```text

Always Free capacity 부족 가능

Always Free inactive Compute reclaim 가능성

home region 제약

무료 quota 범위

```

Always Free VM은 조건에 따라 Oracle이 idle instance로 판단해 회수할 수 있으므로 운영 안정성을 유료 SLA처럼 표현하지 않는다.

---

## 31. README 갱신

Phase 4가 실제 완료된 경우에만 README 상태를 갱신한다.

```text
Phase 1 — Concurrency Core: 완료
Phase 2 — Ticketing UI: 완료
Phase 3 — Load, Race & Open-State Verification: 완료
Phase 4 — OCI Deployment: 완료
```

README에 실제 production credential이나 server secret을 넣지 않는다.

배포 URL은 사용자가 공개를 원하는 경우에만 넣는다.

운영 실행 방법은 실제 배포 방법과 일치해야 한다.

Phase 4가 blocker로 부분 완료된 경우 README에 완료라고 쓰지 않는다.

---

## 32. 완료 기준

아래를 모두 확인한다.

```text
[ ] docs/codebase-assumptions-review.md 확인

[ ] Local Gate #13 UI 동기화 검증
[ ] Local Gate #19 /api/round 정각 경계 검증
[ ] Local Gate #20 사전/최종 판정 경계 검증
[ ] 필요한 경우 최소 수정 후 build / E2E 통과

[ ] OCI home region = Seoul 확인
[ ] 현재 계정의 Free eligibility / quota 확인
[ ] 유료 resource 생성 없음
[ ] OCI Compute 생성
[ ] VM SSH 접속

[ ] Linux image 기록
[ ] Node.js 24 LTS 설치 및 버전 확인
[ ] PostgreSQL 18.x 설치 및 버전 확인
[ ] production DB/user 생성

[ ] migration 성공
[ ] hour_slots schema metadata 대조
[ ] application build 성공

[ ] production EnvironmentFile 생성
[ ] 저장소 .env 자동 fallback에 의존하지 않음
[ ] systemd service 실행
[ ] systemd enable 완료
[ ] PostgreSQL 기동 의존 관계 확인
[ ] systemd restart smoke test

[ ] HTTPS 종료 방식 확정
[ ] Fastify external direct port 비공개
[ ] PostgreSQL localhost-only
[ ] OCI inbound 5432 없음
[ ] 외부 5432 접근 실패 확인
[ ] application internal port 외부 접근 실패 확인

[ ] domain DNS 정상
[ ] HTTPS 인증서 정상
[ ] HTTP → HTTPS redirect 또는 선택한 HTTPS 정책 정상

[ ] 외부 GET / 200
[ ] 외부 GET /health 정상
[ ] 외부 GET /api/round 정상
[ ] 외부 등록 흐름 정상
[ ] 배포 환경 concurrency invariant 확인
[ ] 10초 Registration Window 외부 검증

[ ] production 최소 오류 로그 검증
[ ] secret / 사용자 문구 전문 로그 미노출

[ ] VM reboot 수행
[ ] reboot 후 PostgreSQL 자동 복구
[ ] reboot 후 HourBoard 자동 복구
[ ] reboot 후 HTTPS 접근 정상
[ ] reboot 전후 DB 데이터 지속

[ ] 외부 RTT 기록
[ ] 등록 latency p50 / p95 / p99 또는 실제 가능한 통계 기록
[ ] sample 수 기록
[ ] 실제 브라우저 핵심 흐름 확인

[ ] Phase 4 artifact 생성
[ ] docs/results/phase4-oci-deployment.md 생성
[ ] README 실제 상태 갱신
```

브라우저 검증 capability가 없는 환경에서는 시각적 UI 항목을 미검증으로 남긴다.

domain, OCI 인증, Free eligibility 등 필수 전제가 충족되지 않으면 거짓 완료 처리하지 않는다.

---

## 33. 실패 / blocker 처리

아래 상황에서 거짓 완료 처리하지 않는다.

```text
Local Gate에서 핵심 UI/정각 경계 오류가 재현됐지만 수정·재검증하지 못함
OCI home region이 Seoul이 아님
현재 계정의 Free eligibility 확인 불가
무료 capacity 없음
OCI 인증 정보 없음
SSH 접속 불가
선택한 Linux image에서 Node.js 24 또는 PostgreSQL 18 설치 불가
Domain 없음
DNS 변경 불가
HTTPS 인증서 발급 실패
PostgreSQL 18 설치 실패
외부 5432 차단 확인 실패
application internal port 외부 차단 확인 실패
systemd reboot recovery 실패
브라우저 검증 요구사항 미충족
```

가능한 범위까지 작업하고 정확한 blocker와 이어서 할 작업을 기록한다.

유료 resource, 다른 region, managed database 등으로 자동 우회하지 않는다.

---

## 34. Git 처리

작업 시작 전:

```text

git status

```

Phase 4 완료 후 commit:

```text

feat: phase4-oci-deployment

```

운영 credential, private key, secret env file을 commit하지 않는다.

`git push`는 수행하지 않는다.

---

## 35. 범위 외

이번 Phase에서는 아래를 구현하지 않는다.

```text

멀티 VM

Load Balancer

Auto Scaling

Redis

Queue

Managed PostgreSQL

Terraform

Ansible

CI/CD

Blue/Green deployment

Zero-downtime deployment

자동 DB backup 정책

모니터링 SaaS

Pager/alerting

로그 수집 SaaS

```

운영상 필요하더라도 이후 Phase로 분리한다.

---

## 36. 최종 보고

작업 종료 시 아래 형식으로 보고한다.

```text
## 작업 상태
- Phase 4 완료 / 부분 완료 / blocker

## Local Pre-Deployment Gate
- #13 UI 동기화 검증
- #19 /api/round 정각 경계
- #20 사전/최종 판정 경계
- 코드 수정 여부

## OCI
- home region
- region
- shape
- OCPU / memory
- Free eligibility 확인 방식

## Runtime
- OS / Linux image
- architecture
- Node.js
- PostgreSQL

## Network
- HTTPS termination
- reverse proxy 사용 여부 / 구현체
- open ports
- application internal port external access
- PostgreSQL external access

## Deployment
- deployed commit
- migration
- schema metadata
- EnvironmentFile
- production .env fallback 처리
- systemd
- structured error logging

## External E2E
- /
- /health
- /api/round
- registration
- 10초 Registration Window
- concurrency invariant
- browser 확인

## Reboot
- PostgreSQL recovery
- application recovery
- HTTPS recovery
- DB data persistence

## Performance
- 측정 위치
- sample 수
- GET /api/round latency
- registration p50 / p95 / p99
- Phase 3 local baseline과의 환경 차이

## Artifact
- 실제 경로

## 제한사항
- 확인된 사실
- 미검증 항목
- blocker

## Git
- commit hash
- working tree
- push 수행 여부: 수행하지 않음
```

실제로 수행하지 않은 배포, 브라우저 확인, latency 측정을 완료했다고 표현하지 않는다.

---

# 최종 명령

추가 계획 확인 없이 Phase 4 범위 안에서 작업을 시작한다.

먼저 `docs/codebase-assumptions-review.md`를 읽고 Local Pre-Deployment Gate를 수행한다.

**#13 원격 Winner / 10초 Window UI 동기화, #19 `/api/round` 정각 경계, #20 Node 사전 판정과 PostgreSQL 최종 판정 경계를 먼저 검증한다. 실제 문제가 재현되지 않으면 코드를 바꾸지 말고, 재현된 경우에만 가장 좁은 수정안을 적용한 뒤 build와 E2E를 다시 통과시킨다.**

그 다음 OCI 계정의 home region, 현재 계정에서 실제로 확인되는 Free eligibility / quota, SSH, domain/DNS 조건을 확인한다. 문서에 적힌 과거 무료 사양 숫자만 근거로 리소스를 생성하지 않는다.

무료 조건이 확인되는 경우에만 Seoul Compute 1대를 생성한다.

VM image를 확정한 뒤 해당 architecture에서 Node.js 24 LTS와 PostgreSQL 18 설치·빌드·migration을 smoke 확인하고 HTTPS 종료 방식을 결정한다. reverse proxy를 채택하는 경우 Fastify는 loopback bind를 유지하고 proxy만 외부에 노출한다.

운영 환경 변수는 systemd가 명시적으로 읽는 별도 `EnvironmentFile`로 주입하고 저장소 `.env` 자동 fallback에 의존하지 않는다.

PostgreSQL은 localhost로 제한하고, migration 직후 `hour_slots` schema metadata를 대조한다. production에서만 최소 구조화 오류 로그를 적용하되 credential, 환경 변수 전체, 사용자 문구 전문을 기록하지 않는다.

외부 HTTPS E2E, 10초 Registration Window, 핵심 동시성 invariant, application/DB 포트 차단, VM reboot recovery, 데이터 지속성, 실제 브라우저 흐름, 외부 RTT와 등록 latency를 검증한다.

실제 측정값과 확인된 사실만 artifact와 결과 문서에 기록하고 Phase 4 commit을 생성한다.

무료 조건, domain, OCI 인증, browser capability 등 필수 전제가 충족되지 않으면 거짓 완료 처리하지 말고 정확한 blocker와 이어서 할 작업을 기록한다.

`git push`는 수행하지 않는다.
