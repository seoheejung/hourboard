# Phase 4 Production 배포·검증 결과

**상태: 완료**

**기준일: 2026-10-03**

Phase 4B 자체 호스팅 경로를 운영 배포로 확정했다. 공개 주소는 `https://hourboard.duckdns.org/`이며 요청은 DuckDNS → 공유기 TCP 443 → Traefik → Fastify → PostgreSQL을 지난다. OCI Tokyo A1 Flex는 host capacity 부족으로 생성에 실패해 사용하지 않았다. 초기 배포와 Windows 재부팅 이력은 [Phase 4B 진행 기록](../progress/phase4-self-hosted-deployment.md)에 남겼다. 등록 완료 UI와 보안 헤더를 포함한 commit `7ba177e`가 운영에서 실행되는 것을 확인했다.

## 운영 구성과 복구

| 확인 항목 | 결과 |
| --- | --- |
| 외부 접속 | Wi-Fi를 끈 LTE/5G 브라우저의 신뢰되는 HTTPS 화면·`/health` 접근 확인. 이후 LTE/5G 핫스팟을 연결한 작업 PC에서 등록 경합 E2E 수행 |
| 공개 포트 | Host publish는 Traefik TCP 443뿐. Fastify 3000과 PostgreSQL 5432는 host publish 없음. 공유기 포트포워딩도 TCP 443만 사용 |
| 서비스 상태 | PostgreSQL healthy, `/health`·`/api/round`·루트 200 |
| Windows 재부팅 | app·db·Traefik·DuckDNS updater 복구, 이전 Winner·attemptCount 유지. 초기 검증은 진행 기록에 보존 |
| DB 컨테이너 재생성 | 기존 named volume을 유지한 채 db 서비스만 재생성. 이전·이후 `attemptCount=101`과 Winner 문구 SHA-256이 동일하고 db healthy, `/health`·`/api/round` 200 |

DB 재생성은 운영 데이터가 보존된 상태에서 수행했다. `docker compose down -v`나 volume 삭제는 사용하지 않았다. [DB 재생성 아티팩트](../../tests/e2e/artifacts/phase4-production-db-recreate.json)에 재생성 전후 값과 확인 시각을 기록했다.

## 실제 운영 동작

| 검증 | 관찰 결과 | 아티팩트 |
| --- | --- | --- |
| Chrome 브라우저 A·B·C | A는 WINNER, B와 C는 10초 이내 RANKED. 세 입력창이 비워지고 결과 카드는 유지됐다. 참여 완료 브라우저의 버튼과 10초 countdown은 숨겨졌고 Winner 전광판은 유지됐다. 다음 Round에서 열린 페이지의 참여 완료 상태가 초기화됐다 | [브라우저 E2E](../../tests/e2e/artifacts/phase4-production-browser.json) |
| 새로고침 제약 | 참여 완료 상태는 현재 페이지 메모리에만 있어 새로고침 후 복원되지 않음 | [브라우저 E2E](../../tests/e2e/artifacts/phase4-production-browser.json) |
| 등록 API rate limit | 실행 중인 Traefik 설정은 average 30/1s, burst 150. 잘못된 JSON POST 300건 중 100건이 429, 200건이 400. 동시에 조회한 `/health`·`/api/round`는 모두 200 | [429 E2E](../../tests/e2e/artifacts/phase4-production-rate-limit.json) |
| 정각 경계와 병렬 등록 | 정각 전 미래 slot은 ROUND_NOT_STARTED, 종료된 slot은 ROUND_ENDED. 정각 직후 병렬 POST 100건과 후속 1건이 성공해 Winner 1명, 순위 1~101, 중복 0, 누락 0, Winner 문구 변형 0 | [정각·경합 E2E](../../tests/e2e/artifacts/phase4-production-race-window-latency.json) |
| 10초 Registration Window | 후속 등록은 RANKED. 마감 후 요청은 REGISTRATION_CLOSED이고 Position을 소비하지 않음 | [정각·경합 E2E](../../tests/e2e/artifacts/phase4-production-race-window-latency.json) |
| 외부망 등록 경합 | LTE/5G 핫스팟에서 현재 비어 있던 Round에 병렬 POST 30건과 후속 1건 성공. Winner 1명, 순위 1~31, 중복 0, 누락 0, Winner 문구 변형 0. 마감 요청은 Position을 소비하지 않음 | [외부망 경합 E2E](../../tests/e2e/artifacts/phase4-production-external-race-window-latency.json) |

브라우저 E2E와 정각 경계 E2E는 작업 PC와 운영 미니PC가 같은 LAN에 있을 때 **공개 HTTPS 주소**를 통해 수행했다. 외부망 등록 경합은 작업 PC를 사용자가 확인한 LTE/5G 핫스팟에 연결한 뒤 수행했다. 따라서 정각 경계와 외부망 경합은 서로 다른 실행에서 확인한 사실이다. 순위는 브라우저 클릭 시각이 아닌 서버·DB 처리 결과다.

