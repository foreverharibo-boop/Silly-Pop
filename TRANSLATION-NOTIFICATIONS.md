# Silly-Pop APK · 서버 번역 완료 알림 실험판

기존 답장 알림에 더해, 베르바·베에르으바아의 서버 자동번역이 끝나면 한 번 더 알립니다. 기본값은 OFF입니다. 폰에 설치한 APK는 다시 설치하지 않습니다.

| 대상 | 이번 버전 |
| --- | --- |
| Silly-Pop 웹 확장 | 1.5.8 |
| Silly-Pop 서버 플러그인 | 2.4.6 |
| 베르바 웹 확장 | 0.6.54 |
| 베에르으바아 웹 확장 | 0.6.32 |
| 공용 Verba Server | 0.1.2 |

모두 `codex/server-translation-experimental` 브랜치에만 적용했습니다. 일반 배포판에서 업데이트 버튼만 눌러서는 이 기능이 설치되지 않습니다. 번역기는 사용하는 쪽만 업데이트하면 됩니다. 공용 서버는 한 번만 설치합니다.

## 업데이트 방법

이미 서버 번역 실험판과 Silly-Pop APK를 연결해서 쓰는 경우입니다. **실리태번 서버를 종료한 뒤** 터먹스에서 진행합니다. 아래 예시는 실리태번이 `$HOME/SillyTavern`에 설치된 경우이며, 다른 위치라면 경로를 바꿉니다.

### 1. Silly-Pop 서버

```bash
git -C "$HOME/SillyTavern/plugins/Silly-Pop" fetch origin refs/heads/codex/server-translation-experimental:refs/remotes/origin/codex/server-translation-experimental &&
git -C "$HOME/SillyTavern/plugins/Silly-Pop" switch codex/server-translation-experimental &&
git -C "$HOME/SillyTavern/plugins/Silly-Pop" pull --ff-only origin codex/server-translation-experimental
```

로컬 수정 때문에 전환이 거절되면 중단하고 확인합니다. 강제 초기화하지 않습니다.

### 2. 공용 Verba Server

기존 설치 여부와 관계없이 아래 명령어를 실행합니다. 새 파일을 내려받고 기존 폴더의 프로그램 파일만 교체합니다. 폴더 삭제·백업은 필요 없습니다. 두 번역기에 공통이므로 한 번만 실행합니다.

```bash
(
  set -e
  verba_source_dir="$(mktemp -d "$HOME/verba-update.XXXXXX")"
  git clone --depth 1 --branch codex/server-translation-experimental https://github.com/foreverharibo-boop/verba.git "$verba_source_dir/source"
  bash "$verba_source_dir/source/install-server.sh" "$HOME/SillyTavern"
)
```

자세한 설정은 [서버 번역 안내](https://github.com/foreverharibo-boop/verba/blob/codex/server-translation-experimental/SERVER.md)를 참고합니다.

### 3. 웹 확장

Silly-Pop 웹 확장도 같은 실험판 브랜치로 전환해야 합니다. 아래 `silly_pop_extension_dir`에 **실제로 설치된 웹 확장 폴더**를 넣습니다. 서버 플러그인 폴더와는 다릅니다.

```bash
silly_pop_extension_dir="$HOME/SillyTavern/data/default-user/extensions/Silly-Pop"
git -C "$silly_pop_extension_dir" fetch origin refs/heads/codex/server-translation-experimental:refs/remotes/origin/codex/server-translation-experimental &&
git -C "$silly_pop_extension_dir" switch codex/server-translation-experimental &&
git -C "$silly_pop_extension_dir" pull --ff-only origin codex/server-translation-experimental
```

베르바·베에르으바아는 **이미 서버 번역 실험판 브랜치를 쓰는 경우**, 실리태번 확장 프로그램 관리에서 사용하는 번역기를 업데이트합니다. 일반 배포판을 쓰고 있다면 먼저 서버 번역 안내에 따라 실험판으로 전환합니다.

### 4. 재시작하고 켜기

1. 실리태번 서버를 다시 실행하고 웹페이지를 새로고침합니다.
2. 베르바 또는 베에르으바아에서 **서버 번역**과 **답변 자동번역**을 켭니다.
3. **Silly-Pop → 서버 번역 완료 알림**을 켭니다. 기존 **서버 응답 알림**도 켜두면 원문 수신과 번역 완료를 각각 알립니다.
4. 영어 답장을 요청하고 다른 앱으로 이동합니다. 번역이 성공하면 “캐릭터 이름의 답장 번역이 완료됐어요”가 표시됩니다. 이름이 없으면 “답장 번역이 완료됐어요”가 표시됩니다.

‘다른 앱을 볼 때만’과 소리·진동 설정은 추가 알림에도 적용됩니다. Relay를 이미 서버 번역 실험판으로 쓰고 있다면 이번 기능 때문에 Relay를 더 업데이트할 필요는 없습니다.

## 알림이 뜻하는 것

추가 알림은 **서버 번역 결과가 준비됐다는 뜻**입니다. 화면 반영·채팅 저장과 브라우저의 다른 후처리는 페이지에 돌아온 뒤 진행됩니다. 서버를 재시작하면 메모리에 보관된 결과가 사라질 수 있습니다.

입력·선택·수동 재번역, 보조 요청, 번역 생략, 실패·취소에는 추가 알림을 보내지 않습니다. 같은 생성의 중복 완료·조회로 알림을 다시 보내지 않습니다. 기존 원문 알림 동작은 유지합니다.

이 기능만 끄려면 **서버 번역 완료 알림**을 OFF로 바꾸면 됩니다. 알림 설정은 서버에 전달된 뒤 적용되므로, 이미 전달된 알림은 취소하지 않습니다.

자동 테스트로 완료 시점·중복·취소·실패·설정 변경과 기존 알림 경로를 확인했습니다. 실제 휴대폰에서의 알림 도착은 별도로 확인해야 합니다.
