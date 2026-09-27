# Phase 3 — Load, Race & Open-State Verification 결과

## 구현 범위와 실행 환경

`GET /api/open-state`와 1초 shared-cache header, Phase 3 전용 로컬 공유 캐시, k6/Node.js 동시 요청 시나리오 및 결과 수집기를 추가했다. 등록 API의 atomic UPSERT와 첫 등록 후 10초 Registration Window는 변경하지 않았다.

- 변경 파일: `src/routes/open-state.ts`, `src/server.ts`, `package.json`, `tests/load/run-phase3.mjs`, `tests/load/shared-cache.mjs`, `k6/scenarios/phase3-{race,open-state,open-state-herd,thundering-herd}.js`, 이 문서, `README.md`.
- 측정 환경: Windows 10.0.26200, AMD Ryzen 7 260, 논리 코어 16개, 메모리 33,565,126,656 bytes, Node.js 24.19.0, Docker Compose의 PostgreSQL 18.6, 포터블 k6 2.3.0.
- 별도 `hourboard_loadtest` DB에 기존 migration을 적용했다. 테스트 종료 후 DB는 유지했다. 기존 개발 DB의 슬롯 데이터는 초기화하지 않았다.
- PostgreSQL `pg_stat_activity`와 `pg_locks`를 75ms 간격으로 샘플링했다. 이 조회 자체가 부하에 영향을 줄 수 있다. Docker container의 자원 한도는 확인하지 못했다.
- `npm.cmd run build` 통과. `NODE_ENV=test`와 로컬 `DATABASE_URL`로 `npm.cmd run e2e`를 실행해 Phase 1·2 실제 Fastify/PostgreSQL E2E가 통과했다.

기준 아티팩트: [`k6/results/phase3/2026-09-27T10-41-43-679Z/baseline-summary.json`](../../k6/results/phase3/2026-09-27T10-41-43-679Z/baseline-summary.json). 각 단계의 k6 요약, 정합성, PostgreSQL 샘플도 같은 디렉터리에 있다. 전체 실행은 2026-09-27 10:41 UTC에 시작했고 실제 11:00 UTC 정각을 관찰했다. 동시 open-state 조회 단계는 11:05 UTC에 추가 측정해 같은 baseline에 합쳤으며, 각 결과에 측정 시각을 기록했다.

## 10초 Registration Window와 Race

Window 확인 요청 3건 중 2건은 WINNER/1등과 RANKED/2등으로 성공했고, 마감 후 1건은 `409 REGISTRATION_CLOSED`, `position=null`, `winner=false`였다. 마감 전후 DB 순위 카운트는 2로 같고 승자 문구 변경은 0건이었다.

각 동시성 단계는 빈 현재 슬롯에서 Node.js 실제 병렬 HTTP 정합성 실행과 별도의 k6 성능 실행을 수행했다. 아래 p50·p95·p99와 RPS는 k6 실행의 `http_req_duration` 및 `http_reqs` 값이다. k6 RPS에는 요청 전 약 5초 barrier 대기가 포함되어 지속 처리 용량을 뜻하지 않는다.

| 동시성 | 정합성 요청/성공/마감/예상 밖 실패 | k6 요청/성공/마감/예상 밖 실패 | k6 p50/p95/p99 ms | k6 RPS | 최대 DB lock 대기 연결 수¹ |
| ---: | --- | --- | --- | ---: | ---: |
| 10 | 10/10/0/0 | 10/10/0/0 | 10.383/17.442/19.775 | 2.090 | 0 |
| 50 | 50/50/0/0 | 50/50/0/0 | 60.316/80.034/81.322 | 9.974 | 8 |
| 100 | 100/100/0/0 | 100/100/0/0 | 81.178/125.745/130.107 | 19.730 | 9 |
| 200 | 200/200/0/0 | 200/200/0/0 | 108.526/189.626/194.989 | 38.944 | 8 |

¹ 각 단계 k6 성능 실행의 75ms 샘플 최대값. 10명 단계에서 관측값 0은 lock 대기가 없었다는 증명이 아니라 샘플에서 포착되지 않았다는 뜻이다.

