# Silly-Pop iOS

**1.0.3 · 아이폰용 정식 배포**

실리태번 답장이 도착하면 아이폰에 알려주는 홈 화면 웹앱입니다. 채팅은 원래 쓰던 실리 웹앱에서 계속하면 됩니다.

- **[앱 열기 · Safari에서 홈 화면에 추가](https://foreverharibo-boop.github.io/Silly-Pop/)**
- **[설치·연결·업데이트 안내](ios/README.md)**
- [연결 유지·답장 복구: Silly Relay](https://github.com/foreverharibo-boop/Silly-Relay)
- [갤럭시용 Silly-Pop 배포본](https://github.com/foreverharibo-boop/Silly-Pop/tree/main)

아이폰 정식 배포는 이 저장소의 `ios` 브랜치에서 관리합니다. 갤럭시용 앱은 `main`에서 별도로 배포합니다. 기존 시험판 사용자의 설치와 앱 주소를 유지하기 위해 `ios-preview`도 같은 정식 배포 내용을 제공합니다.

## 지원 환경

- iOS/iPadOS 16.4 이상, 홈 화면에 추가한 알림 앱
- 갤럭시 Termux 또는 PC에서 실행 중인 SillyTavern 서버
- Silly-Pop iOS 서버 플러그인·확장, 백그라운드 생성과 복구용 Silly Relay

일반 답장·재생성·새 스와이프 답장을 서버가 받으면 “김홍진의 답장이 도착했어요”처럼 캐릭터 이름을 기본으로 표시합니다. 이름이 없으면 “답장이 도착했어요”로 표시합니다. 대화 본문·AI API 키를 푸시에 넣지 않으며, 알림 기능 자체는 AI API를 호출하지 않습니다. 알림을 누르면 이 알림 앱이 열립니다.

제작자의 아이폰 실기기 테스트 후 정식 배포합니다. 다른 서버 환경이나 확장 조합의 오류는 배포글의 문의 달글 또는 본문 댓글로 알려 주세요.

AGPL-3.0-or-later. 기존 소스와 저작권·라이선스 고지를 유지합니다. 설치 전 [전체 안내](ios/README.md)를 확인해 주세요.

이 저장소는 [SillyTavern/SillyTavern-PushNotifications](https://github.com/SillyTavern/SillyTavern-PushNotifications)(Cohee1207)의 포크이며, 모바일·Android 및 iOS 연동은 담은이 추가했습니다. 원본 저작권·AGPL 고지는 그대로 유지합니다.
