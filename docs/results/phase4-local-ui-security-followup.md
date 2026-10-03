# Phase 4 로컬 등록 완료 UI·보안 점검 결과

검증일: 2026-10-03 (Asia/Seoul)

이 문서는 작업 PC에서 완료한 후속 구현과 검증만 기록한다. Phase 4 Production 배포·검증 완료 문서는 아니다.

## 구현 범위

- Winner·Ranked 성공 응답 후 현재 페이지의 등록 버튼과 10초 마감 안내를 숨기고 결과 카드를 유지했다.
- 제출한 문구가 입력창에 그대로 남지 않도록 비웠다. 요청 중 사용자가 다른 문구로 바꿨다면 새 초안은 유지한다. 다음 Round에서는 문구를 다시 입력해 등록할 수 있다.
- 다른 브라우저의 서버 Registration Window는 유지하고, 다음 Round 감지 시 두 브라우저의 참여 완료 UI를 초기화했다.
- Fastify의 HTML·정적 자산·API 응답에 CSP, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`를 추가했다. CSP는 같은 출처의 스크립트·스타일·이미지·API 연결만 허용하고 인라인 스크립트와 객체 삽입을 허용하지 않는다.
- 브라우저 E2E가 정각 종료 직전 시작되면 다음 슬롯까지 기다리도록 보완하고, 등록 완료 뒤 빈 입력의 비활성 상태와 새 초안 입력 후 활성 상태를 검증한다.

## 검증

| 검증 | 결과 |
| --- | --- |
| `npm.cmd run build` | 통과 |
| 실제 PostgreSQL `npm.cmd run e2e` | Phase 1·2 통과 |
| 실제 Chrome 두 브라우저 컨텍스트·Fastify·PostgreSQL `node tests/e2e/run-button-browser-e2e.mjs` | 통과 |
| 로컬 HTTP `GET /`, `/scripts/app.js`, 미정의 `/api` | 보안 헤더 포함 200·200·JSON 404 |
| 4 KiB 초과 등록 본문 | `400 INVALID_REQUEST`로 거부 |
| DB 연결 불가 상태의 `GET /api/round` | 내부 연결값·stack이 없는 `503 DATABASE_UNAVAILABLE` |

브라우저 E2E는 요청 4건 중 성공 3건, 마감 거부 1건이었다. Winner 1건, 성공 순위 `1..3`, 중복 0건, 누락 0건, Winner 문구 변경 0건을 확인했다. Winner와 Ranked 모두 제출 후 입력창이 비고 결과 카드가 유지됐다. 브라우저 시각 조정으로 두 브라우저의 다음 Round 상태 초기화와 새 문구 입력 후 버튼 활성화를 확인했다. 모바일 390px 화면의 결과 이미지는 입력창이 비어 있는 Ranked 상태를 보여준다.

서비스 SQL은 입력값을 PostgreSQL 바인딩으로 전달하고 migration SQL은 고정 파일에서 읽는다. Winner 문구는 프런트엔드에서 `textContent`로 출력한다. 로컬 브라우저 E2E는 CSP 적용 상태에서 정상 흐름이 동작함을 확인했다. 악성 문구를 실제 운영 브라우저에 등록하는 검증은 수행하지 않았다.

## 결과 아티팩트

- `tests/e2e/artifacts/phase1-concurrency.json`
- `tests/e2e/artifacts/phase2-ticketing-ui.json`
- `tests/e2e/artifacts/button-browser-flow.json`
- `tests/e2e/artifacts/button-ranked-mobile.png`

## 남은 운영 검증

이번 변경은 작업 PC에서만 실행했다. Production 이미지 재빌드와 배포, 운영 브라우저 흐름, 새 보안 헤더의 운영 응답, Traefik rate limit의 실제 429, 외부 병렬 E2E와 latency는 아직 검증하지 않았다. 로컬 개발 서버에서 PostgreSQL 연결이 잠시 끊겨 `/api/round`와 `/health`가 503을 반환한 뒤 200으로 복구된 사실을 확인했지만, Docker 엔진 상태에 접근할 수 없어 정확한 원인은 확정하지 않았다.