네 정합성 실행 모두 accepted 요청의 승자는 1명, 순위는 `1..S`, 중복·누락 순위는 각각 0건, 승자 문구 변경은 0건이었다. DB `attempt_count`는 accepted 수와 일치했다. k6 실행도 단계마다 승자 1명, 예상 밖 실패 0건, accepted 수와 DB 카운트 일치를 확인했다. 이번 race에서는 마감 응답이 발생하지 않았으며, 마감 후 순위 미소비는 위 Window 실행으로 따로 검증했다.

## Open-State 전달

실제 11:00 UTC 경계에서 각 방식의 가상 클라이언트 1명이 상태를 관찰했다. Client Timer는 초기 `/api/round` 1회, 정각 전 추가 요청 0회였고, 활성 시각 오차는 밀리초 단위 기록에서 0ms로 관측됐다. 이는 실제 오차가 전혀 없다는 뜻은 아니다. 정각 직후 검증 요청 1회에서 열린 새 슬롯을 확인했다. Direct Polling의 정각 탐지 지연은 122ms, 로컬 공유 캐시 경유는 129ms였다. 두 polling 경로의 client 요청은 각각 13건이며, origin 요청은 각각 13건과 7건이었다.

이후 각 방식에서 클라이언트 100·500·1000명이 1초 간격으로 20초 동안 조회했다. Winner 발생과 10초 Window 마감을 모두 관찰했다. 아래 origin RPS는 `originRequestCount / 20초`로 계산한 명목값이고, p50·p95·p99는 클라이언트 HTTP 요청 지연이다.

| 방식 | 클라이언트 | client/origin 요청 | origin RPS² | cache 억제율 | p50/p95/p99 ms | Winner/마감 탐지 p50 ms | 예상 밖 실패 |
| --- | ---: | --- | ---: | ---: | --- | --- | ---: |
| 직접 조회 | 100 | 2,100/2,100 | 105.00 | 0% | 1.619/3.264/5.868 | 103/107 | 0 |
| 직접 조회 | 500 | 10,500/10,500 | 525.00 | 0% | 1.672/3.192/4.209 | 331.5/334 | 0 |
| 직접 조회 | 1000 | 20,983/20,983 | 1,049.15 | 0% | 1.609/2.856/3.749 | 499/494 | 0 |
| 로컬 캐시 | 100 | 2,100/21 | 1.05 | 99.000% | 0/1.140/4.230 | 106/1058.5 | 0 |
| 로컬 캐시 | 500 | 10,500/21 | 1.05 | 99.800% | 0/0.756/1.698 | 338.5/388 | 0 |
| 로컬 캐시 | 1000 | 20,982/21 | 1.05 | 99.900% | 0/0.705/1.209 | 691/733.5 | 0 |

² 실제 k6 client RPS와 다른 분모다. 캐시 실행의 origin 요청 21건은 해당 20초 실행에서 직접 계수한 값이다. cache hit/miss는 100명 2,079/21, 500명 10,479/21, 1000명 20,961/21이었다. 캐시의 coalesced 요청도 hit에 포함된다. 캐시 p50의 0ms는 이번 k6 요약의 표시 해상도에서 관측된 값으로, 응답 지연이 전혀 없다는 뜻은 아니다. 1000명 캐시 실행의 마감 탐지 p95는 1178ms, 직접 조회는 948.2ms였다.

Client Timer는 정각 계산에 필요한 사전 조회를 1회로 줄였지만, 다른 사용자의 Winner 발생과 Window 마감을 자체적으로 알 수 없다. 캐시 결과는 Node.js 로컬 shared-cache simulation이고 CDN/Edge 실측값이 아니다. 캐시된 `serverTime`은 정밀 countdown의 기준으로 사용하지 않는다. 최종 등록 허용 여부는 계속 `POST /api/attempts`와 PostgreSQL이 결정한다.

## Thundering Herd

