# HourBoard Phase 3 — Load, Race & Open-State Verification 구현 지시서

> 대상: OpenAI Codex
>
> 목표: HourBoard MVP의 동시성 불변식과 첫 등록 후 10초 Registration Window 규칙을 유지한 상태에서 등록 race, 정각 open-state 전달 방식, polling/cache 효과, thundering herd를 실제 측정하고 반복 가능한 아티팩트로 남긴다.

---

## 0. 실행 모드

이 지시서는 **Phase 3만 수행하는 독립 작업 지시서**다.

작업 우선순위:

```text
사용자의 현재 명시적 지시
↓
.project/plan.md
↓
docs/instructions/phase3-load-race-verification.md
↓
AGENTS.md
↓
README.md
```

작업 시작 전에 반드시 아래 파일을 읽는다.

```text
.project/plan.md
AGENTS.md
README.md
docs/results/phase1-concurrency-core.md
docs/results/phase2-ticketing-ui.md
```

Phase 4 OCI 배포는 시작하지 않는다.

Phase 3 완료 후 실제 측정 결과를 문서화하고 로컬 commit 1개를 남긴 뒤 중단한다.

`git push`는 수행하지 않는다.

---

## 1. Phase 3 목표

Phase 3은 단순한 POST 부하 테스트가 아니다.

아래 네 영역을 분리해서 검증한다.

```text
3A. Registration Race
    → POST /api/attempts 동시 요청
    → Winner / Position / 10초 Registration Window 정합성
    → latency / RPS / PostgreSQL contention

3B. Open-State Delivery
    → Client Timer
    → Direct Polling
    → Cached Polling
    → origin traffic / 상태 전환 지연 비교

3C. Thundering Herd
    → 동일 시점에 대량 client 활성화
    → open-state 조회와 POST 집중
    → API / Pool / PostgreSQL 영향 측정

3D. Comparison
    → 방식별 측정값 비교
    → 병목과 trade-off 기록
```

현재 Phase의 목적은 **최적화 결론을 미리 정하는 것이 아니라 baseline을 만들고 실제 병목을 확인하는 것**이다.

---

## 2. 선행 조건

Phase 3을 시작하기 전에 기존 MVP가 아래 상태여야 한다.

```text
[ ] npm run build 성공
[ ] npm run e2e 성공
[ ] 실제 PostgreSQL 연결
[ ] README의 로컬 실행 절차 정상
[ ] GET /health 정상
[ ] GET /api/round 정상
[ ] POST /api/attempts 정상
```

10초 Registration Window도 이미 구현·검증되어 있어야 한다.

```text
Winner 없음
→ 최초 등록 허용
→ WINNER / position = 1

첫 등록 후 10초 이내
→ 후속 등록 허용
→ RANKED / position >= 2

첫 등록 후 10초 경과
→ 409 REGISTRATION_CLOSED
→ position = null
→ winner = false
```

위 규칙이 아직 구현되지 않았거나 기존 E2E에서 검증되지 않았다면 Phase 3에서 임의로 기존 등록 semantics를 재설계하지 않는다.

Phase 3 시작 전에 먼저 해당 MVP 수정 작업을 완료하고 검증한다.

---

## 3. 이번 작업에서 승인된 항목

### 승인

- k6 시나리오 작성
- k6 CLI 사용
- Phase 3 전용 Node.js 검증/오케스트레이션 script 작성
- Phase 3 전용 PostgreSQL test database 생성 및 삭제
- 기존 migration을 test database에 적용
- 실제 Fastify 서버를 test database와 연결해 실행
- PostgreSQL `pg_stat_activity`, `pg_locks` 조회
- Phase 3 전용 결과 파일 생성
- `package.json`의 Phase 3 실행 script 추가
- `GET /api/open-state` 추가
- `GET /api/open-state`에 shared-cache용 HTTP cache header 적용
- Phase 3 전용 local shared-cache proxy 작성
- open-state direct polling 시나리오 작성
- open-state cached polling 시나리오 작성
- thundering herd 시나리오 작성
- README의 실제 구현 상태 갱신
- `docs/results/phase3-load-race-verification.md` 생성
- Phase 3 완료 commit 1회

### 승인하지 않음

- Phase 4 OCI 리소스 생성
- production DB에 load test 수행
- production 서비스에 race test 수행
- Redis 도입
- Redis Sorted Set 기반 waiting room
- Kafka 도입
- Queue 도입
- WebSocket 도입
- SSE 도입
- 실제 Virtual Waiting Room 구현
- 실제 CDN 서비스 생성
- Cloudflare/Akamai/Fastly 등 외부 CDN 계정 작업
- ORM 도입
- 기존 Winner/Position 동시성 로직 재설계
- 등록 API 자동 retry 추가
- 사용자 계정/식별 기능 추가
- Grafana / InfluxDB / Prometheus 등 별도 관측 스택 도입
- k6 Cloud 사용
- 유료 서비스 사용
- 임의 성능 목표 수치 설정
- `git push`