운영 E2E는 실제 등록이므로 테스트 Winner 문구가 해당 Round 종료 시각까지 전광판에 표시된다.

## HTTP 보안 응답

운영 HTTPS의 루트·`/health`·`/api/round` 모두 CSP, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`를 반환했다. 미정의 `/api` 경로는 내부 정보 없는 JSON 404, 4 KiB 초과 등록 본문은 stack trace 없는 JSON 400을 반환했다. [HTTP 보안 아티팩트](../../tests/e2e/artifacts/phase4-production-security-smoke.json)에 실제 응답 상태와 헤더를 기록했다. 저장된 Winner 문구는 브라우저에서 `textContent`로 렌더링하며 등록 SQL은 PostgreSQL parameter binding을 사용한다.

## 지연 시간과 페이지 로드

Phase 3의 로컬 baseline은 수정하지 않았다. 아래 수치는 Phase 4 운영 서버를 대상으로 별도로 측정했다. GET은 순차 요청이며 POST는 실제 병렬 등록 요청이다. 따라서 GET과 POST 분포를 동일한 부하 조건으로 비교하지 않는다.

| 측정 위치·항목 | Sample 수 | p50 | p95 | p99 |
| --- | ---: | ---: | ---: | ---: |
| 동일 LAN, 공개 HTTPS, GET `/api/round` | 40 | 13.33 ms | 22.87 ms | 40.70 ms |
| 동일 LAN, 공개 HTTPS, POST `/api/attempts` | 101 | 450.09 ms | 588.71 ms | 599.75 ms |
| 외부 LTE/5G 핫스팟, GET `/api/round` | 40 | 82.85 ms | 163.88 ms | 186.27 ms |
| 외부 LTE/5G 핫스팟, POST `/api/attempts` | 31 | 1026.03 ms | 1042.36 ms | 1064.75 ms |
| 외부 LTE/5G 핫스팟, TCP 443 연결 시간 | 20/20 성공 | 87.80 ms | 248.82 ms | 252.57 ms |

외부 RTT는 ICMP ping이 아니라 공개 HTTPS endpoint의 **TCP connect 시간**으로 측정했다. 이 값은 TCP 연결 설정의 왕복 지연을 포함하며 HTTP 처리 시간을 포함하지 않는다. 작업 PC에 이전 미니PC LAN 대역 주소가 없는 것도 확인했다. 외부망 여부는 사용자의 핫스팟 연결 확인에 근거하며, 제3자 IP 조회 서비스는 사용하지 않았다. 수치 원본은 [동일 LAN 정각 경합](../../tests/e2e/artifacts/phase4-production-race-window-latency.json), [외부망 경합](../../tests/e2e/artifacts/phase4-production-external-race-window-latency.json), [외부 TCP 연결](../../tests/e2e/artifacts/phase4-production-external-rtt.json)에 있다.

동일 LAN의 실제 Chrome 페이지 로드 10회는 document load p50/p95/p99가 **33.9/385.7/385.7 ms**, `/api/round` 반영까지 **130.2/493.9/493.9 ms**였다. 이는 외부망 페이지 로드 수치가 아니다. [페이지 로드 아티팩트](../../tests/e2e/artifacts/phase4-production-page-load.json)에 개별 sample을 남겼다.

## 계획과 실제 구현의 차이·운영 제약

- OCI A1 무료 경로는 capacity 부족으로 사용하지 않았고 자체 호스팅 미니PC를 기본 배포로 확정했다.
- HTTP 80은 열지 않아 HTTP → HTTPS redirect를 제공하지 않는다. 사용자는 HTTPS 주소로 접속한다.
- Traefik의 Docker socket read-only bind mount는 현재 유지한다. `:ro`가 Docker API 권한을 제한하지 않는 위험을 인지하며, socket proxy 등 보강은 별도 인프라 변경으로 검토한다.
- 브라우저 새로고침 후 참여 완료 UI 상태는 복원되지 않는다. 현재 등록 API에는 로그인·세션 식별자가 없어 페이지 단위 상태로 동작한다.
- 가정용 회선 포화형 대규모 DDoS는 앱 rate limit으로 막을 수 없다. 공개 규모가 커지면 상위 네트워크/CDN 보호가 필요하다.

운영 credential, 공인·LAN IP, 개인 경로는 문서와 아티팩트에 기록하지 않았다. 최신 변경의 운영 배포, E2E, 복구, 보안 포트, 외부 RTT 및 GET/POST latency를 확인했으므로 Phase 4 완료 기준을 충족한다.
