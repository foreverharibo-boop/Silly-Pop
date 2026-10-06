# Silly-Pop Android Companion

Silly-Pop의 안드로이드 알림 수신 앱입니다. SillyTavern 서버 플러그인이 명시적 안드로이드 브로드캐스트를 보내면 앱이 시스템 알림을 표시합니다.

v0.2.2에서는 흑백 테마·아이콘 동시 전환, 작은 버튼, 곡선 ST 로고와 넓은 여백을 적용했습니다. 0.2.1과 동일 서명으로 업데이트할 수 있습니다. 서버 플러그인 2.2.0도 함께 업데이트하세요.

## 권한

앱은 `POST_NOTIFICATIONS` 알림 권한만 선언합니다.

- 인터넷 권한 없음
- 파일 및 사진 권한 없음
- 연락처, 전화, 문자 권한 없음
- 접근성 및 다른 앱 위에 표시 권한 없음
- 백그라운드 상시 실행 서비스 없음

## 로컬 빌드

JDK 17과 Android SDK 35가 필요합니다.

```bash
cd android-app
gradle :app:assembleDebug
```

테스트 APK는 GitHub Actions의 `Build Silly-Pop Android APK` 워크플로에서도 생성됩니다.