Redis, Queue, Waiting Room은 이번 Phase의 비교 대상이 아니다.

HourBoard의 핵심 실험은 **동시에 들어온 등록 요청이 PostgreSQL의 동일 Slot row에서 경쟁하는 구조**다. 요청 순서를 앞단 Queue에서 먼저 결정하면 Phase 3의 핵심 race 실험을 바꾸므로 도입하지 않는다.

---

## 4. 시작 전 상태 확인

작업 시작 시 아래를 실행한다.

```text
git status
npm run build
npm run e2e
```

기존 MVP E2E가 실패하면 Phase 3을 시작하지 않는다.

기존 사용자 변경 사항을 임의로 되돌리지 않는다.

Phase 3 테스트로 기존 개발 DB 데이터를 오염시키지 않는다.

---

## 5. 테스트 환경 분리

Phase 3은 production 환경이 아닌 **전용 load-test database**에서 수행한다.

권장 이름:

```text
hourboard_loadtest
```

원칙:

- PostgreSQL 서버는 기존 로컬 Docker Compose 환경 사용 가능
- database만 별도 생성
- 기존 migration 적용
- 애플리케이션은 Phase 3 전용 `DATABASE_URL` 사용
- `NODE_ENV=test`
- 기존 개발 database의 `hour_slots` 삭제/truncate 금지
- 테스트 종료 후 database 유지/삭제 여부를 결과 문서에 기록

Phase 3 실행 중 API 서버와 PostgreSQL은 가능한 한 동일한 로컬 환경을 사용한다.

외부 인터넷 RTT를 local baseline에 섞지 않는다.

---

# 3A. Registration Race Verification

## 6. 측정 대상

동시에 등록을 시도하는 요청을 아래 네 단계로 측정한다.

```text
10
50
100
200
```

각 단계는 독립 실행한다.

각 단계 시작 전 Phase 3 test database의 현재 Slot row를 제거하여 Winner가 없는 상태에서 시작한다.

초기화는 Phase 3 test database에서만 허용한다.

각 단계는 동일 Slot row에 대한 순간 race를 만들어야 한다.

첫 정상 등록이 확정되는 순간부터 10초 Registration Window가 시작된다.

모든 N개 요청은 가능한 한 동시에 dispatch한다.

테스트 코드 자체의 순차 처리, 인위적 sleep, 요청 간 지연 때문에 일부 요청이 의도치 않게 10초 Window 밖에서 시작되지 않도록 한다.

---

## 7. Race 응답 분류

각 run의 응답은 반드시 아래 네 값으로 분리한다.

```text
requested
accepted
registrationClosed
unexpectedFailed
```

정의:

```text
accepted
= 200 WINNER 또는 200 RANKED

registrationClosed
= 409 REGISTRATION_CLOSED

unexpectedFailed
= ROUND_NOT_STARTED
  ROUND_ENDED
  INVALID_SLOT
  INVALID_REQUEST
  INTERNAL_ERROR
  DATABASE_UNAVAILABLE
  network error
  기타 예상하지 못한 결과
```

`REGISTRATION_CLOSED`는 technical error와 같은 값으로 합치지 않는다.

10초 Window 안에 실제로 처리되지 못한 요청이 얼마나 발생했는지를 보여주는 business rejection으로 별도 기록한다.

---

## 8. Round 안전 조건

테스트 시작 전에 `GET /api/round`를 호출해 서버 시각과 현재 Slot을 확인한다.

권장 최소 안전 구간:

```text
현재 Round 종료까지 30초 이상
```

30초는 아래 시간을 확보하기 위한 Phase 3 실행 조건이다.

```text
첫 등록
→ 10초 Registration Window
→ 결과 수집
→ artifact 저장 준비
```

이 값은 서비스 정책이 아니다.

각 run 시작 전 현재 Slot에 Winner가 없는지 확인한다.

Phase 3 test database의 해당 Slot row가 존재하면 제거한 뒤 다시 확인한다.

부하 실행 도중 Round가 바뀌면 해당 결과는 baseline에서 제외하고 실패한 실행으로 기록한다.

---

## 9. k6 Registration Race 시나리오

`k6/scenarios/` 아래에 Phase 3 전용 race 시나리오를 작성한다.

권장 구조:

```text
k6/
├─ scenarios/
│  ├─ phase3-race.js
│  ├─ phase3-open-state-direct.js
│  ├─ phase3-open-state-cached.js
│  └─ phase3-thundering-herd.js
└─ results/
   └─ phase3/
```

