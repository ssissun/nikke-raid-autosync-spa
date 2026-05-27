# NIKKE 유레 자동 동기화 도구

> **블라블라링크 ShiftyPad → Google Sheets 자동 동기화 도구**
>
> NIKKE 유니온 레이드 회차 데이터(레이드 결과 + 멤버 싱크로 레벨)를 NIKKE 유레 시트 사본에 자동 입력해주는 third-party 도구.

## 🚀 사용

**[도구 열기 → https://ssissun.github.io/nikke-raid-autosync-spa/](https://ssissun.github.io/nikke-raid-autosync-spa/)**

처음 사용 시 [사용자 가이드](./USER_GUIDE.md)를 먼저 읽어주세요.

## 핵심 기능

- **2 클릭으로 회차 1회 동기화** — 데이터 가져오기 → 변경사항 확인 → 모든 변경 적용
- **자동 백업** — 매 회차 쓰기 직전 `_backup_{회차}` 탭에 원본 데이터 보존 (최근 3개)
- **시트 구조 검증** — SHA-256 fingerprint로 잘못된 시트 선택 시 사전 차단
- **자동 멤버 동기화** — 탈퇴/신규 멤버 자동 처리 (가입 순서 보존)
- **자동 회차 추측** — 시트의 마지막 회차 +1로 다음 회차 자동 결정

## 시스템 요구사항

- 데스크탑 PC (모바일 미지원)
- Chrome 브라우저 (확인된 환경)
- Tampermonkey 확장프로그램
- Google 계정 (Google Sheets 사용)
- NIKKE 유레 시트의 **본인 사본**

## 설치 + 사용 흐름 (요약)

1. **Tampermonkey 확장 설치** → Chrome 웹 스토어
2. **Greasyfork 유저스크립트 설치** → [니케 유레 자동 동기화 (v2)](https://greasyfork.org/scripts/579278)
3. **본인 Google Drive에 NIKKE 유레 시트 사본 생성** → [arca.live 게시글](https://arca.live/b/nikketgv/161405505)에서 시트 링크 확인 후 `파일 > 사본 만들기`
4. **유니온 멤버 탭에 가입 순서대로 닉네임 입력** (최초 1회) → 32명
5. **[도구 페이지](https://ssissun.github.io/nikke-raid-autosync-spa/) 접속** → Google 로그인 → 사본 시트 선택
6. **[🎯 신규 회차 데이터 가져오기]** 클릭 → 블라블라링크 새 탭에서 유저스크립트가 자동 수집
7. 변경사항 미리보기 확인 후 **[✅ 모든 변경 적용]** 클릭 → 완료

자세한 절차는 [USER_GUIDE.md](./USER_GUIDE.md) 참고.

## 주의사항 (꼭 읽어주세요)

- **현재 회차 정보만** 시트에 추가됩니다. 이전 회차는 사용자가 직접 입력해야 합니다.
- **현재 회차 번호는 시트의 마지막 회차 +1**로 자동 추측합니다. **매 회차마다 꾸준히 사용**해야 회차 번호가 어긋나지 않습니다.
- **유니온 멤버는 최초 1회 사용자가 직접 시트에 가입 순서대로 작성**해야 합니다.
- 신규 가입자가 여러 명일 경우 자동 처리 후 가입 순서를 정확히 하려면 사용자가 직접 조정해야 합니다 (보통 의미 없음 — 동일 회차 가입).

## 관련 링크

- **사용자 가이드**: [USER_GUIDE.md](./USER_GUIDE.md)
- **유저스크립트**: [Greasyfork 579278](https://greasyfork.org/scripts/579278)
- **유저스크립트 repo**: [nikke-raid-autosync-userscript](https://github.com/ssissun/nikke-raid-autosync-userscript)
- **NIKKE 유레 시트 (원본 + 설명)**: [arca.live/b/nikketgv/161405505](https://arca.live/b/nikketgv/161405505)
- **원본 30초 입력법 유저스크립트** (v1.12): [Greasyfork 565386](https://greasyfork.org/scripts/565386)

## 기술 스택

- Vite + vanilla TypeScript (단일 HTML 번들)
- Google Identity Services (GIS) + PKCE
- Google Sheets API v4 / Drive API / Picker API
- GitHub Pages 정적 호스팅

## 라이선스

MIT.
