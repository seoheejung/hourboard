# Phase 2 — Ticketing UI 결과

## 구현 범위

Fastify에서 정적 단일 화면을 제공한다. 현재 전광판과 빈 상태, Asia/Seoul 종료 시각, `serverTime`으로 보정한 밀리초 countdown, 120자 한 줄 입력, 중복 제출 차단, WINNER·RANKED 및 오류 결과를 구현했다. 등록 API는 자동 재시도하지 않는다. 전광판 문구는 `textContent`로 출력한다.

## 변경 파일

- `package.json`, `package-lock.json`, `tsconfig.client.json`, `src/server.ts`
- `src/client/app.ts`, `public/index.html`, `public/styles/app.css`, `public/scripts/app.js`
- `tests/e2e/run-ui-e2e.ts`, `tests/e2e/artifacts/phase2-ticketing-ui.json`
- `docs/results/phase2-ticketing-ui.md`, `README.md`

## UI 상태

현재 승자 유무, 다음 정각 대기·현재 라운드 등록 가능, 제출 중, WINNER, RANKED, INVALID_REQUEST, INVALID_SLOT, ROUND_NOT_STARTED, ROUND_ENDED, 결과 미확정 상태를 처리한다. 입력 label, 결과 `aria-live`, focus 표시, 모바일 단일 컬럼을 제공한다.

## 실행한 E2E와 실제 결과

- `npm run build`: 서버 및 브라우저 TypeScript 빌드 통과.
- `npm run e2e:phase2`: 실제 Fastify 프로세스와 로컬 PostgreSQL `hourboard_e2e` DB를 사용해 통과.
- `GET /`, CSS, 생성된 JS 모두 HTTP 200. 주요 DOM ID, label, `aria-live`, 120자 입력 규칙을 확인했다.
- 실제 API/DB에서 빈 슬롯 응답, 이전 슬롯 승자 비노출, 첫 등록 WINNER/1등, 후속 등록 RANKED/2등, 승자 문구 보존, `INVALID_SLOT` 400, `ROUND_NOT_STARTED` 425, `ROUND_ENDED` 409를 확인했다.
- 등록 요청 6건 중 정상 성공 2건, 예상된 오류 응답 4건. 승자 1명, 순위 1~2, 중복·누락·승자 문구 변경 0건. Fastify의 본문 타입 자동 변환을 꺼서 숫자 문구를 `INVALID_REQUEST`로 거부하는 것도 확인했다.
- 프런트엔드 원본과 제공된 JS에서 단일 등록 fetch, 자동 재시도 없음, `textContent` 사용, 서버 시각 보정 로직, 제출 중 버튼 비활성화, 오류 상태 분기를 정적 검증했다.
- `npm run e2e`: Phase 1과 Phase 2 순차 실행 모두 통과.
- `npm run start`: 빌드한 서버 실행 후 `GET /health`와 `GET /` HTTP 200 확인.

아티팩트: `tests/e2e/artifacts/phase2-ticketing-ui.json`.

## 확인하지 못한 항목과 제한사항

브라우저 엔진을 통한 실제 DOM 이벤트·시각적 배치·정각 경계 전후 화면 전환은 자동 검증하지 않았다. E2E는 HTTP 응답, 정적 DOM/소스 계약, 실제 API와 PostgreSQL 동작을 검증했다. latency와 TPS는 측정하지 않았다.