Registration Race는 N개의 VU가 각각 1회 등록 요청을 보내는 형태로 구성한다.

권장 executor 의미:

```text
per-vu-iterations
vus = N
iterations = 1
```

10 / 50 / 100 / 200은 동일 스크립트를 환경 변수로 재사용한다.

예상 환경 변수:

```text
BASE_URL
CONCURRENCY
SLOT_AT
MESSAGE_PREFIX
SUMMARY_PATH
```

localhost, port, slotAt을 스크립트에 하드코딩하지 않는다.

---

## 10. Registration Race 요청 규칙

각 VU는 고유한 plain-text 문구를 생성한다.

```text
phase3-100-vu-001
phase3-100-vu-002
...
```

현재 API 계약을 그대로 사용한다.

```json
{
  "slotAt": "2026-09-27T01:00:00.000Z",
  "message": "phase3-100-vu-001"
}
```

정상 race 시나리오에서 모든 요청은 현재 활성 Slot을 대상으로 한다.

정상 응답:

```text
200 WINNER
200 RANKED
409 REGISTRATION_CLOSED
```

정상 race에서 예상하지 않는 응답:

```text
ROUND_NOT_STARTED
ROUND_ENDED
INVALID_SLOT
INVALID_REQUEST
INTERNAL_ERROR
DATABASE_UNAVAILABLE
network error
```

---

## 11. Position 정합성 검증

성능 측정과 응답 정합성 검증을 분리한다.

각 concurrency 단계에서 아래 두 실행을 수행한다.

```text
A. Race integrity run
B. k6 performance run
```

### A. Race integrity run

Node.js 기반 검증 script로 N개의 실제 HTTP request를 가능한 한 동시에 보낸다.

모든 response body를 수집한다.

accepted 요청 수를 `S`라고 할 때 아래가 성립해야 한다.

```text
S >= 1
winner count among accepted = 1
positions among accepted = 1..S
duplicate position = 0
missing position = 0
winner message mutation = 0
```

응답 조합:

```text
position = 1
→ code = WINNER
→ winner = true

position >= 2
→ code = RANKED
→ winner = false

REGISTRATION_CLOSED
→ HTTP 409
→ position = null
→ winner = false
```

`REGISTRATION_CLOSED` 요청은 Position을 소비하면 안 된다.

예:

```text
requested = 200
accepted = 173
registrationClosed = 27

정상 accepted positions = 1..173
position 174 이상 존재 금지
REGISTRATION_CLOSED 응답에 position 존재 금지
```

모든 요청이 10초 이내 처리되어 `registrationClosed = 0`이라면 기존과 같이 Position은 `1..N`이어야 한다.

### B. k6 performance run

동일 concurrency 단계에서 Slot row를 다시 초기화한 뒤 k6를 실행한다.

성능 run은 아래 측정에 사용한다.

```text
latency
RPS
accepted
registrationClosed
unexpectedFailed
```

---

## 12. Winner 문구 불변 검증

각 integrity run 종료 후 `GET /api/round` 또는 DB 조회로 현재 Winner 문구를 확인한다.

Position 1 요청의 문구와 실제 `winner_message`가 일치해야 한다.

Position 2 이후 accepted 요청의 문구로 변경되면 실패다.

`REGISTRATION_CLOSED` 요청의 문구로 변경되어도 실패다.

Registration Window가 닫힌 뒤에도 Winner 문구는 현재 Round 종료 전까지 유지되어야 한다.

---

## 13. Registration Race 측정 지표

각 단계에서 최소 아래를 기록한다.

```text
concurrency
requested
accepted
registrationClosed
unexpectedFailed
acceptanceRate
unexpectedErrorRate
RPS
p50Ms
p95Ms
p99Ms
minMs
maxMs
```

계산:

```text
acceptanceRate = accepted / requested
unexpectedErrorRate = unexpectedFailed / requested
```

`REGISTRATION_CLOSED`는 `unexpectedErrorRate`에 포함하지 않는다.

k6 `http_req_duration`에서 최소 아래 통계를 기록한다.

```text
med
p(95)
p(99)
min
max
```

문서에서는 `med`를 p50으로 표기할 수 있다.

RPS는 실제 k6 `http_reqs` rate를 사용한다.

built-in `http_req_failed`만으로 business rejection과 기술 실패를 구분했다고 가정하지 않는다.

필요하면 custom Counter/Rate 또는 response code 검증으로 분리한다.

---

# 3B. Open-State Delivery Verification

## 14. 목적

정각 전후의 버튼 활성 상태를 브라우저에 전달하는 방법을 비교한다.

비교 대상:

```text
Mode A — Client Timer
Mode B — Direct Polling
Mode C — Cached Polling
```

특정 방식을 미리 정답으로 가정하지 않는다.

아래 값을 실제 측정한다.

