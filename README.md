# Silly-Pop (실리팝)

SillyTavern에서 AI 답변 생성이 완료되면 브라우저의 시스템 알림으로 알려주는 귀여운 알림 확장입니다.

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
- 알림을 눌렀을 때 기존 SillyTavern 화면을 새로고침하지 않고 그대로 열기

외부 API, 별도 서버 또는 크레딧을 사용하지 않습니다.

## 사용 방법

1. SillyTavern 확장 설치 화면에서 이 저장소 URL을 설치합니다.
2. SillyTavern을 새로고침합니다.
3. 확장 설정에서 `Silly-Pop`을 엽니다.
4. `알림 권한 허용`을 누른 뒤 `테스트 알림 보내기`로 확인합니다.

같은 휴대폰의 Termux 서버를 `http://127.0.0.1:8000`처럼 여는 환경을 지원합니다. 포트 번호는 사용자 설정에 따라 다를 수 있습니다.

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
