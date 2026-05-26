// SPA 진입점 — F-NRA-002-02 OAuth 와이어링 적용.

import { getAccessToken, getTokenExpiry, isAuthenticated, login, logout } from "./auth";
import { GOOGLE_CLIENT_ID } from "./config";
import {
  clearSyncClassification,
  getSyncClassification,
  startClassificationFlow,
  type ClassificationResult,
  SyncError,
} from "./matching";
import { openPicker } from "./picker";
import {
  clearPayload,
  getLastPayload,
  initMessageListener,
} from "./postmessage";
import { clearStorage, getSheetId, getSheetName } from "./storage";
import type { NikkeRaidPayload } from "./types";

const APP_VERSION = "0.1.0";

// DevTools 검증 helper — F-NRA-002-02 AC-T02-3 (`isAuthenticated()` 콘솔 호출)
declare global {
  interface Window {
    isAuthenticated?: () => boolean;
    getAccessToken?: () => string | null;
    getTokenExpiry?: () => number | null;
    getSheetId?: () => string | null;
    getSheetName?: () => string | null;
    clearStorage?: () => void;
    getLastPayload?: () => NikkeRaidPayload | null;
    clearPayload?: () => void;
    getSyncClassification?: () => ClassificationResult | null;
    runMatching?: () => Promise<void>;
    injectMockPayload?: (payload: NikkeRaidPayload) => void;
  }
}

let lastError: string | null = null;

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

// Chrome 보안상 dispatchEvent(new MessageEvent(...))는 origin/data가 listener에 빈값으로 전달됨.
// 실제 cross-tab postMessage는 Wave A 유저스크립트에서 동작. 본 helper는 DevTools 단독 검증용.
function injectMockPayload(payload: NikkeRaidPayload): void {
  console.info("[NRA-SPA] injectMockPayload (dev helper)", payload);
  window.dispatchEvent(new CustomEvent("payloadReceived", { detail: payload }));
}

async function runMatching(): Promise<void> {
  const token = getAccessToken();
  const sheetId = getSheetId();
  const payload = getLastPayload();
  if (token === null || sheetId === null || payload === null) {
    lastError = "매칭 실행 조건 미충족 (로그인 / 시트 / payload 중 누락)";
    renderApp();
    return;
  }
  if (payload.type !== "nikke-raid-data") {
    lastError = `payload type=${payload.type} — 매칭 불가`;
    renderApp();
    return;
  }
  try {
    lastError = null;
    clearSyncClassification();
    await startClassificationFlow(token, sheetId, payload.members);
    renderApp();
  } catch (e) {
    if (e instanceof SyncError) {
      lastError = `${e.code}: ${e.message}`;
    } else {
      lastError = e instanceof Error ? e.message : String(e);
    }
    console.error("[NRA-SPA] matching error", e);
    renderApp();
  }
}

