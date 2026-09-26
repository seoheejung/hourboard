# Phase 1 — Concurrency Core 결과

## 구현 범위

Fastify 5 API, 환경 변수 검증, 재사용 PostgreSQL pool, 현재 UTC 시간 슬롯 계산, `GET /health`, `GET /api/round`, `POST /api/attempts`, 입력 검증 및 오류 응답을 구현했다. Docker Compose의 공식 PostgreSQL 18 개발 DB와 SQL migration을 사용했다.

## 변경 파일

- `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.server.json`, `.env.example`, `compose.yaml`
- `db/migrations/001_create_hour_slots.sql`
- `src/config/env.ts`, `src/db/{pool,migrate,slots}.ts`, `src/services/slot-time.ts`, `src/schemas/api.ts`, `src/shared/types.ts`, `src/routes/{health,round,attempts}.ts`, `src/server.ts`
- `tests/e2e/run-e2e.ts`, `tests/e2e/artifacts/phase1-concurrency.json`

## DB schema와 핵심 SQL

`hour_slots`는 `slot_start TIMESTAMPTZ` 기본키, 승자 문구, `attempt_count BIGINT`, 생성 시각을 저장한다. `attempt_count >= 1`과 문구 길이 1~120자의 DB 제약을 적용했다. 등록은 `INSERT ... ON CONFLICT (slot_start) DO UPDATE SET attempt_count = hour_slots.attempt_count + 1 RETURNING attempt_count` 한 문장으로 처리한다. 충돌 시 `winner_message`는 갱신하지 않는다.

## 실행한 E2E와 결과

- `npm run build`: 통과.
- `npm run db:migrate`: 실제 로컬 PostgreSQL에 migration 적용 성공.
- `npm run e2e:phase1` (`NODE_ENV=test`, 로컬 PostgreSQL): 실제 Fastify 프로세스와 별도 `hourboard_e2e` DB 사용, 통과.
- 최초/후속 등록, `/health`, 빈 슬롯·승자 조회, 슬롯 전환 시 이전 승자 비노출, 잘못된 슬롯·미래 슬롯·종료 슬롯·빈 문구·공백 문구·121자 문구·줄바꿈 문구의 거부 및 DB 미기록을 확인했다.
- 동일 슬롯 병렬 HTTP 요청 100건: 성공 100건, 실패 0건, 승자 1명, 순위 1~100, 중복 0건, 누락 0건, 승자 문구 변경 0건. 성공 응답의 `code`·`position`·`winner` 일치를 확인했다.

아티팩트: `tests/e2e/artifacts/phase1-concurrency.json`.

## 제한사항

브라우저 UI와 등록 API 자동 재시도 금지는 Phase 2에서 검증한다. 지연 시간 백분위와 TPS는 측정하지 않았다.
