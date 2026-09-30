# Phase 4B 자체 호스팅 배포 진행 기록

**상태: 인프라 배포·외부 HTTPS·Windows reboot 검증 완료 / 외부 E2E·latency 검증 전**

**기준일: 2026-10-01**

이 문서는 미니PC에서 사용자가 수행해 전달한 운영 확인과 작업 PC의 저장소 작업을 구분해 기록한다. 실제 공인·LAN IPv4, MAC address, Windows 사용자명·개인 경로, 운영 credential, DuckDNS token, DB password는 기록하지 않는다. Phase 4B 완료 결과는 외부 E2E와 latency 검증 후 `docs/results/`에 작성한다.

## 장비와 역할

| 역할 | 확인된 환경 |
| --- | --- |
| 작업 PC | 코드·문서·Compose 작성, 정적 검증, Git 관리 |
| 운영 미니PC | EcoBe-A1, Intel N100 4C/4T, RAM 16 GB, Windows 11 |
| Linux·컨테이너 | WSL2 Ubuntu-22.04, Docker Desktop 4.74.0, Linux Engine 29.4.3, x86_64 |
| 공개 주소 | `hourboard.duckdns.org` |

초기 점검에서 미니PC C:는 237.4 GB 중 194 GB가 비어 있었다. 당시 Docker 실행 컨테이너와 Windows 80/443/3000/5432 listener는 없었다. 이 수치는 배포 전 스냅샷이며 현재 디스크 사용량을 뜻하지 않는다. 미니PC의 LAN 주소는 공유기 DHCP 예약을 적용했다.

## 배포 구성과 기동 결과

운영 요청 경로는 DuckDNS → 공유기 TCP 443 → Docker Desktop Traefik → Fastify → PostgreSQL이다. 과거 Nginx와 자체 서명 내부망 HTTPS는 이 경로에 포함하지 않는다. Traefik·Fastify는 `edge`, Fastify·PostgreSQL은 `data` Docker network를 공유한다. 운영 값 `ACME_EMAIL`, `POSTGRES_PASSWORD`, `DUCKDNS_TOKEN`은 Git에서 제외된 `deploy/production.env`로 주입한다.

Windows SSH 세션의 Docker CLI에서 공개 이미지 pull 시 credential helper가 로그온 세션 오류를 반환했다. 사용자는 WSL Docker CLI 설정을 백업한 뒤 `credsStore: desktop.exe`를 제거했고, 같은 Docker Desktop Linux Engine에 연결된 WSL CLI로 공개 이미지 pull과 운영 이미지 build를 완료했다. Windows Docker CLI 설정은 진단 후 원래 상태로 복원했다. 이 경로는 Docker Engine을 교체한 결과가 아니다.

사용자 제공 Compose 기동 결과:

| Service | 상태 | Host publish |
| --- | --- | --- |
| Traefik | Up | TCP 443 |
| Fastify app | Up | 없음 |
| PostgreSQL | Up / healthy | 없음 |
| migration | Exited (0), 일회성 실행 정상 완료 | 없음 |
| DuckDNS updater | Up | 없음 |

DuckDNS updater의 IPv4 갱신 성공 응답을 사용자가 확인했다. Windows host에는 운영 중 443 listener만 관측됐으며 80, 3000, 5432는 publish하지 않았다. PostgreSQL은 영속 volume을 사용한다.

## 네트워크와 HTTPS 확인

- 공유기 WAN IPv4, 외부 관측 IPv4, DuckDNS A 레코드가 일치했고 CGNAT 징후가 없었다.
- 미니PC 내부 Fastify `/health`가 200을 반환했다.
- 다른 LAN 기기에서 미니PC TCP 443 연결에 성공했다.
- 다른 LAN 기기에서 Host/SNI를 유지한 HTTPS `/health`와 `/api/round`가 모두 200을 반환했다. 두 API 모두 실제 PostgreSQL query를 수행한다.
- 인증서 검증을 끄지 않은 LAN 클라이언트와 외부 브라우저에서 HTTPS 연결에 성공했다. 인증서 발급자·유효기간의 별도 기록은 아직 없다.
- 공유기는 미니PC에 TCP 443만 포트포워딩한다. DMZ와 80/3000/5432 포트포워딩은 사용하지 않는다.
- 휴대폰 Wi-Fi를 끈 LTE/5G에서 운영 주소의 HTTPS 화면과 `/health` 접속을 사용자가 확인했다.

외부 접속 확인은 실제 외부망에서 수행됐다. LAN의 `curl --resolve` 확인을 외부 도달 결과로 대신하지 않았다.

## Windows reboot와 데이터 보존

사용자가 Windows host를 재부팅한 뒤 `app`, `db`, `duckdns-updater`, `traefik`이 다시 Up이고 `db`가 healthy인 것을 확인했다. 장기 실행 서비스는 `restart: unless-stopped`이며, migration은 `Exited (0)` 상태였다. Traefik은 재부팅 직후 Docker provider 연결에서 `unexpected EOF`와 Docker daemon 연결 오류를 일시적으로 기록했으나, 별도 컨테이너 재기동 없이 retry 후 정상 연결·TCP 443 publish 상태로 복구됐다. 오류 원인은 Docker daemon 준비 순서와 관련됐을 가능성이 있으나 독립적으로 확정하지 않았다.

재부팅 뒤 외부 HTTPS UI와 `GET /api/round` 200 응답을 사용자가 확인했다. 이전 Winner 문구와 `attemptCount`가 유지돼 host reboot에 대한 PostgreSQL 데이터 보존을 확인했다. 이는 PostgreSQL 컨테이너·volume을 의도적으로 삭제하거나 재생성한 검증은 아니다. Windows SSH 세션이 존재했으므로 GUI 로그인도 없는 완전 무인 부팅 여부는 별도 판정으로 남긴다.

## 남은 검증

- 외부망 실제 브라우저의 등록·Winner·순위·10초 Window 흐름
- 외부 병렬 등록 E2E: winner count 1, positions 1..N, duplicate 0, missing 0, winner message mutation 0
- 정각 경계와 유효·무효 입력 대표 경계
- 외부 GET `/api/round` 및 POST `/api/attempts` sample 수·p50·p95·p99, 외부 RTT
- 최종 결과 아티팩트와 `docs/results/` 완료 기록

기존 로컬 E2E 스크립트는 전용 테스트 DB에 `TRUNCATE`와 fixture 삽입을 수행하므로 운영 DB 대상으로 실행하지 않는다. 외부 검증은 운영 데이터 변경 범위와 화면에 노출될 테스트 문구를 확정한 뒤 수행한다. Phase 4B는 아직 완료로 기록하지 않는다.