async function handleSelectSheet(): Promise<void> {
  const token = getAccessToken();
  if (token === null) {
    alert("로그인이 필요합니다");
    return;
  }
  try {
    await openPicker(token, (sheet) => {
      console.info(`[NRA-SPA] sheet selected: ${sheet.name} (${sheet.id})`);
      renderApp();
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[NRA-SPA] picker error", e);
    alert(`시트 선택 실패: ${msg}`);
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

  const sheetId = authed ? getSheetId() : null;
  const sheetName = authed ? getSheetName() : null;
  const sheetBlock = authed
    ? sheetId !== null && sheetName !== null
      ? `
          <p class="status status--ok">📄 현재 시트: <strong>${escapeHtml(sheetName)}</strong></p>
          <p class="meta">ID: <code>${escapeHtml(sheetId)}</code></p>
          <button type="button" id="change-sheet-btn">변경</button>
        `
      : `
          <p class="status">사본 시트를 선택해주세요 (drive.file scope — 명시 선택한 파일만 접근)</p>
          <button type="button" id="select-sheet-btn">시트 선택</button>
        `
    : "";

  const payload = authed ? getLastPayload() : null;
  const classification = authed ? getSyncClassification() : null;
  const canMatch =
    authed &&
    sheetId !== null &&
    payload !== null &&
    payload.type === "nikke-raid-data";

  const payloadBlock = authed
    ? payload === null
      ? `
          <p class="status">📨 payload 미수신 — blablalink.com 새 탭에서 유저스크립트가 송신하거나, DevTools에서 mock inject</p>
          <details>
            <summary>mock payload inject (DevTools, 실제 cross-tab은 Wave A 의존)</summary>
            <pre><code>injectMockPayload({
  type: "nikke-raid-data",
  raidNum: "40",
  capturedAt: new Date().toISOString(),
  raid: [],
  members: [
    { member_id: "m1", nickname: "테스트A", synchro_level: 420, commander_level: 160, icon_id: "1" },
    { member_id: "m2", nickname: "테스트B", synchro_level: 415, commander_level: 158, icon_id: "2" }
  ],
  meta: { guildId: "g1", areaId: "a1" }
});</code></pre>
          </details>
        `
      : payload.type === "nikke-raid-data"
        ? `
            <p class="status status--ok">📨 payload 수신: <strong>${escapeHtml(payload.raidNum)}차</strong> · members ${payload.members.length}명 · raid ${payload.raid.length}행</p>
            <button type="button" id="run-matching-btn" ${canMatch ? "" : "disabled"}>매칭 실행</button>
          `
        : `<p class="status">📨 payload type=${escapeHtml(payload.type)} — 매칭 불가</p>`
    : "";

  const classificationBlock =
    classification !== null
      ? `
          <p class="status">🔀 분류 결과 (mode: <code>${escapeHtml(classification.mode)}</code>) — staying ${classification.classification.staying.length}명 · leaving ${classification.classification.leaving.length}명 · joining ${classification.classification.joining.length}명${
            classification.nicknameChanges.length > 0
              ? ` · 닉네임 변경 ${classification.nicknameChanges.length}건`
              : ""
          }</p>
          ${
            classification.alerts.length > 0
              ? `<ul class="alerts">${classification.alerts.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}</ul>`
              : ""
          }
        `
      : "";

  const errorBlock =
    lastError !== null
      ? `<section class="error" role="alert"><p>⚠️ ${escapeHtml(lastError)}</p></section>`
      : "";

  app.innerHTML = `
    <header>
      <h1>NIKKE 레이드 자동 동기화 도구</h1>
      <p class="meta">v${APP_VERSION} · third-party 도구</p>
    </header>
    <main>
      <section class="auth">${authBlock}</section>
      ${sheetBlock !== "" ? `<section class="sheet">${sheetBlock}</section>` : ""}
      ${payloadBlock !== "" ? `<section class="payload">${payloadBlock}</section>` : ""}
      ${classificationBlock !== "" ? `<section class="classification">${classificationBlock}</section>` : ""}
      ${errorBlock}
      <section class="hint">
        <p>이 도구는 <code>blablalink.com</code> 새 탭에서 postMessage를 수신해 사본 시트를 자동으로 갱신합니다.</p>
        <p><em>dry-run · 쓰기는 F-NRA-002-06/07 wiring 이후 추가됩니다.</em></p>
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

  document
    .getElementById("select-sheet-btn")
    ?.addEventListener("click", () => void handleSelectSheet());
  document
    .getElementById("change-sheet-btn")
    ?.addEventListener("click", () => void handleSelectSheet());
  document
    .getElementById("run-matching-btn")
    ?.addEventListener("click", () => void runMatching());

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
  window.addEventListener("payloadReceived", () => renderApp());
  window.addEventListener("payloadValidationFailed", () => {
    lastError = "payload 검증 실패 — type/필수 필드 확인";
    renderApp();
  });
  window.addEventListener("payloadNeedLogin", () => {
    lastError = "유저스크립트 — blablalink 로그인 필요";
    renderApp();
  });
  window.addEventListener("payloadNoData", () => {
    lastError = "유저스크립트 — 회차 데이터 없음";
    renderApp();
  });
  window.addEventListener("payloadError", (e) => {
    const detail = (e as CustomEvent).detail as { error?: { msg?: string } };
    lastError = `유저스크립트 에러: ${detail.error?.msg ?? "unknown"}`;
    renderApp();
  });

  initMessageListener();

  // DevTools helpers (F-02 AC-T02-3, F-03/F-04/F-05 verification)
  window.isAuthenticated = isAuthenticated;
  window.getAccessToken = getAccessToken;
  window.getTokenExpiry = getTokenExpiry;
  window.getSheetId = getSheetId;
  window.getSheetName = getSheetName;
  window.clearStorage = clearStorage;
  window.getLastPayload = getLastPayload;
  window.clearPayload = clearPayload;
  window.getSyncClassification = getSyncClassification;
  window.runMatching = runMatching;
  window.injectMockPayload = injectMockPayload;

  renderApp();
  console.info(`[NRA-SPA] v${APP_VERSION} initialized`);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}
