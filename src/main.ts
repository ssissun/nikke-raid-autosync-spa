// SPA 진입점 — F-NRA-002-02 OAuth 와이어링 적용.

import { getAccessToken, getTokenExpiry, isAuthenticated, login, logout } from "./auth";
import { GOOGLE_CLIENT_ID } from "./config";

const APP_VERSION = "0.1.0";

// DevTools 검증 helper — F-NRA-002-02 AC-T02-3 (`isAuthenticated()` 콘솔 호출)
declare global {
  interface Window {
    isAuthenticated?: () => boolean;
    getAccessToken?: () => string | null;
    getTokenExpiry?: () => number | null;
  }
}

let countdownTimer: ReturnType<typeof setInterval> | null = null;

function formatRemaining(ms: number): string {
  if (ms <= 0) return "만료됨";
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}분 ${String(s).padStart(2, "0")}초`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function clearCountdown(): void {
  if (countdownTimer !== null) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

function renderApp(): void {
  const app = document.getElementById("app");
  if (app === null) {
    console.error("[NRA-SPA] #app element 부재");
    return;
  }

  const authed = isAuthenticated();
  const expiresAt = getTokenExpiry();
  const remainingText =
    authed && expiresAt !== null ? formatRemaining(expiresAt - Date.now()) : "";

  const authBlock = authed
    ? `
        <p class="status status--ok">✅ 로그인됨 · drive.file scope</p>
        <p class="expiry">토큰 만료까지 <span id="countdown">${escapeHtml(remainingText)}</span></p>
        <button type="button" id="logout-btn">로그아웃</button>
      `
    : `
        <p class="status">로그인 필요</p>
        <button type="button" id="login-btn">Google 로그인 (drive.file scope)</button>
      `;

  app.innerHTML = `
    <header>
      <h1>NIKKE 레이드 자동 동기화 도구</h1>
      <p class="meta">v${APP_VERSION} · third-party tool · 사내 한정</p>
    </header>
    <main>
      <section class="auth">${authBlock}</section>
      <section class="hint">
        <p>이 도구는 <code>blablalink.com</code> 새 탭에서 postMessage를 수신해 사본 시트를 자동으로 갱신합니다.</p>
        <p><em>시트 선택·매칭·dry-run·쓰기는 F-NRA-002-03 이후 추가됩니다.</em></p>
      </section>
    </main>
  `;

  document.getElementById("login-btn")?.addEventListener("click", () => {
    try {
      login(GOOGLE_CLIENT_ID);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[NRA-SPA] login error", e);
      alert(`로그인 실패: ${msg}`);
    }
  });

  document.getElementById("logout-btn")?.addEventListener("click", () => {
    logout().catch((e) => console.error("[NRA-SPA] logout error", e));
  });

  clearCountdown();
  if (authed && expiresAt !== null) {
    countdownTimer = setInterval(() => {
      const el = document.getElementById("countdown");
      if (el === null) return;
      const remaining = expiresAt - Date.now();
      el.textContent = formatRemaining(remaining);
      if (remaining <= 0) {
        clearCountdown();
        renderApp();
      }
    }, 1000);
  }
}

function bootstrap(): void {
  window.addEventListener("authStateChange", renderApp);

  // DevTools helpers (F-02 AC-T02-3)
  window.isAuthenticated = isAuthenticated;
  window.getAccessToken = getAccessToken;
  window.getTokenExpiry = getTokenExpiry;

  renderApp();
  console.info(`[NRA-SPA] v${APP_VERSION} initialized`);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}
