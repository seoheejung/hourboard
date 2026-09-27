# Phase 4 OCI Deployment 진행 기록

**상태: 부분 진행 / Compute 생성 차단. Phase 4 완료 아님.**

2026-09-28 사용자 수동 OCI Console 확인 및 실행 결과를 기록한다. 아래 OCI 항목은 사용자가 확인해 전달한 사실이며, 저장소 작업자가 계정에서 다시 조회하거나 리소스를 변경한 결과가 아니다. 로컬 검증의 상세 기록은 [Local Gate 아티팩트](../../tests/e2e/artifacts/phase4-local-gate-summary.json), OCI 구조화 기록은 [OCI 아티팩트](../../tests/e2e/artifacts/phase4-oci-preflight.json)에 있다.

현재 상태: **Local Gate 수정·검증은 대부분 완료됐고 OCI 네트워크 및 재시도용 Terraform Stack까지 구성했으나, Tokyo A1 host capacity 부족으로 Compute 생성 단계에서 중단됐다.**

## Local Pre-Deployment Gate

- 카운트다운 밀리초 표시 제거 및 실제 브라우저 표시 확인 완료.
- #13 다른 브라우저의 Winner 반영 지연 재현 후 `/api/open-state` 기반 최소 수정 및 실제 브라우저 재검증 완료.
- #19 `/api/round`의 이전 Slot 응답을 실제 정각에서 재현하고 응답 전 Slot 재계산·1회 재조회로 수정. 수정 후 build와 기존 E2E는 통과했으나 **수정 후 실제 정각 경계 E2E는 미실시**.
- #20 PostgreSQL 잠금 대기를 이용한 10초 Window·정각 경계 검증 통과. atomic UPSERT, Winner·Position 의미, DB 최종 판정은 유지.
- Phase 3 로컬 baseline 및 이전 미완료 실행 폴더 5개는 변경하지 않음.

## 계정·무료 조건·선택한 VM

| 항목 | 사용자 수동 확인 결과 |
| --- | --- |
| 계정 | Free Trial |
| Home Region | Japan East (Tokyo) |
| Region identifier | `ap-tokyo-1` |
| Availability Domain | `AP-TOKYO-1-AD-1` |
| `standard-a1-core-count` | limit `Dynamic`, usage `0`, available `Dynamic` |
| `standard-a1-memory-count` | limit `Dynamic`, usage `0`, available `Dynamic` |
| Shape | `VM.Standard.A1.Flex`, Console의 `Always Free-eligible` 표시 확인 |
| 구성 | 1 OCPU, 6 GB RAM |
| Image | Canonical Ubuntu 24.04 Minimal aarch64, Free 표시 확인 |
| Boot Volume | 기본값 약 46.6 GB, 추가 Block Volume 없음 |
| Public IPv4 | 구성 화면에서 `Yes` |
| SSH | SSH public key를 Compute 구성에 등록; private key의 실제 로컬 보관은 미확인 |

OCI 생성 화면에는 예상 비용 `$0` 필드 자체가 없었다. 따라서 `$0` 수치를 확인했다고 기록하지 않는다. 사용자가 확인한 `Always Free-eligible` 표시, 1 OCPU·6 GB 구성, A1 usage `0`, Free 이미지, 추가 Block Volume 없음이 현재 무료 대상 판단 근거다. **예상 비용 필드의 부재는 현재 blocker가 아니다.**

## 생성된 OCI 리소스와 Compute 시도

사용자가 생성 완료를 확인한 리소스:

- `hourboard-vcn`: `10.0.0.0/16`
- public subnet `10.0.0.0/24`, private subnet `10.0.1.0/24`
- Internet Gateway, NAT Gateway, Service Gateway
- Route Tables, Security Lists
- Resource Manager Stack `instance-hourboard` (`Active`, Terraform 1.5.x). 기존 `hourboard-vcn`과 public subnet을 사용하도록 저장됨.

직접 `VM.Standard.A1.Flex` 생성은 `AP-TOKYO-1-AD-1`에서 **`Out of capacity for shape VM.Standard.A1.Flex`**로 실패했다. 반복 요청 과정에서는 **`Too many requests for the user`**도 발생했다.

Resource Manager Plan은 성공했으며 **`1 to add, 0 to change, 0 to destroy`**였다. Apply는 실제 실행됐으나 `Core Instance`의 `LaunchInstance`에서 **`500 InternalError: Out of host capacity`**로 실패했다. **Compute VM은 생성되지 않았다.**

현재 blocker는 무료 자격 미확인이 아니라 **Tokyo `AP-TOKYO-1-AD-1`의 A1 host capacity 부족**이다. 유료 Shape나 Tokyo 외 Region으로 전환하지 않는다. 생성된 네트워크 리소스와 Stack은 삭제·재생성하지 않는다.

## 이어서 할 작업

1. A1 capacity가 확보되면 Resource Manager → Stacks → `instance-hourboard`에서 Plan을 실행하고 `1 to add, 0 to change, 0 to destroy`를 확인한다.
2. 확인 뒤 Apply를 **1회** 재시도한다. capacity 부족이나 요청 제한이 다시 나오면 실패 사실을 기록하고 무리하게 반복하지 않는다.
3. VM 생성에 성공하면 SSH private key의 로컬 보관·접속 가능 여부를 **내용 열람 없이** 확인하고 Security List 및 외부 포트 규칙을 최종 점검한다.
4. 별도로 #19 수정 후 실제 정각 경계 E2E, 도메인 보유·DNS 변경 권한을 확인한다.
5. 그 다음 OS 시간 동기화, Node.js 24, PostgreSQL 18, migration·schema metadata, 운영 환경 파일·systemd·오류 로그, HTTPS, 외부 E2E, reboot recovery, 외부 latency를 실제로 검증한다.

VM이 없으므로 OS 설치부터 외부 성능 측정까지는 미검증이다. `docs/results/phase4-oci-deployment.md`는 Phase 4 완료 결과 문서이므로 아직 작성하지 않는다.
