# 코드베이스 가정 검토 목록

**상태: 검토 완료 / Phase 4 검증 기준 확정.** 이 문서는 현재 Phase 3 구현과 Phase 4 준비를 판단할 때 사용한 가정을 기록한다. 아래 수정안은 제안일 뿐이며 적용하지 않았다. 항목 번호는 첫 검토 목록과의 대조를 위해 유지했다.

- **검증됨**: 실제 저장소 코드를 읽어 구현을 확인했다. 운영 환경에서도 같은 결과가 나온다는 뜻은 아니다.
- **추측됨**: 코드나 로컬 측정만으로 확인할 수 없는 전제다. 추측 이유와 가장 좁은 확인·수정 방법을 함께 적었다.

## 검증됨 — 코드와 저장소에서 확인한 전제

| # | 가정과 근거 | 가장 좁은 수정안 |
| --- | --- | --- |
| 1 | Phase 4만 다음 작업이며 Phase 3 로컬 baseline은 비교 기준이다. [계획](../.project/plan.md#현재-구현-기준) | Phase 4 측정값은 새 아티팩트에 기록하고 기존 baseline 파일은 유지한다. |
| 2 | 실행 대상은 Node.js 24, TypeScript, Fastify 5, `pg`다. [package.json](../package.json) | Phase 4 배포에서 현재 lockfile로 설치하고, 버전 변경이 필요하면 별도 검토 대상으로 둔다. |
| 3 | Fastify는 `127.0.0.1`에 바인딩하고 정적 파일을 작업 디렉터리의 `public`에서 제공한다. [src/server.ts](../src/server.ts) | 바인딩과 작업 디렉터리 요구만 코드 사실로 기록한다. 운영 배치 변경은 #29의 HTTPS 방식 결정 후 검토한다. |
| 4 | `NODE_ENV`, `PORT`, `DATABASE_URL`이 필수다. 하나라도 없으면 코드가 `.env`를 읽을 수 있다. [src/config/env.ts](../src/config/env.ts) | 운영 unit에 세 변수를 명시하고, 운영에서 저장소 `.env`를 읽지 않도록 `production`의 파일 fallback만 차단한다. |
| 5 | PostgreSQL pool은 프로세스 시작 때 하나 만들고 재사용한다. pool 크기는 코드에서 명시하지 않았다. [src/db/pool.ts](../src/db/pool.ts) | 재사용 구조는 유지한다. OCI 측정 전에 실제 pool 설정과 대기 수를 기록한 뒤에만 크기 변경을 검토한다. |
| 6 | `hour_slots`는 슬롯당 한 행을 두고 승자 문구와 누적 순위를 저장한다. migration은 `IF NOT EXISTS`를 사용한다. [migration](../db/migrations/001_create_hour_slots.sql) | Phase 4의 새 DB에 migration을 실행한 직후 `hour_slots`의 열·타입·기본키·CHECK 제약 metadata만 확인한다. 새 migration 도구는 도입하지 않는다. |
| 7 | 승자 결정과 순위 증가는 한 번의 PostgreSQL UPSERT로 처리하며 충돌 시 승자 문구를 갱신하지 않는다. [src/db/slots.ts](../src/db/slots.ts) | SQL은 유지하고, Phase 4 외부 E2E에서 승자 1명·순위 `1..S`·문구 불변을 재검증한다. |
| 8 | 첫 등록 후 10초 마감은 DB의 `clock_timestamp()`와 `created_at`으로 판정한다. API는 먼저 Node 시각으로 슬롯을 거른다. [src/db/slots.ts](../src/db/slots.ts), [src/routes/attempts.ts](../src/routes/attempts.ts) | DB의 최종 판정을 유지하고, Phase 4 외부 E2E에서 10초 전후 응답을 확인한다. 사전 판정과 최종 판정 사이의 경과 시간은 #20에서 검토한다. |
| 9 | 등록 입력은 본문 4KB, 문구 120자·한 줄, 정각 UTC 슬롯으로 제한된다. [src/server.ts](../src/server.ts), [src/routes/attempts.ts](../src/routes/attempts.ts) | Phase 4 외부 E2E에 유효·무효 입력의 대표 경계값만 포함한다. 제한값 자체는 바꾸지 않는다. |
| 10 | 등록 실패는 코드가 정의한 상태로 응답하고, 예기치 않은 내부 오류의 stack trace는 응답에 싣지 않는다. [src/server.ts](../src/server.ts) | 외부 응답 형식은 유지하되, 운영 진단에 필요한 오류 종류만 비밀값 없이 서버 로그에 남긴다. |
| 11 | `/api/open-state`는 1초 shared-cache header를 가진 상태 힌트다. 최종 등록 판정은 POST와 DB가 한다. [src/routes/open-state.ts](../src/routes/open-state.ts), [src/db/slots.ts](../src/db/slots.ts) | 이 endpoint를 등록 승인 신호로 취급하지 않는다. 운영 캐시를 추가한다면 슬롯 경계와 TTL만 좁게 검증한다. |
| 12 | Phase 3 캐시는 Node.js 로컬 proxy이며 실제 CDN이 아니다. [tests/load/shared-cache.mjs](../tests/load/shared-cache.mjs) | 로컬 결과를 CDN 성능으로 옮겨 적지 않고, Phase 4에는 외부에서 실제 관측한 값만 별도로 기록한다. |
| 14 | 문구 표시는 `textContent`를 사용하고 등록 요청은 자동 재시도하지 않는다. [src/client/app.ts](../src/client/app.ts) | 두 동작을 유지한다. 결과가 불확실할 때 자동 재등록을 추가하지 않는다. |
| 15 | 기존 Phase 1·2 E2E는 실제 API·DB를 호출하지만 브라우저 엔진의 화면 조작을 검증하지 않는다. [tests/e2e/run-ui-e2e.ts](../tests/e2e/run-ui-e2e.ts) | Phase 4 완료 판정에는 별도의 실제 브라우저 확인을 넣고 HTTP E2E 결과와 구분한다. |
| 16 | Phase 3 k6 RPS에는 약 5초 barrier가 포함되며 DB lock 관측은 75ms 표본이다. [tests/load/run-phase3.mjs](../tests/load/run-phase3.mjs), [Phase 3 결과](results/phase3-load-race-verification.md) | Phase 4 수치에 표본 수와 측정 구간을 붙이고, Phase 3 RPS를 서버 최대 처리량으로 사용하지 않는다. |
| 17 | Phase 3 실행기는 로컬 DB 호스트만 허용하지만, 현재 슬롯 행을 지우는 실험을 수행한다. [tests/load/run-phase3.mjs](../tests/load/run-phase3.mjs) | 운영 대상에 이 실행기를 재사용하지 않는다. 향후 재실행 안전성을 높인다면 DB 이름과 테스트 전용 표식을 추가로 확인한다. |

## 추측됨 — 이유와 확인 방법이 필요한 전제

| # | 가정·추측 이유 | 가장 좁은 수정안 |
| --- | --- | --- |
| 13 | **확인된 구현:** 브라우저는 `/api/round`로 시각을 맞추고 10초마다 동기화하며 `/api/open-state`는 호출하지 않는다. [src/client/app.ts](../src/client/app.ts) **미검증 가정:** 이 구조가 다른 클라이언트의 Winner 발생과 10초 Window 종료를 제품이 기대하는 시점 안에 반영한다는 보장은 없다. 정상 동기화에서도 한 주기 가까이 늦을 수 있고 요청 실패 시 더 늦을 수 있다. 서버의 최종 등록 정합성에는 영향이 없다. | Phase 4 전에 UI 계약을 결정한다. 등록 가능 상태를 표시하는 동안에만 `/api/open-state`를 짧게 polling해 `winnerExists`·`registrationClosesAt`을 받고, 이후 브라우저 timer로 마감 시각을 계산하며 마감 후 polling을 멈추는 방안을 우선 검토한다. 지금은 적용하지 않는다. |
| 19 | **확인된 구현:** `/api/round`는 요청 시작 시 현재 Slot을 계산하고 DB 조회가 끝난 뒤 Slot을 다시 계산하지 않는다. [src/routes/round.ts](../src/routes/round.ts) **미검증 가정:** 이 구현이 정각 경계에서 항상 새 Slot 기준 응답을 반환한다는 보장은 아직 없다. | 실제 정각 경계 E2E를 먼저 수행한다. 오류가 재현될 때만 응답 직전 Slot을 재계산하고, 달라졌다면 새 Slot을 한 번 재조회한다. 선제 수정하지 않는다. |
| 20 | Node의 Round 사전 판정과 PostgreSQL의 최종 판정 사이에는 요청 처리·pool 대기·query 실행 시간이 흐를 수 있다. [src/routes/attempts.ts](../src/routes/attempts.ts), [src/db/slots.ts](../src/db/slots.ts) 동일 VM의 두 프로세스에서 OS clock 자체가 크게 다를 것이라는 근거는 없다. DB의 `clock_timestamp()` 재검증이 사전 판정보다 엄격한 결과를 낼 가능성이 있다. | 부하와 정각 경계 E2E에서 두 판정 시점 사이의 결과를 확인한다. UPSERT의 `clock_timestamp()` 최종 판정은 유지하고, 실제 실패가 확인될 때만 사전 판정 경로를 조정한다. |
| 21 | systemd가 올바른 환경 변수·작업 디렉터리·기동 순서를 제공할지는 미확인이다. 운영 unit이 저장소에 없다. | `WorkingDirectory`와 PostgreSQL 기동 의존 관계를 명시한다. 운영 환경 변수는 저장소의 `.env` 자동 fallback이 아니라 systemd가 명시적으로 읽는 별도 운영 `EnvironmentFile` 또는 동등한 방식으로 주입하고 재시작 smoke test를 수행한다. |
| 22 | 사용할 OCI 계정의 home region, 무료 quota, SSH 접근 권한은 확인하지 않았다. Phase 4 문서는 이를 선행 조건으로 둔다. [Phase 4 지침](instructions/phase4-oci-deployment.md) | 리소스 생성 전 계정·region·잔여 quota를 읽기 전용으로 확인하고 조건이 맞지 않으면 생성을 멈춘다. |
| 23 | 선택할 OCI ARM64 이미지에서 Node.js 24와 PostgreSQL 18의 설치·빌드가 그대로 통과할지는 미확인이다. 로컬 기준 결과는 Windows와 Docker PostgreSQL에서 얻었다. | VM image를 정한 뒤 해당 아키텍처에서 `npm ci`, build, migration을 작은 smoke 단계로 확인한다. |
| 24 | 관리 가능한 도메인과 DNS 변경 권한이 있다는 전제는 확인하지 않았다. 공개 인증서 발급의 선행 조건이다. [Phase 4 지침](instructions/phase4-oci-deployment.md) | 인증서 작업 전에 도메인 소유·DNS 제어와 A 레코드 전파를 확인한다. |
| 25 | PostgreSQL과 앱 내부 포트가 OCI에서 외부 비공개로 유지될지는 미확인이다. 로컬 loopback 바인딩과 Compose 설정만 확인했다. | VM의 listen 주소, 방화벽, OCI ingress를 각각 확인하고 외부에서 5432와 앱 포트의 접근 실패를 검증한다. |
| 26 | VM reboot 뒤 프로세스와 기존 Winner 데이터가 복구될지는 미확인이다. 현재는 systemd/운영 디스크에 대한 실행 결과가 없다. | 재부팅 전 슬롯 행을 읽어 기록하고 재부팅 후 DB 행·서비스·HTTPS를 다시 확인한다. |
| 27 | Phase 3 지연 수치가 OCI 외부 지연을 예측한다는 근거는 없다. 외부 DNS·TLS·인터넷 RTT가 측정에 추가된다. [Phase 4 지침](instructions/phase4-oci-deployment.md) | 외부 RTT와 등록 p50/p95/p99를 별도 아티팩트로 측정하고 로컬 baseline과 측정 환경을 나란히 적는다. |
| 28 | 현재 오류 기록만으로 운영 장애 원인을 진단할 수 있을지는 미확인이다. Fastify logger가 꺼져 있고 일부 catch가 원인을 응답에서 숨긴다. [src/server.ts](../src/server.ts) | Phase 4 배포 전에 production에서만 최소 구조화 오류 로그를 검토한다. 시각·route·HTTP 상태·내부 오류 범주·존재한다면 요청 상관관계 ID만 기록한다. `DATABASE_URL`, 비밀번호, 환경 변수 전체, 사용자 문구 전문은 기록하지 않고 stack trace는 외부 응답에 노출하지 않는다. |
| 29 | OCI VM의 Linux 배포판과 HTTPS 종료·인증서 구성이 아직 확정되지 않았다. Phase 4 지침에는 안정 Linux image와 reverse proxy 방향이 있지만 VM image 및 Caddy/Nginx 등 구현체는 선택되지 않았다. [Phase 4 지침](instructions/phase4-oci-deployment.md) 외부 HTTPS를 위해 reverse proxy가 필요하다는 전제도 실제 구성 선택 전에는 운영 설계로 다뤄야 한다. | Phase 4 시작 시 VM image를 정하고 Node.js·PostgreSQL 설치 가능성을 확인한 다음 HTTPS 방식을 확정한다. reverse proxy를 채택하는 경우에만 Fastify loopback bind를 유지하고 proxy만 외부에 노출한다. 그 선택에 맞춰 systemd와 firewall을 구성한다. |

## 로컬 작업공간 상태 — 코드 동작 가정 아님

- 이전 미완료 Phase 3 실행 폴더 5개는 로컬에 남아 있고 `.gitignore`의 `k6/results/` 규칙으로 Git 추적 대상에서 제외된다. 이 폴더는 기준 baseline에 포함되지 않는다.
- 삭제 여부는 사용자가 판단한다. 지금은 삭제하거나 이동하지 않는다.
- 보존이 필요하다면 저장소 밖 archive로 이동하는 방안을 검토할 수 있다. 향후 runner에서는 실행 중 결과를 ignored 임시 디렉터리에 쓰고, 성공한 결과만 최종 artifact 디렉터리로 옮기는 방안이 더 구조적이다.

## Phase 4 전 수동 검토 우선순위

| 우선순위 | 항목 | 이유 |
| --- | --- | --- |
| 높음 | #13 원격 Winner와 10초 Window UI 동기화 | 제품 UX 계약과 충돌 가능 |
| 높음 | #19 `/api/round` 정각 경계 | 티켓팅 핵심 경계 조건 |
| 높음 | #21 systemd 구성 | Phase 4 필수 |
| 높음 | #25 외부 포트 차단 | 배포 보안 필수 |
| 높음 | #28 운영 오류 로그 | 운영 진단 필수 |
| 중간 | #6 schema 검증 | 새 DB라면 위험이 낮음 |
| 중간 | #20 사전·최종 판정 시점 | 경계 검증 후 판단 |
| 중간 | #23 ARM64 환경 | VM image 선택 후 smoke 검증 |
| 낮음 | 로컬 작업공간 — 미완료 실행 폴더 (기존 #18) | 코드 동작과 무관 |

## 검토 범위

이 목록은 현재 판단과 Phase 4 준비에 실제로 사용한 가정이다. 검증된 구현 사실은 근거 없이 바꾸지 않고, 추측된 운영 동작은 Phase 4에서 확인한 뒤 필요한 최소 수정만 검토한다. 제안된 수정은 수동 검토 전까지 적용하지 않는다.