```text
client request count
origin request count
origin RPS
p50 / p95 / p99
unexpected error rate
open-state detection delay
cache suppression ratio
```

---

## 15. `GET /api/open-state`

Phase 3에서 open-state 전달 실험을 위해 최소 조회 endpoint를 추가한다.

목적은 전광판 전체 데이터를 다시 전달하는 것이 아니라 **등록 가능 상태만 가볍게 조회하는 것**이다.

권장 응답:

```json
{
  "serverTime": "2026-09-27T01:00:05.120Z",
  "slotAt": "2026-09-27T01:00:00.000Z",
  "roundEndsAt": "2026-09-27T02:00:00.000Z",
  "winnerExists": true,
  "registrationOpen": true,
  "registrationClosesAt": "2026-09-27T01:00:10.420Z"
}
```

Winner가 없을 때:

```json
{
  "serverTime": "2026-09-27T01:00:00.120Z",
  "slotAt": "2026-09-27T01:00:00.000Z",
  "roundEndsAt": "2026-09-27T02:00:00.000Z",
  "winnerExists": false,
  "registrationOpen": true,
  "registrationClosesAt": null
}
```

등록 마감 후:

```json
{
  "serverTime": "2026-09-27T01:00:11.000Z",
  "slotAt": "2026-09-27T01:00:00.000Z",
  "roundEndsAt": "2026-09-27T02:00:00.000Z",
  "winnerExists": true,
  "registrationOpen": false,
  "registrationClosesAt": "2026-09-27T01:00:10.420Z"
}
```

이 endpoint는 **UI 힌트**다.

최종 등록 허용 여부는 항상 `POST /api/attempts`에서 서버와 PostgreSQL이 다시 판정한다.

클라이언트가 `registrationOpen = true`를 보았다는 사실만으로 등록 성공을 보장하지 않는다.

---

## 16. Open-State cache header

`GET /api/open-state`는 shared cache에서 짧게 재사용할 수 있도록 설계한다.

권장 의미:

```http
Cache-Control: public, max-age=0, s-maxage=1
```

원칙:

- private browser cache를 장시간 신뢰하지 않음
- shared cache는 1초 수준의 짧은 TTL 실험
- `Set-Cookie` 추가 금지
- 사용자별 데이터 포함 금지
- 인증 정보 기반 응답으로 만들지 않음
- query timestamp 기반 cache busting을 cached mode에서 사용하지 않음

`serverTime`이 cache될 수 있다는 사실을 반드시 고려한다.

cached response의 `serverTime`을 millisecond 단위 authoritative clock으로 재사용하지 않는다.

정밀 countdown의 기준은 기존 `/api/round`에서 받은 server offset 또는 별도 동기화 결과를 사용한다.

`/api/open-state`의 목적은 **등록 가능 상태 전파 실험**이다.

---

## 17. Mode A — Client Timer

흐름:

```text
GET /api/round
→ serverTime 수신
→ client/server offset 계산
→ local monotonic timer 사용
→ 정각 도달 시 버튼 활성
```

이 Mode에서는 정각 전 매초 상태 API를 호출하지 않는다.

측정:

```text
초기 API request 수
정각 직전 origin RPS
정각 활성화 계산 오차
추가 backend traffic
```

제약도 기록한다.

다른 사용자가 Winner가 되어 10초 Registration Window가 시작된 사실은 client timer만으로 즉시 알 수 없다.

따라서 client timer는 **정각 시작 시점 계산에는 적합하지만 원격 Winner 발생에 따른 Registration Window 상태 동기화를 완전히 대체하지 못한다.**

이 한계를 결과 문서에 기록한다.

---

## 18. Mode B — Direct Polling

client들이 일정 간격으로 origin의 `GET /api/open-state`를 직접 호출한다.

Phase 3 direct polling run에서는 local shared-cache proxy를 통과하지 않는다.

권장 polling interval 후보:

```text
1000ms
500ms
```

처음에는 1000ms로 baseline을 만들고 필요성이 확인될 때만 500ms를 추가한다.

측정:

```text
virtual clients
poll interval
client request count
origin request count
origin RPS
p50 / p95 / p99
unexpected error rate
open-state detection delay
```

timestamp query를 매 요청마다 붙여 cache busting하는 방식은 direct polling에서만 실험 필요성이 있을 경우 사용한다.

기본 direct run에서는 origin에 직접 접근하므로 불필요한 query mutation을 추가하지 않는다.

---

## 19. Mode C — Cached Polling

동일 `GET /api/open-state`를 Phase 3 전용 local shared-cache proxy를 통해 호출한다.

목적은 실제 CDN 제품 성능을 재현하는 것이 아니다.

목적:

```text
동일한 짧은 TTL 응답을 shared cache가 재사용할 때
origin request가 얼마나 줄어드는지 검증
```

