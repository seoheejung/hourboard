# 첫 등록 후 10초 등록 Window 검증

검증일: 2026-09-27 (Asia/Seoul)

## 구현

- `hour_slots.created_at`을 첫 정상 등록 시각으로 사용한다. 신규 등록은 PostgreSQL `clock_timestamp()`로 해당 시각을 기록한다.
- 등록 SQL 한 번의 `INSERT ... ON CONFLICT DO UPDATE`에서 row lock 획득 뒤 10초 마감과 Slot 종료 시각을 확인한다. 마감된 요청은 순위를 늘리거나 Winner 문구를 바꾸지 않고 `409 REGISTRATION_CLOSED`를 반환한다.
- `GET /api/round`는 `registrationOpen`, `registrationClosesAt`을 반환한다. 성공 등록 응답도 `registrationClosesAt`을 반환해 해당 브라우저가 10초 경계에서 버튼을 끈다.
- 마감 뒤에도 Winner 문구는 Round 종료까지 조회·표시한다. 새 Round는 이전 Winner의 마감 상태를 이어받지 않는다.
- 등록 마감 뒤 다음 정각 5분 전까지 버튼을 숨긴다. 5분 전부터는 비활성 상태로 표시하고, 보정된 서버 시각의 정각에 새 Round로 즉시 전환해 유효한 문구의 버튼을 활성화한다. 서버 상태는 이어서 조회하며, 등록의 최종 판정은 API가 한다.
- 기존 `created_at` 열을 활용하므로 DB migration은 추가하지 않았다.

## 검증 결과

| 실행 | 결과 |
| --- | --- |
| `npm run build` | 통과 |
| 실제 Fastify·PostgreSQL `npm run e2e` | Phase 1·2 통과 |
| 실제 Chrome·Fastify·PostgreSQL `node tests/e2e/run-button-browser-e2e.mjs` | 통과 |

Phase 1 E2E는 병렬 등록 100건 모두 성공, Winner 1건, 순위 1~100, 중복·누락 순위 0건, Winner 문구 변형 0건을 기록했다. 별도 fixture에서 등록 요청을 PostgreSQL row lock 뒤에 대기시킨 후 Window를 넘겨 잠금을 해제했으며, 해당 요청은 409로 거부되고 기존 순위·Winner 문구는 유지됐다.

브라우저 E2E는 Winner 없는 현재 Round의 버튼 활성, 최초 WINNER·position 1, 10초 이내 Winner 존재 상태의 버튼 활성과 RANKED·position 2 이상을 확인했다. 실제 10초 경과를 기다린 뒤 버튼 비활성, 직접 API 요청의 `409 REGISTRATION_CLOSED`, Winner 문구 유지도 확인했다. 시각 조정으로 다음 정각 5분보다 앞선 때 버튼 숨김, 5분 이내 비활성 표시, 정각 1초 전 비활성 유지를 확인했다. 현재 Round 요청 4건 중 성공 3건·마감 거부 1건이었고, 성공 순위는 1~3이며 중복·누락 순위와 Winner 문구 변형은 0건이다.

이전 Round Winner만 남긴 실제 PostgreSQL fixture에서는 현재 Round의 `registrationOpen = true`, `registrationClosesAt = null`과 새 WINNER·position 1을 확인했다. 브라우저에서는 시각 조정으로 정각 직전까지 버튼 비활성, 정각 경계에서 서버 조회 응답을 기다리지 않는 버튼 활성과 상태 초기화를 확인했다. 실제 정각까지 대기하는 검증은 수행하지 않았다. Slot 종료 시각이 10초 Window보다 빠른 fixture에서는 `registrationClosesAt`이 Slot 종료로 제한됨을 확인했다.

## 아티팩트

- `tests/e2e/artifacts/phase1-concurrency.json`
- `tests/e2e/artifacts/phase2-ticketing-ui.json`
- `tests/e2e/artifacts/button-browser-flow.json`
- `tests/e2e/artifacts/button-ranked-mobile.png`
