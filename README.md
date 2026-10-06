# Silly-Pop (실리팝)

SillyTavern에서 AI 답변 생성이 완료되면 시스템 알림으로 알려주는 귀여운 알림 확장입니다. 브라우저 알림과 전용 안드로이드 알림 앱을 지원합니다.

이 저장소는 [SillyTavern/SillyTavern-PushNotifications](https://github.com/SillyTavern/SillyTavern-PushNotifications)를 기반으로 모바일 알림 설정과 서비스 워커 지원을 추가한 포크입니다.

- 원작: Cohee1207 / SillyTavern
- 모바일 설정 및 기능 확장: 담은
- 라이선스: AGPL-3.0 (`LICENSE` 참조)

## 추가된 기능

- 답변 생성 완료 시스템 알림
- 다른 앱을 보고 있을 때만 알림
- 답변 미리보기 표시/숨김
- 알림 소리 및 진동 설정
- 알림 권한 상태 및 테스트 알림
- 알림을 눌러 현재 SillyTavern 채팅으로 복귀
- 스와이프, 재생성, 이어쓰기 지원
- 첫 인사, 명령어, 숨은 생성 및 확장 내부 생성 제외
- 중복 알림 방지
- 삼성 인터넷에서 답변 생성 중 다른 앱으로 이동했다가 돌아오는 경우 감지 보강
- 브라우저 알림을 눌렀을 때 기존 SillyTavern 화면을 새로고침하지 않고 그대로 열기
- **Silly-Pop 안드로이드 앱**: 삼성 인터넷이 백그라운드에서 얼어도 답변 완료 알림 전송
- 블랙/화이트 앱 아이콘 선택
- 서버 연결 상태 표시 및 서버 테스트 알림
- 동일 저장소 URL로 웹 확장과 서버 플러그인 설치

외부 API나 별도 크레딧을 사용하지 않습니다. 안드로이드 앱은 알림 권한만 사용하며 인터넷, 파일, 연락처, 문자, 접근성 권한을 요청하지 않습니다.

## 사용 방법

1. SillyTavern 확장 설치 화면에서 이 저장소 URL을 설치합니다.
2. SillyTavern을 새로고침합니다.
3. 확장 설정에서 `Silly-Pop`을 엽니다.
4. `알림 권한 허용`을 누른 뒤 `테스트 알림 보내기`로 확인합니다.

같은 휴대폰의 Termux 서버를 `http://127.0.0.1:8000`처럼 여는 환경을 지원합니다. 포트 번호는 사용자 설정에 따라 다를 수 있습니다.

## 삼성 인터넷 백그라운드 정지 해결: Silly-Pop 알림 앱

삼성 인터넷이 백그라운드에서 SillyTavern 페이지를 얼리면 브라우저 확장도 함께 멈추므로, 답변이 서버에 도착해도 브라우저 알림을 보낼 수 없습니다. v1.3.0부터는 동반 서버 플러그인이 AI 응답 완료를 서버에서 직접 감지하고 Silly-Pop 안드로이드 앱으로 신호를 보냅니다.

### 1. Silly-Pop APK 설치

1. GitHub Actions에서 생성된 `Silly-Pop-v0.2.0-test.apk`를 설치합니다.
2. 앱을 열고 `알림 권한 허용`을 누릅니다.
3. 앱의 `테스트 알림 보내기`로 알림 표시를 확인합니다.

Termux:API, 별도 알림 서비스, 외부 푸시 서버는 필요하지 않습니다.

### 2. Silly-Pop 서버 플러그인 설치

SillyTavern 폴더에서 같은 저장소를 서버 플러그인으로 한 번 더 설치합니다.

```bash
cd ~/SillyTavern
node plugins.js install https://github.com/foreverharibo-boop/Silly-Pop
```

`config.yaml`에서 서버 플러그인이 켜져 있어야 합니다.

```yaml
enableServerPlugins: true
```

SillyTavern을 완전히 재시작한 뒤 Silly-Pop 설정을 열어 `Silly-Pop 알림 앱 · 연결됨`이 표시되는지 확인합니다. 이후 확장의 `테스트 알림 보내기`는 전용 앱 알림을 테스트합니다.

### 작동 방식

- 실리팝 웹 확장이 실제 메인 답변 요청에만 표시를 붙입니다.
- 동반 플러그인이 해당 응답 스트림이 끝나는 순간을 Termux 서버에서 감지합니다.
- 서버가 안드로이드의 명시적 브로드캐스트로 Silly-Pop 앱만 호출합니다.
- 앱 수신기가 실제로 응답했는지 확인해 연결 성공과 전송 실패를 구분합니다.
- `다른 앱을 볼 때만`, 소리, 진동 설정도 서버 알림에 반영됩니다.
- 숨은 생성, 확장 내부 생성, 첫 인사에는 서버 알림을 보내지 않습니다.
- 서버 알림을 누르면 SillyTavern 주소를 엽니다. 안드로이드와 브라우저 상태에 따라 기존 화면을 앞으로 가져오거나 주소를 다시 열 수 있습니다.
- 서버 모드의 알림 본문은 브라우저가 얼어 있어도 만들 수 있도록 고정된 완료 문구를 사용하며, 답변 미리보기는 브라우저 알림 모드에서만 표시됩니다.

> Silly-Pop 알림 앱이 연결된 동안에는 중복 방지를 위해 브라우저 알림 대신 앱 알림이 우선 사용됩니다.

### 앱은 연결됐는데 알림이 오지 않을 때

1. Silly-Pop 앱을 열어 `테스트 알림 보내기`가 작동하는지 확인합니다.
2. SillyTavern의 Silly-Pop 설정에서 `연결 확인` 후 `테스트 알림 보내기`를 누릅니다.
3. 실패하면 표시되는 문구를 확인합니다. v1.3.1부터는 앱 미수신과 알림 권한 차단을 성공으로 처리하지 않습니다.
4. 앱을 업데이트한 뒤에는 SillyTavern 서버도 완전히 재시작해야 새 서버 플러그인이 로드됩니다.

## Doesn't work?

Okay, maybe it wasn't that simple.

![image](https://github.com/Cohee1207/SillyTavern-PushNotifications/assets/18619528/f6cd4c6a-76ad-4197-ac3e-a4d7d9322d54)

### 브라우저 및 시스템 권한 확인

1. Chrome: https://knowledge.workspace.google.com/kb/how-to-enable-browser-notifications-000007831
2. Firefox: https://support.mozilla.org/en-US/kb/push-notifications-firefox

### HTTPS 접속을 사용하는 경우

Below is a simple guide on how to generate and use self-signed certificates.

1. Generate a certificate and key (requires to have `openssl` installed on your system)

```bash
openssl req -x509 -out localhost.crt -keyout localhost.key \
  -newkey rsa:2048 -nodes -sha256 \
  -subj '/CN=localhost' -extensions EXT -config <( \
   printf "[dn]\nCN=localhost\n[req]\ndistinguished_name = dn\n[EXT]\nsubjectAltName=DNS:localhost\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth")
```

2. Put them in some folder accessible to SillyTavern server (dist, for example).

3. Start SillyTavern server with appropriate SSL console flags (provide paths to your actual key/cert).

```bash
node server.js --ssl --certPath dist/localhost.crt --keyPath dist/localhost.key   
```

4. Use `https://localhost:8000` to access your SillyTavern instance.