local shared-cache proxy는 외부 dependency 없이 Node.js 표준 API로 구현할 수 있다.

별도 npm cache package를 추가하지 않는다.

최소 동작:

```text
client request
→ cache key 확인
→ fresh cache 존재
   → cached response 반환
→ cache miss
   → origin GET /api/open-state
   → TTL 기준 저장
   → client 반환
```

기본 TTL:

```text
1 second
```

cache key는 endpoint와 실제 상태를 구분하는 데 필요한 최소 값만 사용한다.

cached polling에서는 아래를 금지한다.

```text
timestamp cache busting
매 요청마다 unique query parameter
Cache-Control: no-store 강제
```

측정:

```text
client request count
origin request count
cacheHitCount
cacheMissCount
cacheSuppressionRatio
origin RPS
client-observed p50 / p95 / p99
open-state detection delay
```

계산:

```text
cacheSuppressionRatio
= 1 - (origin request count / client request count)
```

실제 CDN/Edge에서의 latency 또는 cache hit ratio라고 표현하지 않는다.

Phase 3 결과는 **local shared-cache simulation**으로 명시한다.

실제 외부 CDN/Edge 검증은 Phase 4 이후 별도 인프라 범위다.

---

## 20. Open-State 부하 단계

Registration Race와 open-state polling의 concurrency 숫자를 섞지 않는다.

Registration Race:

```text
10
50
100
200
```

Open-State Delivery:

```text
100
500
1000
```

각 client는 일정 시간 polling한다.

권장 baseline duration:

```text
10 seconds
```

Mode B와 Mode C는 동일 client 수, 동일 polling interval, 동일 duration으로 비교한다.

한 번에 하나의 변수만 바꾼다.

---

## 21. Open-State detection delay

상태가 서버에서 바뀐 시점과 client가 해당 변화를 처음 관찰한 시점의 차이를 측정한다.

최소 두 전환을 구분한다.

```text
Round start
→ registrationOpen = true

Registration Window close
→ registrationOpen = false
```

가능한 경우 첫 Winner 발생에 따른 전환도 기록한다.

```text
winnerExists: false → true
registrationClosesAt: null → timestamp
```

Mode A / B / C의 detection delay를 각각 기록한다.

cached polling에서는 TTL로 인해 최대 수백 ms ~ 약 1초 수준의 지연이 생길 수 있지만 이를 미리 결과값으로 가정하지 않는다.

실제 측정값만 기록한다.

---

# 3C. Thundering Herd Verification

## 22. 목적

많은 client가 같은 시점에 상태를 인지하고 등록 요청을 보내는 상황을 재현한다.

두 단계로 나눈다.

```text
1. open-state 인지 집중
2. POST /api/attempts 집중
```

Thundering Herd 실험은 Queue로 트래픽을 평탄화하지 않는다.

현재 HourBoard의 실제 race 구조를 그대로 관찰한다.

---

## 23. 재현 방식

반복 가능한 synthetic barrier를 사용한다.

```text
N clients 준비
→ 공통 start barrier 대기
→ barrier release
→ 동시에 POST /api/attempts
```

실제 매시 정각을 기다리는 방식만 사용하지 않는다.

실제 정각 관찰을 추가할 수는 있지만 repeatable baseline의 필수 조건으로 사용하지 않는다.

synthetic barrier run에서도 서버가 허용하는 현재 Slot을 사용하며 Phase 3 test database의 Slot row를 초기화한 뒤 실행한다.

---

## 24. Thundering Herd 시나리오

최소 아래 단계를 실행한다.

```text
10
50
100
200
```

각 단계에서 측정:

```text
dispatch spread
requested
accepted
registrationClosed
unexpectedFailed
RPS
p50 / p95 / p99
connection pool 대기 징후
PostgreSQL lock waiter
Winner
Position
Winner mutation
```

가능하면 client request dispatch 시각 분산도 기록한다.

```text
first dispatch timestamp
last dispatch timestamp
dispatch spread ms
```

테스트 도구가 200개 요청을 실제로 얼마나 좁은 시간 범위에 발생시켰는지 확인하기 위한 값이다.

---

# PostgreSQL / Pool 관찰

## 25. PostgreSQL contention 관찰

Phase 3에서는 PostgreSQL의 실제 대기 상태를 관찰한다.

별도 observability stack을 추가하지 않는다.

최소 조회:

```text
pg_stat_activity
pg_locks
```

Phase 3 전용 monitor script를 작성해 load run 중 snapshot을 수집할 수 있다.

관찰 후보:

```text
timestamp
activeConnections
lockWaitingConnections
waitEventTypes
ungrantedLocks
```

sampling interval은 DB에 과도한 관측 부하를 추가하지 않도록 한다.

권장 시작값:

