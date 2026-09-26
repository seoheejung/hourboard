# 등록 버튼 및 화면 후속 검증

검증일: 2026-09-27 (Asia/Seoul)

## 구현

- 현재 라운드를 등록 대상으로 고정했다. Winner 존재 여부는 버튼 활성 조건에 사용하지 않는다.
- 빈 문구, 공백만 있는 문구, 120자 초과, 줄바꿈, 요청 처리 중, 슬롯 시작 전과 종료 후에는 등록을 막는다.
- 전광판 문구를 한 줄로 흘려보내고, 데스크톱은 420px 카드형 화면, 모바일은 전체 너비 화면으로 구성했다.
- 제목을 `한 시간 동안 띄워드립니다`로 변경하고, 설명과 이용 안내 글씨를 줄였다.
- RANKED 결과에는 서버 응답의 순위 문장만 한 번 표시한다. 중복 순위와 보조 문장을 제거했다.
- WINNER 응답의 표시 기간 문구를 `작성하신 문구를 다음 정각까지 띄워드립니다.`로 수정했다.
- 클릭 가능한 로고, 파비콘, 페이지 제목과 설명, 맞춤 404 페이지를 추가했다.

## 실행 및 결과

| 검증 | 결과 |
| --- | --- |
| `npm run build` | 통과 |
| 실제 Fastify·PostgreSQL `npm run e2e` | Phase 1, Phase 2 통과 |
| 실제 Chrome·Fastify·PostgreSQL `node tests/e2e/run-button-browser-e2e.mjs` | 통과 |
| 화면 너비 320, 375, 390, 599, 600, 700, 768, 1024px | 문서 가로 넘침 없음, 제목 한 줄 |
| 390px 모바일 화면 | 입력창과 등록 버튼이 844px 높이 화면 안에 표시됨 |
| `/`, CSS, JS, 파비콘 | HTTP 200 |
| `/missing-page`, `/api/missing` | HTTP 404 |

브라우저 검증에서는 Winner가 없는 현재 라운드의 유효한 문구로 버튼이 활성화되고 최초 등록에 WINNER가 표시됐다. Winner가 있는 등록 Window 안에서도 버튼이 활성화됐고 다음 등록에 RANKED 2번째가 한 번만 표시됐다. 빈 문구, 공백만 있는 문구, 121자 문구의 버튼 비활성화와 요청 중 중복 클릭 차단도 확인했다.

최신 브라우저 아티팩트는 등록 Window 후속 검증을 포함한다. 현재 Round 요청 4건 중 성공 3건, 마감 거부 1건이며 Winner 1건, 순위 1~3, 중복·누락 순위와 Winner 문구 변형은 0건이다. 이전 Round Winner만 있는 fixture에서 새 Winner 1건도 확인했다. 슬롯 시작 전·시작 시점·종료 후 버튼 상태와 다음 정각 전환은 브라우저 시각을 조정해 확인했으며, 실제 정각까지 대기하지 않았다. 줄바꿈은 HTML 단일 행 입력창에 입력되지 않으며 서버 E2E에서 줄바꿈 요청 거부를 확인했다.

재실행 시 로컬 PostgreSQL을 준비하고 `NODE_ENV=test`, `DATABASE_URL`을 설정한다. Chrome을 DevTools Protocol을 켜고 실행한 뒤 `CHROME_CDP_URL`을 로컬 디버깅 주소로 설정한다. 브라우저 테스트는 전용 `hourboard_e2e` 데이터베이스의 `hour_slots`를 비운다.

## 아티팩트

- `tests/e2e/artifacts/phase1-concurrency.json`
- `tests/e2e/artifacts/phase2-ticketing-ui.json`
- `tests/e2e/artifacts/button-browser-flow.json`
- `tests/e2e/artifacts/button-ranked-mobile.png`
