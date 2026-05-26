// SPA 진입점 — F-NRA-002-01 (Vite + TS 단일 번들 골격)
// 후속 Feature(F-02 auth / F-03 picker / F-04 postmessage / ...)에서 모듈 호출이 여기로 연결된다.

const APP_VERSION = "0.1.0";

function bootstrap(): void {
  const app = document.getElementById("app");
  if (app === null) {
    console.error("[NRA-SPA] #app element 부재 — index.html 확인 필요");
    return;
  }

  app.innerHTML = `
    <header>
      <h1>NIKKE 레이드 자동 동기화 도구</h1>
      <p>v${APP_VERSION} · third-party tool · 사내 한정</p>
    </header>
    <main>
      <p>이 도구는 blablalink.com 새 탭에서 postMessage를 수신해 사본 시트를 자동으로 갱신합니다.</p>
      <p><em>Google 로그인은 F-NRA-002-02에서 추가됩니다.</em></p>
    </main>
  `;

  console.info(`[NRA-SPA] v${APP_VERSION} initialized`);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}