```text
50~100ms
```

실제 interval은 결과 문서에 기록한다.

관찰 query 자체가 측정 결과에 영향을 줄 수 있음을 명시한다.

---

## 26. Connection Pool 관찰

현재 application pool 설정을 측정 전 임의 변경하지 않는다.

200 동시 요청에서 latency가 증가하더라도 바로 PostgreSQL row lock 때문이라고 단정하지 않는다.

병목 후보:

```text
Node.js event loop
Fastify request processing
pg Pool wait
PostgreSQL row/transaction lock
CPU
Docker Desktop
local shared-cache proxy
```

측정값으로 확인하지 못한 원인을 사실처럼 기록하지 않는다.

---

# 성능 측정 정책

## 27. Threshold 정책

Phase 3은 baseline 생성 Phase다.

근거 없는 수치를 만들지 않는다.

금지:

```text
p95 < 100ms
p99 < 200ms
RPS > 1000
cache hit > 99%
```

Hard pass/fail 기준:

```text
accepted 요청의 Position 정합성 위반
Winner 0명 또는 2명 이상
Winner 문구 mutation
REGISTRATION_CLOSED가 Position을 소비
Registration Window 종료 후 accepted 처리
예상하지 못한 4xx/5xx
network error
open-state contract 위반
artifact 생성 실패
```

느린 성능이나 낮은 acceptance rate는 baseline 사실로 기록한다.

---

## 28. 측정값과 해석 분리

결과 문서는 아래 순서를 따른다.

```text
관측 사실
→ 가능한 원인
→ 확인 근거
→ 확인하지 못한 부분
```

예:

```text
Concurrency 200에서 p95 증가와 registrationClosed 27건 발생
→ 일부 request가 firstRegisteredAt + 10초 이후 DB write 단계에 도달
→ REGISTRATION_CLOSED 응답 확인
→ 같은 시점에 lock waiter 증가
→ pool wait를 직접 계측하지 않았다면 row lock만이 유일 원인이라고 단정하지 않음
```

또 다른 예:

```text
Cached Polling 1000 clients에서 client request는 10,000건이었지만 origin request는 크게 감소
→ local shared-cache가 동일 1초 TTL response 재사용
→ cacheHitCount / cacheMissCount 확인
→ 실제 CDN 환경에서도 동일 수치가 나온다고 주장하지 않음
```

---

# 결과 아티팩트

## 29. Artifact 구조

권장 구조:

```text
k6/results/phase3/
├─ registration-race/
│  ├─ concurrency-010/
│  │  ├─ integrity.json
│  │  ├─ k6-summary.json
│  │  └─ postgres-locks.json
│  ├─ concurrency-050/
│  ├─ concurrency-100/
│  └─ concurrency-200/
├─ open-state/
│  ├─ client-timer.json
│  ├─ direct-polling-100.json
│  ├─ direct-polling-500.json
│  ├─ direct-polling-1000.json
│  ├─ cached-polling-100.json
│  ├─ cached-polling-500.json
│  └─ cached-polling-1000.json
├─ thundering-herd/
│  ├─ concurrency-010.json
│  ├─ concurrency-050.json
│  ├─ concurrency-100.json
│  └─ concurrency-200.json
└─ baseline-summary.json
```

실제 구현 구조에 맞춰 최소 조정할 수 있다.

---

## 30. Registration integrity artifact

최소 필드:

```json
{
  "concurrency": 200,
  "requested": 200,
  "accepted": 173,
  "registrationClosed": 27,
  "unexpectedFailed": 0,
  "winnerCount": 1,
  "minPosition": 1,
  "maxPosition": 173,
  "duplicatePositions": 0,
  "missingPositions": 0,
  "winnerMessageMutations": 0
}
```

실제 측정하지 않은 값을 만들지 않는다.

---

## 31. Open-State artifact

최소 필드:

```json
{
  "mode": "cached-polling",
  "virtualClients": 1000,
  "pollIntervalMs": 1000,
  "durationSeconds": 10,
  "clientRequestCount": 10000,
  "originRequestCount": null,
  "cacheHitCount": null,
  "cacheMissCount": null,
  "cacheSuppressionRatio": null,
  "openDetectionDelayMs": null,
  "p50Ms": null,
  "p95Ms": null,
  "p99Ms": null,
  "unexpectedFailed": null
}
```

실제 측정값으로 교체한다.

측정하지 않은 필드는 `null` 또는 생략한다.

---

## 32. baseline-summary.json

최소 구조:

```json
{
  "environment": {
    "runtime": "Node.js 24 LTS",
    "database": "PostgreSQL 18.x",
    "target": "local",
    "registrationWindowSeconds": 10,
    "sharedCacheTtlMs": 1000,
    "measuredAt": "..."
  },
  "registrationRace": [],
  "openState": {
    "clientTimer": {},
    "directPolling": [],
    "cachedPolling": []
  },
  "thunderingHerd": []
}
```