빈 슬롯에 대한 `GET /api/open-state` 동시 조회와 별도 빈 슬롯에서의 POST 정합성·k6 성능 실행을 분리했다. 조회 burst는 전체 실행 뒤에 추가 측정했으며, 각 아티팩트에 측정 시각이 있다. 두 단계 모두 origin을 직접 호출했다.

POST k6 RPS 역시 요청 전 약 5초 barrier를 포함한 전체 실행의 rate다. 표의 38.905 RPS를 서버 최대 처리량으로 해석하지 않는다.

| 동시성 | GET 성공/실패 | GET 분산/p50/p95/p99 ms | POST 성공/마감/실패 | POST 분산/p50/p95/p99 ms | POST k6 RPS | POST 최대 DB lock 대기³ |
| ---: | --- | --- | --- | --- | ---: | ---: |
| 10 | 10/0 | 0/22.205/23.013/23.199 | 10/0/0 | 0/7.678/10.004/10.389 | 2.023 | 0 |
| 50 | 50/0 | 2/25.781/36.983/42.110 | 50/0/0 | 3/25.063/45.415/46.537 | 10.035 | 0 |
| 100 | 100/0 | 7/43.004/62.606/63.144 | 100/0/0 | 9/48.838/87.609/90.761 | 19.893 | 8 |
| 200 | 200/0 | 7/58.924/85.899/87.446 | 200/0/0 | 22/110.545/190.834/198.286 | 38.905 | 8 |

³ POST k6 성능 실행의 샘플 최대값. 각 POST 정합성 실행은 승자 1명, `1..S` 순위, 중복·누락 0건, 승자 문구 변경 0건, DB 카운트 일치를 확인했다. GET burst는 모든 응답에서 빈 현재 슬롯과 `registrationOpen=true`를 확인했고, DB lock 대기 샘플 최대값은 네 단계 모두 0으로 관측됐다. 75ms 샘플에서 0이었다는 결과가 대기 부재를 증명하지는 않는다.

## 해석과 한계

동시성이 커질수록 이번 로컬 실행의 Race 및 POST Herd p95가 증가했고, 여러 단계에서 PostgreSQL lock waiter가 관측됐다. 동일 슬롯 UPSERT 경쟁은 실제로 발생했다. 하지만 애플리케이션 pool 대기 시간, Node.js event loop 지연, CPU 사용률을 별도로 계측하지 않았으므로 p95 증가분을 row lock 하나의 영향으로 분해할 수 없다. 75ms 샘플은 짧은 대기 구간을 놓칠 수도 있다.

1초 로컬 공유 캐시는 origin 조회 수를 줄였고, 일부 실행에서는 Window 마감 탐지가 직접 조회보다 늦었다. 이 값은 로컬 proxy와 현재 VU 타이밍의 결과다. 실제 CDN, 외부 RTT, OCI VM 성능, 컨테이너 자원 한도는 이 Phase에서 측정하지 않았다. Phase 4에서는 이 로컬 baseline과 외부 환경 결과를 구분해 기록해야 한다.

## 재실행

로컬 Compose PostgreSQL을 실행하고 `DATABASE_URL`을 해당 개발 DB URL로, `NODE_ENV=test`로, `K6_BIN`을 포터블 k6 실행 파일 경로로 설정한 뒤 `npm.cmd run load:phase3`을 실행한다. 스크립트가 별도 `hourboard_loadtest` DB와 새 결과 디렉터리를 준비하고 전체 단계를 수행한다. PowerShell 실행 정책 때문에 이 환경에서는 `npm.cmd`를 사용했다. 기존 baseline에 조회 burst만 보충할 때는 `PHASE3_MODE=open-state-herd`와 `PHASE3_RUN_ID=<기존 실행 ID>`를 추가한다. 일반 재실행에는 두 변수를 설정하지 않는다.

이번 실행에서 이전 시도의 요약 파일 누락 원인은 정각 단계 출력 디렉터리 부재였다. `runK6`가 요약 경로의 부모 디렉터리를 먼저 만들도록 수정한 뒤 포터블 k6의 요약 생성과 전체 재실행을 확인했다. 이전의 미완료 실행 디렉터리는 기준 결과에 포함하지 않았다.
