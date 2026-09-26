# HourBoard — 한시간동안 띄워드립니다

매 정각 가장 먼저 처리된 한 문구를 한 시간 동안 전광판에 표시하고, 모든 등록 요청에 서버·PostgreSQL 처리 기준 순위를 반환하는 서비스다. 현재 구현 상태는 **MVP (Phase 1 + Phase 2)**다.

## 사용자 흐름과 규칙

현재 전광판과 다음 정각까지의 남은 시간을 본다. 문구를 미리 입력하고 라운드가 시작되면 등록한다. 첫 등록은 1등이 되어 전광판을 차지하고, 이후 등록에는 2등부터 고유 순위가 주어진다. 문구는 다음 정각까지만 현재 전광판에 표시된다.

- 라운드는 매시 정각부터 1시간이다. API와 DB는 UTC, 화면 시각은 Asia/Seoul 기준이다.
- 순위는 클릭 시각이 아니라 서버와 PostgreSQL이 같은 슬롯 row를 처리한 순서다.
- 한 HTTP 등록 요청이 한 번의 도전이다. 사용자 계정과 이전 결과 복구는 없다.
- 문구는 trim 후 1~120자의 한 줄 일반 텍스트다. 공백만 있는 문구와 줄바꿈은 거부한다. HTML로 실행하지 않는다.
- 등록 결과가 유실되면 자동 재시도하지 않는다. 다시 등록하면 새 도전과 새 순위를 받는다.

## 기술 구성

Node.js 24 LTS, TypeScript, Fastify 5, PostgreSQL 18, HTML/CSS와 브라우저 TypeScript를 사용한다. Fastify가 API와 정적 UI를 함께 제공한다. 애플리케이션 시작 시 PostgreSQL connection pool을 만들고 재사용한다. 등록은 다음 단일 SQL의 결과로 승자와 순위를 정한다.

```sql
INSERT INTO hour_slots (slot_start, winner_message, attempt_count)
VALUES ($1, $2, 1)
ON CONFLICT (slot_start)
DO UPDATE SET attempt_count = hour_slots.attempt_count + 1
RETURNING attempt_count;
```

충돌한 요청은 `winner_message`를 수정하지 않는다. 같은 슬롯에 N건이 모두 성공하면 승자는 1명, 순위는 1..N, 중복·누락·승자 문구 변경은 0건이어야 한다.

## 로컬 실행

Node.js 24 LTS, npm, Docker Desktop/Compose가 필요하다. 아래 명령은 PowerShell 기준이다.

```powershell
npm install
docker compose up -d --wait
$env:NODE_ENV = 'development'
$env:PORT = '3000'
$env:DATABASE_URL = 'postgresql://hourboard:hourboard@127.0.0.1:5432/hourboard'
npm run db:migrate
npm run dev
```

`http://127.0.0.1:3000/`에서 화면을 열고 `/health`에서 DB 연결을 확인할 수 있다. `.env.example`은 로컬 설정 형식의 예시다. 앱은 `.env` 파일을 자동으로 읽지 않으므로 실행 셸에 `NODE_ENV`, `PORT`, `DATABASE_URL`을 설정해야 한다. 운영 DB credential 기본값은 없다.

빌드한 서버를 실행하려면 다음을 사용한다.

```powershell
npm run build
npm run start
```

프런트엔드 원본은 `src/client/app.ts`이고 `npm run build` 또는 `npm run build:client`가 `public/scripts/app.js`를 생성한다. `npm run dev`는 시작 시 클라이언트를 한 번 빌드한다.

## API

| 경로 | 내용 |
| --- | --- |
| `GET /health` | 앱·PostgreSQL 연결 상태 |
| `GET /api/round` | `serverTime`, 현재 슬롯의 시작·종료 시각과 승자 문구·등록 수, `nextSlotAt` |
| `POST /api/attempts` | `slotAt`(UTC 정각 ISO 8601), `message` 제출 |

등록 성공은 `slotAt`, `code`, `message`, `position`, `winner`를 반환한다. `position = 1`이면 `WINNER`/`true`, 2 이상이면 `RANKED`/`false`다. 오류는 `code`, `message`, `position: null`, `winner: false`를 반환한다. 오류 코드는 `INVALID_REQUEST`(400), `INVALID_SLOT`(400), `ROUND_ENDED`(409), `ROUND_NOT_STARTED`(425), `INTERNAL_ERROR`(500), `DATABASE_UNAVAILABLE`(503)다.

## E2E 검증

실제 Fastify 프로세스와 PostgreSQL을 사용한다. 로컬 개발 DB 연결 문자열을 설정한 뒤 `NODE_ENV=test`로 실행한다. 스크립트는 별도 `hourboard_e2e` DB를 만들고 해당 테스트 테이블을 초기화한다.

```powershell
$env:NODE_ENV = 'test'
npm run e2e
```

`npm run e2e:phase1`, `npm run e2e:phase2`로 각각 실행할 수도 있다. 결과 JSON은 `tests/e2e/artifacts/`에 저장된다. Phase 1은 같은 슬롯의 병렬 HTTP 요청 100건에서 승자·순위 불변식을 확인한다. Phase 2는 정적 UI 제공, DOM 계약, 실제 API/DB 흐름을 검증한다. 브라우저 엔진을 통한 시각적 렌더링은 자동 검증 범위에 포함하지 않는다.

## 프로젝트 문서와 범위

- `.project/plan.md`: 범위, 서비스 규칙, Phase 완료 기준
- `DESIGN.md`: 화면·상태·접근성 기준
- `docs/instructions/mvp.md`: MVP 구현 지침
- `docs/results/`: 완료된 Phase의 실제 검증 결과
- `AGENTS.md`: 저장소 작업 규칙

주요 구현은 `src/`, DB schema는 `db/migrations/`, 화면은 `public/`, E2E는 `tests/e2e/`에 있다. Phase 3 부하 테스트와 Phase 4 OCI 배포는 아직 시작하지 않았다.