환경 정보에 가능한 범위에서 추가:

```text
OS
CPU
memory
Docker Desktop 여부
PostgreSQL container resource limit 여부
Node.js version
k6 version
```

---

# 실행 순서

## 33. 전체 실행 순서

```text
1. git status
2. npm run build
3. npm run e2e
4. Phase 3 test database 준비
5. migration 적용
6. Phase 3 API 서버 시작
7. GET /health
8. GET /api/round
9. 10초 Registration Window 동작 재확인

10. Registration Race integrity 10
11. Registration Race k6 10
12. Registration Race integrity 50
13. Registration Race k6 50
14. Registration Race integrity 100
15. Registration Race k6 100
16. Registration Race integrity 200
17. Registration Race k6 200

18. Client Timer baseline
19. Direct Polling 100
20. Direct Polling 500
21. Direct Polling 1000

22. local shared-cache proxy 시작
23. Cached Polling 100
24. Cached Polling 500
25. Cached Polling 1000
26. local shared-cache proxy 종료

27. Thundering Herd 10
28. Thundering Herd 50
29. Thundering Herd 100
30. Thundering Herd 200

31. baseline-summary.json 생성
32. 결과 문서 작성
33. README 갱신
34. Phase 3 commit
```

Registration Race의 이전 단계에서 정합성 invariant가 실패하면 더 높은 단계로 진행하지 않는다.

`registrationClosed > 0`만으로 다음 단계 진행을 막지 않는다.

---

## 34. 실패 처리

Phase 3 실패:

```text
accepted 요청이 1건도 없음
accepted Winner 0명 또는 2명 이상
accepted Position 중복
accepted Position 누락
Winner 문구 mutation
REGISTRATION_CLOSED가 Position 소비
REGISTRATION_CLOSED에서 winner = true
Registration Window 종료 후 accepted 처리
정상 race에서 ROUND_NOT_STARTED / ROUND_ENDED / INVALID_SLOT
예상하지 못한 4xx/5xx
network error
DB 연결 실패
open-state contract 위반
cached mode에서 cache key 오류로 잘못된 Slot 상태 반환
Round 경계가 테스트 중 발생
artifact 생성 실패
```

`REGISTRATION_CLOSED` 자체는 실패가 아니다.

느린 결과도 실패가 아니다.

측정된 사실로 기록한다.

---

# 결과 문서

## 35. `docs/results/phase3-load-race-verification.md`

최소 포함:

```text
실행 환경
Registration Window: 10초
PostgreSQL test database 구성

Registration Race
- 10 / 50 / 100 / 200
- requested / accepted / registrationClosed / unexpectedFailed
- Winner / Position invariant
- p50 / p95 / p99
- RPS
- PostgreSQL contention

Open-State Delivery
- Client Timer
- Direct Polling
- Cached Polling
- virtual clients
- polling interval
- client request count
- origin request count
- cache suppression ratio
- detection delay
- p50 / p95 / p99

Thundering Herd
- 10 / 50 / 100 / 200
- dispatch spread
- latency
- accepted / registrationClosed
- pool / DB contention

확인된 병목
확인하지 못한 원인
local shared-cache simulation의 한계
artifact 경로
재실행 명령
Phase 4에 넘길 baseline
```

실제 측정값만 사용한다.

실제 CDN에서 측정하지 않았다면 CDN 성능이라고 표현하지 않는다.

---

## 36. README 갱신

Phase 3이 실제 완료된 경우에만 README 상태를 갱신한다.

```text
Phase 1 — Concurrency Core: 완료
Phase 2 — Ticketing UI: 완료
Phase 3 — Load, Race & Open-State Verification: 완료
Phase 4 — OCI Deployment: 예정
```

README에 모든 raw 측정값을 복사하지 않는다.

대표 baseline과 결과 문서 위치만 기록한다.

---

# 완료 기준

## 37. Phase 3 완료 체크리스트

