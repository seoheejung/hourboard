# HourBoard Phase 4B — 자체 호스팅 미니PC 배포 지침

**상태: Phase 4B 기본 배포 경로 / 미니PC·WAN 사전 확인 완료, TCP 443 실제 외부 도달 미검증.**

이 문서는 [Phase 4 계획](../../.project/plan.md#phase-4--production-deployment)의 미니PC 경로에만 적용한다. OCI A1 시도와 capacity 실패의 사실 기록은 [OCI 진행 기록](../progress/phase4-oci-deployment.md)에 보존한다. Phase 4 완료 결과는 실제 배포와 검증 후 `docs/results/`에 작성한다.

최종 운영 주소는 `hourboard.duckdns.org`이며 **DuckDNS + Traefik + Let's Encrypt DNS-01 + 미니PC 직접 TCP 443 인바운드** 구조를 사용한다.

물리 서버는 EcoBe-A1 Mini PC(Intel N100 4C/4T, RAM 16GB)이며 Windows 11, WSL2 Ubuntu, Docker Desktop을 사용한다. 기존 Nginx와 자체 서명 인증서 기반 내부망 HTTPS 구성은 운영 경로에 포함하지 않는다.

현재 미니PC에는 실행 중인 Docker 컨테이너가 없고 Windows의 TCP 80/443/3000/5432 listener도 없다. 기존 Nginx·Fastify·PostgreSQL의 설치 위치 자체는 별도 확인하지 않았으며 현재 포트 충돌은 확인되지 않았다.

CPU TDP 6W를 장비 전체 실측 소비전력으로 사용하지 않는다.

---

## 1. 운영 구성 전 확인 결과

### 1.1 작업 PC에서 확인한 네트워크

- 공유기 WAN IPv4와 외부에서 관측되는 IPv4가 동일함을 확인했다.
- `hourboard.duckdns.org`의 A 레코드가 현재 외부 관측 IPv4와 동일함을 확인했다.
- 공유기 WAN 주소에서 RFC1918 사설 주소 또는 `100.64.0.0/10` 공유 주소 대역이 확인되지 않았다.
- 현재 확인 범위에서는 CGNAT 징후가 없다.
- 공유기 관리 화면 접근과 포트포워딩 설정 경로를 확인했다.
- 실제 공인 IPv4 값은 저장소 문서에 기록하지 않는다.

### 1.2 미니PC에서 확인한 환경

| 항목 | 확인 결과 |
| --- | --- |
| Host OS | Windows 11 |
| Linux Environment | WSL2 `Ubuntu-22.04` |
| WSL Version | 2 |
| Container Runtime | Docker Desktop |
| Docker Desktop | 4.74.0 |
| Docker Engine | 29.4.3 |
| Docker Engine OS | Linux |
| Architecture | x86_64 |
| C: 전체 공간 | 237.4 GB |
| C: 여유 공간 | 194 GB |
| 실행 중 Docker 컨테이너 | 0 |
| TCP 80 listener | 없음 |
| TCP 443 listener | 없음 |
| TCP 3000 listener | 없음 |
| TCP 5432 listener | 없음 |
| DuckDNS A 레코드 | 현재 집 공인 IPv4로 정상 해석 |
| 외부 관측 IPv4 | 작업 PC와 동일 |

미니PC는 현재 Wi-Fi로 공유기에 연결되어 있다. 실제 LAN IPv4와 Gateway 값은 운영 설정에 필요할 때 로컬에서 확인하되 저장소 문서에는 기록하지 않는다.

### 1.3 아직 미검증인 항목

- 공유기 TCP 443 포트포워딩 후 실제 외부망에서 미니PC Traefik까지 도달하는지 여부
- Windows 방화벽에서 TCP 443 inbound 허용 결과
- Traefik DNS-01 인증서 발급 및 자동 갱신
- 최종 운영 Compose의 PostgreSQL 영속성
- Windows 재부팅 후 미로그인 상태의 Docker Desktop 및 컨테이너 자동 복구
- 실제 외부 브라우저, E2E, latency

기존 Docker 기반 443 서비스가 없으므로 사전 reboot 실험은 수행하지 않는다. 자동 복구는 최종 운영 Compose 구성 후 production reboot에서 검증한다.

---

## 2. 작업 PC와 미니PC 역할

### 작업 PC

저장소와 코드 작업 전용으로 사용한다.

- HourBoard 코드 수정
- `compose.prod.yaml` 작성
- Traefik 설정
- Fastify production bind 수정
- 운영 문서 수정
- E2E 및 k6 실행 코드 관리
- Git diff 검토
- commit

### 미니PC

실제 배포와 운영 검증 전용으로 사용한다.

- Windows 11
- Docker Desktop
- Traefik
- Fastify
- PostgreSQL
- DuckDNS updater
- TCP 443 공개
- 외부 HTTPS
- reboot recovery 검증
- 실제 외부 E2E 및 latency 측정

---

## 3. 운영 구성

### 3.1 Docker 서비스

운영 Compose는 개발용 `compose.yaml`과 분리한다.

```text
compose.yaml
→ 로컬 개발용 PostgreSQL

compose.prod.yaml
→ 미니PC 운영용 Traefik + Fastify + PostgreSQL + migration + DuckDNS updater
```

기존 `compose.yaml`은 개발용 PostgreSQL과 개발 암호를 정의하므로 운영 배포 설정으로 그대로 사용하지 않는다.

운영 서비스:

```text
Docker Desktop
├─ traefik
├─ app
├─ migrate (배포 시 1회 실행)
├─ db
└─ duckdns-updater
```

현재 DuckDNS 자동 갱신 주체가 없음을 사용자에게 확인했다. `compose.prod.yaml`의 `duckdns-updater`를 기본 실행 서비스로 사용한다. 나중에 공유기 등 다른 갱신 주체를 구성하면 중복 실행을 해소한다. updater는 별도 `ddns` network만 사용하고 앱·DB network에는 연결하지 않는다.

### 3.2 Docker network

Traefik과 PostgreSQL 사이의 불필요한 직접 연결을 만들지 않는다.

```text
Internet
   ↓
TCP 443
   ↓
Traefik
   │
   │ edge network
   ↓
Fastify
   │
   │ data network
   ↓
PostgreSQL
```

기준:

```yaml
services:
  traefik:
    networks:
      - edge

  app:
    networks:
      - edge
      - data

  db:
    networks:
      - data

networks:
  edge:
  data:
```

- Traefik과 Fastify는 `edge` network 공유
- Fastify와 PostgreSQL은 `data` network 공유
- PostgreSQL은 `edge` network에 연결하지 않음
- Fastify가 두 network에 속하므로 Traefik이 사용할 network를 명시
- Traefik Docker provider는 `exposedByDefault=false`
- HourBoard app만 `traefik.enable=true`

### 3.3 포트 공개

운영 Compose에서 host에 publish하는 포트:

```text
443 → Traefik
```

host에 publish하지 않는 포트:

```text
3000 → Fastify
5432 → PostgreSQL
Traefik dashboard / 관리 포트
```

TCP 80은 Phase 4B 기본 경로에서 열지 않는다. Let's Encrypt 인증은 DNS-01을 사용하므로 인증서 발급에 HTTP-01용 80 포트가 필요하지 않다.

평문 `http://` 요청의 HTTPS redirect는 Phase 4B 기본 범위에 포함하지 않는다.

### 3.4 Fastify bind

개발 환경:

```text
127.0.0.1
```

운영 Docker 컨테이너:

```text
0.0.0.0:3000
```

컨테이너 내부 `0.0.0.0` bind와 host port 공개는 별개다. 운영 Compose에서 Fastify의 `3000` 포트를 host에 publish하지 않는다.

### 3.5 PostgreSQL

- PostgreSQL 18.x 사용
- Fastify와 같은 미니PC에서 실행
- `data` Docker network 내부에서만 접근
- host `5432` publish 금지
- named volume 또는 명시적인 영속 경로 사용
- DB connection pool 재사용
- atomic UPSERT 유지
- 등록 hot path의 단일 DB query 유지

---

## 4. DuckDNS와 HTTPS

### 4.1 운영 주소

```text
https://hourboard.duckdns.org
```

DuckDNS는 현재 집 공인 IPv4를 정상적으로 가리키고 있다.

실제 공인 IPv4는 저장소에 기록하지 않는다.

### 4.2 DuckDNS updater

집 공인 IPv4가 변경될 수 있으므로 DuckDNS A 레코드를 주기적으로 갱신한다.

- 운영 Compose의 `duckdns-updater`가 기본 갱신 주체
- 중복 updater 구성 금지
- 갱신 성공 응답 확인
- `Resolve-DnsName` 또는 `nslookup`으로 공용 DNS 결과 확인
- DuckDNS API 요청 URL에 포함되는 token이 CLI 인수, 로그, 저장소에 남지 않도록 관리

### 4.3 Traefik + Let's Encrypt DNS-01

Traefik은 DuckDNS provider를 이용한 Let's Encrypt DNS-01로 `hourboard.duckdns.org` 인증서를 발급·갱신한다.

- DNS-01 사용
- TCP 80 불필요
- DuckDNS 토큰 비밀 파일을 `DUCKDNS_TOKEN_FILE`로 Traefik에 주입
- ACME 저장소 영속화
- Traefik image는 확인한 stable tag로 고정
- `latest` 사용 금지
- 실제 외부 브라우저에서 신뢰되는 인증서 확인

---

## 5. 운영 비밀값

운영 비밀값은 저장소와 분리한다.

운영 비밀값은 미니PC의 저장소 밖 파일 두 개에 둔다. Docker Compose secret으로 컨테이너에 읽기 전용 주입한다.

```text
db_password     → PostgreSQL과 Fastify 공유
duckdns_token   → Traefik과 DuckDNS updater 공유
```

`deploy/production.env.example`은 Git에 올리는 빈 예시이며 실제 `production.env`는 작업 PC에 생성하지 않는다. 미니PC에서 예시를 참고해 저장소 밖 `C:/ProgramData/HourBoard/production.env`를 만들고 실제 연락 이메일 `ACME_EMAIL`과 비밀 파일의 공통 디렉터리 `HOURBOARD_SECRET_DIR`을 지정한다. 예시의 빈 값은 Compose 검사를 통과하지 못한다. 저장소 안에 실수로 `production.env`를 만들더라도 `.gitignore`에서 제외한다. `HOURBOARD_SECRET_DIR` 아래의 `db_password`, `duckdns_token` 파일에는 각각 비밀번호와 토큰 값만 UTF-8 BOM·줄바꿈 없이 저장한다. 비밀값을 CLI 인수나 Compose 환경 변수 값으로 직접 전달하지 않는다. Fastify는 DB 암호 파일과 비밀값이 아닌 DB host/user/name으로 URL을 만들며 production에서 저장소 `.env` fallback을 사용하지 않는다. 로컬 개발용 `.env`에는 DuckDNS 토큰을 추가하지 않는다.

금지:

- 저장소 `.env`에 운영 비밀값 저장
- `compose.prod.yaml`에 실제 비밀번호 작성
- README에 credential 기록
- 결과 JSON에 token 기록
- 로그에 connection string 기록
- 채팅·스크린샷에 token 노출
- 실제 공인 IPv4를 저장소 문서에 고정 기록
- 공유기 관리자 ID/비밀번호 기록
- Windows 사용자명·개인 경로를 저장소 문서에 기록

production은 저장소 `.env` fallback에 의존하지 않는다.

---

## 6. 공유기와 Windows 방화벽

운영 Compose와 Traefik 준비가 끝난 뒤 공유기에서 설정한다.

```text
외부 TCP 443
→ 미니PC LAN IPv4:443
```

미니PC LAN IPv4는 DHCP 예약으로 고정한다.

외부에 열지 않는 포트:

```text
80
3000
5432
Traefik dashboard / 관리 포트
```

Windows 방화벽에서도 TCP 443만 필요한 범위로 허용한다.

공유기 설정만으로 성공 처리하지 않는다. 휴대폰 Wi-Fi를 끈 LTE/5G 등 외부망에서 실제 도달성을 검증한다.

---

## 7. 배포 순서

### 작업 PC

1. `compose.prod.yaml` 작성
2. Traefik Docker provider 및 router 설정
3. `edge` / `data` network 분리
4. Fastify production bind 수정
5. PostgreSQL named volume 구성
6. 운영 secret 주입 경로 구성
7. stable image version 확인 및 고정
8. build 및 기존 E2E 실행
9. `git diff --check`
10. 배포 파일 준비

### 미니PC

1. 저장소 또는 배포 아티팩트를 미니PC에 배치한다.
2. 저장소 밖에 운영 설정 파일과 비밀 디렉터리를 만든다. `production.env`에는 실제 `ACME_EMAIL`과 `HOURBOARD_SECRET_DIR`만 설정하고, 그 디렉터리에 `db_password`, `duckdns_token` 파일을 둔다. 토큰·암호의 실제 값은 저장소, 채팅, 명령 인수에 쓰지 않는다.
3. 배포 디렉터리의 PowerShell에서 다음 명령을 순서대로 실행한다. 실제 운영 설정 파일 경로를 사용한다.

   ```powershell
   docker compose --env-file C:/ProgramData/HourBoard/production.env -f compose.prod.yaml config --quiet
   docker compose --env-file C:/ProgramData/HourBoard/production.env -f compose.prod.yaml build app
   docker compose --env-file C:/ProgramData/HourBoard/production.env -f compose.prod.yaml up -d
   docker compose --env-file C:/ProgramData/HourBoard/production.env -f compose.prod.yaml ps -a
   ```

4. `db`는 healthy, `migrate`는 exit 0, `app`·`traefik`·`duckdns-updater`는 running인지 확인한다. Migration 실패 시 앱을 공개하지 말고 원인을 해결한다.
5. `hour_slots` schema metadata와 Docker 내부 app ↔ db 연결을 확인한다. DB 암호 또는 URL을 로그·결과 문서에 기록하지 않는다.
6. DuckDNS 갱신 성공 로그와 DNS A 레코드 일치를 확인한다. DNS-01 인증서는 실제 도메인 HTTPS 요청 후 발급될 수 있으므로 발급 상태를 별도로 확인한다.
7. 다른 LAN 기기에서 `curl.exe --resolve hourboard.duckdns.org:443:<미니PC-LAN-IP> https://hourboard.duckdns.org/api/round`로 Traefik ↔ app 경로와 인증서를 확인한 뒤 공유기 TCP 443을 연결한다. `<미니PC-LAN-IP>`는 실제 주소로 바꾸되 결과 문서에는 기록하지 않는다.

### 공유기

1. 미니PC LAN IPv4 DHCP 예약
2. TCP 443 포트포워딩
3. 다른 불필요한 공개 포트가 없는지 확인

### 외부망

1. `https://hourboard.duckdns.org`
2. `GET /api/round`
3. 실제 브라우저 UI
4. 등록 흐름
5. Winner / Ranked
6. 10초 Registration Window
7. 정각 경계
8. 병렬 등록 E2E
9. latency
10. 보안 포트 확인

---

## 8. Production reboot 검증

최종 운영 Compose 구성 후 Windows를 재부팅한다.

검증 조건:

1. 미니PC에 로그인하지 않은 상태 유지
2. 다른 기기에서 `https://hourboard.duckdns.org` 접속
3. Docker Desktop 기동 상태 확인
4. PostgreSQL 기동 상태 확인
5. Fastify 기동 상태 확인
6. Traefik 기동 상태 확인
7. DuckDNS updater 상태 확인
8. reboot 전후 DB 데이터 유지 확인

수동 로그인이나 조작이 필요하면 자동 복구 **실패**로 기록한다.

자동 복구 실패는 성공으로 바꾸지 않는다. 실패 시점, 로그인 전 서비스 상태, 수동 복구 방법, 복구 후 HTTPS 재접속 결과와 운영 제약을 결과 문서에 기록한다.

자동 복구 성공 자체는 Phase 4B 완료의 필수 조건으로 취급하지 않는다. 다만 production reboot 실험 자체는 필수 검증 대상이다.

---

## 9. 외부 E2E 및 측정

실제 외부 배포 환경에서 실제 PostgreSQL을 연결한 상태로 검증한다.

필수 invariant:

```text
winner count = 1
positions = 1..N
duplicate position = 0
missing position = 0
winner message mutation = 0
```

필수 검증:

- 첫 등록 후 10초 Registration Window
- 정각 경계
- 유효·무효 입력 대표 경계
- 실제 브라우저 핵심 사용자 흐름
- PostgreSQL 5432 외부 접근 불가
- Fastify 3000 외부 접근 불가
- Traefik dashboard 외부 접근 불가
- 외부 RTT
- GET `/api/round`
- POST `/api/attempts`
- sample 수
- p50
- p95
- p99

Phase 3 로컬 baseline과 Phase 4B 외부 결과를 같은 환경의 수치처럼 혼합하지 않는다.

배포 경로는 다음으로 기록한다.

```text
DuckDNS
→ TCP 443 direct inbound
→ Traefik
→ Fastify
→ PostgreSQL
```

---

## 10. Repository 기록

이 문서는 프로젝트 저장소에 포함될 수 있으므로 운영에 필요한 민감값을 기록하지 않는다.

운영 설정과 검증 결과를 저장소에 기록할 때 민감정보 처리 기준은
`AGENTS.md`의 `환경 변수 및 민감정보` 규칙을 따른다.

실제 주소가 필요한 절차에서는 `<MINIPC_LAN_IP>`, `<PUBLIC_IP>` 같은
placeholder를 사용한다.

---

## 11. Phase 4B 완료 기준

다음 항목 중 하나라도 **미검증**이면 Phase 4 완료로 기록하거나 completion commit을 만들지 않는다.

- 실제 외부 HTTPS
- 신뢰되는 인증서
- DuckDNS A 레코드 갱신
- TCP 443 실제 외부 도달
- Fastify / PostgreSQL 내부 포트 비공개
- production reboot 실험
- reboot 전후 DB 데이터 보존
- 실제 브라우저 확인
- Winner / Position invariant
- 10초 Registration Window
- 외부 E2E
- latency 측정
- Phase 4 artifact
- 실제 배포 결과 문서

검증된 자동 복구 실패는 Phase 4B 전체 실패로 숨기지 않는다. 운영 제약과 수동 복구 결과를 명시한 상태로 완료 여부를 판단한다.