```text
[ ] 기존 MVP build 성공
[ ] 기존 MVP E2E 통과
[ ] 10초 Registration Window E2E 통과
[ ] Phase 3 test database 분리
[ ] k6 CLI 버전 기록

[ ] Registration Race 10 integrity
[ ] Registration Race 10 k6
[ ] Registration Race 50 integrity
[ ] Registration Race 50 k6
[ ] Registration Race 100 integrity
[ ] Registration Race 100 k6
[ ] Registration Race 200 integrity
[ ] Registration Race 200 k6

[ ] 각 race 단계 accepted >= 1
[ ] 각 race 단계 accepted Winner 1명
[ ] 각 race 단계 accepted Position 1..S
[ ] duplicate Position 0
[ ] missing Position 0
[ ] Winner message mutation 0
[ ] REGISTRATION_CLOSED Position 미소비
[ ] REGISTRATION_CLOSED winner = false

[ ] GET /api/open-state 구현
[ ] open-state response contract 검증
[ ] Client Timer baseline
[ ] Direct Polling 100
[ ] Direct Polling 500
[ ] Direct Polling 1000
[ ] local shared-cache proxy 구현
[ ] Cached Polling 100
[ ] Cached Polling 500
[ ] Cached Polling 1000
[ ] cached polling origin request count 기록
[ ] cache hit/miss 기록
[ ] cache suppression ratio 기록
[ ] open-state detection delay 기록

[ ] Thundering Herd 10
[ ] Thundering Herd 50
[ ] Thundering Herd 100
[ ] Thundering Herd 200
[ ] dispatch spread 기록

[ ] 각 주요 시나리오 p50 기록
[ ] 각 주요 시나리오 p95 기록
[ ] 각 주요 시나리오 p99 기록
[ ] Registration Race RPS 기록
[ ] 예상하지 못한 오류율 기록
[ ] PostgreSQL contention snapshot 존재

[ ] baseline-summary.json 생성
[ ] docs/results/phase3-load-race-verification.md 생성
[ ] README 실제 구현 상태 갱신
```

여기서 `S`는 해당 run에서 `WINNER` 또는 `RANKED`로 accepted 된 요청 수다.

체크되지 않은 항목은 완료로 표현하지 않는다.

---

## 38. npm scripts

기존 script를 깨지 않는다.

필요한 경우 아래 목적의 script를 추가한다.

```text
npm run load:prepare
npm run load:verify
npm run load:race
npm run load:open-state
npm run load:herd
npm run load:phase3
```

명칭은 실제 구조에 맞게 최소 조정 가능하다.

가능하면 `npm run load:phase3` 하나로 전체 Phase 3을 재실행할 수 있게 한다.

---

## 39. Git 처리

작업 시작 전:

```text
git status
```

Phase 3 완료 후 commit:

```text
feat: phase3-load-race-verification
```

Phase 4 작업을 commit에 포함하지 않는다.

`git push`는 수행하지 않는다.

---

## 40. 범위 외

```text
Redis
Redis Sorted Set
Kafka
Queue
Virtual Waiting Room
WebSocket
SSE
멀티 인스턴스 API
DB 분리 서버
OCI 배포
실제 CDN 서비스 구성
Grafana
InfluxDB
Prometheus
실시간 dashboard
CI load test
자동 성능 회귀 차단
임의 SLO
사용자 기능 추가
```

이 항목은 Phase 3 결과에서 실제 필요성이 확인되더라도 바로 구현하지 않는다.

기획 변경 후 별도 Phase로 다룬다.

---

## 41. 최종 보고

작업 종료 시 아래 구조로 보고한다.

```text
## 작업 상태
- Phase 3 완료 / 부분 완료

## 측정 환경
- Node.js
- PostgreSQL
- k6
- OS / CPU / memory
- Registration Window: 10초
- Shared Cache TTL

## Registration Race
- concurrency 10
- concurrency 50
- concurrency 100
- concurrency 200
- requested / accepted / registrationClosed / unexpectedFailed

## Open-State Delivery
- Client Timer
- Direct Polling
- Cached Polling
- client request / origin request
- cache suppression ratio
- detection delay

## Thundering Herd
- 10 / 50 / 100 / 200
- dispatch spread
- latency
- contention

## 정합성
- Winner
- accepted Position
- REGISTRATION_CLOSED Position 미소비
- Winner mutation

## 성능
- p50 / p95 / p99
- RPS
- acceptance rate
- unexpected error rate

## PostgreSQL
- lock/contention 관찰 결과

## Artifact
- 실제 경로

## 문서
- docs/results/phase3-load-race-verification.md

## Git
- commit hash
- working tree
- push 수행 여부: 수행하지 않음
```

측정하지 않은 값을 보고하지 않는다.

---

# 최종 명령

추가 계획 확인이나 중간 승인 요청 없이 Phase 3 범위 안에서 작업을 시작한다.

**기존 MVP와 첫 등록 후 10초 Registration Window 동작을 먼저 검증한다. Registration Race 10 → 50 → 100 → 200을 수행한 뒤 Client Timer, Direct Polling, Cached Polling의 open-state 전달 비용과 상태 전환 지연을 비교하고, 마지막으로 Thundering Herd를 재현한다. 모든 결과에서 실제 측정값과 정합성만 기록하고 반복 가능한 artifact와 결과 문서를 생성한 뒤 Phase 3 commit을 남긴다.**

Phase 4 작업은 시작하지 않는다.

`git push`는 수행하지 않는다.
