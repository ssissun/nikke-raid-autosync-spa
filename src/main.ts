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
import {
  prepareDryRun,
  type BatchUpdatePlan,
} from "./dryrun";
import { ensureRaidColumn, guessNextRaidNum, writeRaidData } from "./sheets";
import { applyMemberSync, type AutoSyncResult } from "./sync/auto-sync";
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
    listSheetTabs?: () => Promise<string[]>;
    inspectMemberHeader?: () => Promise<string[]>;
    diagnoseSheet?: () => Promise<SheetDiagnostic | null>;
    autofillMemberNicknames?: () => Promise<void>;
    prepareDryRunFlow?: () => Promise<void>;
    confirmWriteFlow?: () => Promise<void>;
    getBatchPlan?: () => BatchUpdatePlan | null;
    autoSyncMembers?: () => Promise<void>;
  }
}

let lastError: string | null = null;

interface SheetDiagnostic {
  header: string[];
  rowCount: number;
  filledRows: number;
  sampleRows: string[][];
  guessedFormat: "pre-migration" | "post-migration" | "empty" | "unknown";
  colBNonEmpty: number;
  colCNonEmpty: number;
  fetchedAt: number;
  error?: string;
}

let lastDiagnostic: SheetDiagnostic | null = null;

let lastBatchPlan: BatchUpdatePlan | null = null;
type WriteStatus = "idle" | "running" | "done" | "error";
let writeStatus: WriteStatus = "idle";
const writeStages: Record<string, string> = {};
let writeResult: { backupTabName: string } | null = null;

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

// 시트 자동 진단 — 유니온 멤버 A1:Z33 fetch 후 헤더·데이터·구조 추정.
// 시트 선택 직후 + 로그인 직후 자동 호출. 사용자가 console 안 만져도 UI에 결과 표시.
async function diagnoseSheet(): Promise<SheetDiagnostic | null> {
  const token = getAccessToken();
  const sheetId = getSheetId();
  if (token === null || sheetId === null) return null;

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent("유니온 멤버!A1:Z33")}`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const errText = await res.text();
      const diag: SheetDiagnostic = {
        header: [],
        rowCount: 0,
        filledRows: 0,
        sampleRows: [],
        guessedFormat: "unknown",
        colBNonEmpty: 0,
        colCNonEmpty: 0,
        fetchedAt: Date.now(),
        error: `HTTP ${res.status}: ${errText.slice(0, 200)}`,
      };
      lastDiagnostic = diag;
      return diag;
    }
    const data = (await res.json()) as { values?: string[][] };
    const rows = data.values ?? [];
    const header = rows[0] ?? [];
    const dataRows = rows.slice(1);
    const filledRows = dataRows.filter((r) => r.some((c) => (c ?? "").trim().length > 0)).length;
    let colB = 0;
    let colC = 0;
    for (const r of dataRows) {
      if ((r[1] ?? "").trim().length > 0) colB++;
      if ((r[2] ?? "").trim().length > 0) colC++;
    }

    let guessedFormat: SheetDiagnostic["guessedFormat"] = "unknown";
    if (filledRows === 0) {
      guessedFormat = "empty";
    } else if (header[1]?.trim() === "member_id") {
      guessedFormat = "post-migration";
    } else if (
      typeof header[1] === "string" &&
      (header[1].includes("닉네임") || /nickname/i.test(header[1]))
    ) {
      guessedFormat = "pre-migration";
    }

    const diag: SheetDiagnostic = {
      header,
      rowCount: dataRows.length,
      filledRows,
      sampleRows: dataRows.slice(0, 5),
      guessedFormat,
      colBNonEmpty: colB,
      colCNonEmpty: colC,
      fetchedAt: Date.now(),
    };
    lastDiagnostic = diag;
    return diag;
  } catch (e) {
    const diag: SheetDiagnostic = {
      header: [],
      rowCount: 0,
      filledRows: 0,
      sampleRows: [],
      guessedFormat: "unknown",
      colBNonEmpty: 0,
      colCNonEmpty: 0,
      fetchedAt: Date.now(),
      error: e instanceof Error ? e.message : String(e),
    };
    lastDiagnostic = diag;
    return diag;
  }
}

async function autoDiagnose(): Promise<void> {
  await diagnoseSheet();
  renderApp();
}

// Dev helper — payload의 닉네임을 시트 Col B(마이그레이션 전) 또는 Col C(마이그레이션 후)에 자동 입력.
// 운영자가 32명 수동 입력 부담 회피. mock payload 검증용.
async function autofillMemberNicknames(): Promise<void> {
  const token = getAccessToken();
  const sheetId = getSheetId();
  const payload = getLastPayload();
  if (token === null || sheetId === null) {
    lastError = "autofill: 로그인/시트 필요";
    renderApp();
    return;
  }
  if (payload === null || payload.type !== "nikke-raid-data") {
    lastError = "autofill: payload 미수신 — injectMockPayload 먼저";
    renderApp();
    return;
  }
  const diag = lastDiagnostic;
  // 마이그레이션 전 → Col B에 닉네임. 마이그레이션 후 → Col C에 닉네임.
  const targetCol =
    diag !== null && diag.guessedFormat === "post-migration" ? "C" : "B";
  const values = payload.members.map((m) => [m.nickname]);
  const range = `유니온 멤버!${targetCol}2:${targetCol}${1 + values.length}`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values }),
    });
    if (!res.ok) {
      const txt = await res.text();
      lastError = `autofill 실패 HTTP ${res.status}: ${txt.slice(0, 120)}`;
    } else {
      lastError = null;
      console.info(`[NRA-SPA] autofilled ${values.length} 닉네임 → Col ${targetCol}`);
    }
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
  }
  await autoDiagnose();
}

// 레거시 helper — 단일 헤더만 필요할 때 (DevTools 단축).
async function inspectMemberHeader(): Promise<string[]> {
  const token = getAccessToken();
  const sheetId = getSheetId();
  if (token === null || sheetId === null) {
    console.warn("[NRA-SPA] inspectMemberHeader: 로그인/시트 필요");
    return [];
  }
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent("유니온 멤버!A1:Z1")}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    console.error(`[NRA-SPA] inspectMemberHeader failed: HTTP ${res.status}`);
    return [];
  }
  const data = (await res.json()) as { values?: string[][] };
  const header = data.values?.[0] ?? [];
  console.info("[NRA-SPA] 유니온 멤버 헤더 row 1:", header);
  return header;
}

// Sheets API 진단 helper — 시트 탭 이름 list 출력 (신버전 사본 호환성 확인용).
async function listSheetTabs(): Promise<string[]> {
  const token = getAccessToken();
  const sheetId = getSheetId();
  if (token === null) {
    console.warn("[NRA-SPA] listSheetTabs: 로그인 필요");
    return [];
  }
  if (sheetId === null) {
    console.warn("[NRA-SPA] listSheetTabs: 시트 미선택");
    return [];
  }
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}?fields=sheets.properties.title`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    console.error(`[NRA-SPA] listSheetTabs failed: HTTP ${res.status}`);
    return [];
  }
  const data = (await res.json()) as {
    sheets?: Array<{ properties?: { title?: string } }>;
  };
  const titles = (data.sheets ?? [])
    .map((s) => s.properties?.title ?? "")
    .filter((t) => t.length > 0);
  console.info("[NRA-SPA] sheet tabs:", titles);
  return titles;
}

// Wave A 유저스크립트 cross-tab 트리거 — 사용자 클릭으로 새 탭 open (popup 차단 회피).
// 새 탭에서 Tampermonkey + Greasyfork userscript 579278가 4 API intercept 후
// window.opener.postMessage로 본 SPA에 payload 전달.
function openBlablalinkRaidPage(): void {
  const w = window.open(
    "https://www.blablalink.com/shiftyspad/union-raid?lang=ko",
    "blablalink-union-raid"
  );
  if (w === null) {
    lastError =
      "팝업이 차단됨 — 주소창 우측 팝업 허용 후 재시도. 유저스크립트(Greasyfork 579278) + Tampermonkey 설치 필요";
    renderApp();
  }
}

async function getLastRaidRow(
  spreadsheetId: string,
  accessToken: string
): Promise<number> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent("레이드 통계!A:A")}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`getLastRaidRow failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { values?: string[][] };
  return data.values?.length ?? 0;
}

async function prepareDryRunFlow(): Promise<void> {
  const token = getAccessToken();
  const sheetId = getSheetId();
  const payload = getLastPayload();
  const classResult = getSyncClassification();
  if (
    token === null ||
    sheetId === null ||
    payload === null ||
    classResult === null
  ) {
    lastError = "dry-run: 로그인/시트/payload/매칭 결과 필요";
    renderApp();
    return;
  }
  if (payload.type !== "nikke-raid-data") {
    lastError = `dry-run: payload type=${payload.type}`;
    renderApp();
    return;
  }

  try {
    lastError = null;
    const layout =
      lastDiagnostic?.guessedFormat === "pre-migration"
        ? "pre-migration"
        : "post-migration";

    // raidNum 결정: payload → 추측 (시트의 max "N차" +1) → throw
    let raidNumStr: string;
    if (payload.raidNum !== undefined && payload.raidNum !== null) {
      raidNumStr = payload.raidNum;
    } else {
      const guessed = await guessNextRaidNum(sheetId, token);
      if (guessed === null) {
        lastError =
          "dry-run: raidNum 결정 실패 — 유저스크립트 회차 메타 미캡처 + 시트 기존 회차 데이터도 부재";
        renderApp();
        return;
      }
      raidNumStr = guessed;
      console.info(`[NRA-SPA] raidNum 추측: ${raidNumStr}차 (시트 기존 회차 +1)`);
    }

    // 회차 컬럼 보장 — 없으면 마지막 +1 위치에 신규 헤더 추가
    const resolution = await ensureRaidColumn(
      sheetId,
      raidNumStr,
      token,
      fetch,
      layout
    );
    if (resolution.isNew) {
      console.info(
        `[NRA-SPA] 신규 회차 컬럼 추가: ${resolution.column} (${raidNumStr}차)`
      );
    } else if (resolution.isPlaceholder) {
      console.info(
        `[NRA-SPA] OO차 placeholder를 ${raidNumStr}차로 갱신: ${resolution.column}`
      );
    }
    const syncroColumn = resolution.column;

    const lastRaidRow = await getLastRaidRow(sheetId, token);
    const plan = prepareDryRun({
      payload: { ...payload, raidNum: raidNumStr },
      classification: classResult.classification,
      alerts: classResult.alerts,
      lastRaidRow,
      syncroColumn,
    });
    lastBatchPlan = plan;
    renderApp();
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    console.error("[NRA-SPA] prepareDryRun error", e);
    renderApp();
  }
}

async function confirmWriteFlow(): Promise<void> {
  const token = getAccessToken();
  const sheetId = getSheetId();
  if (token === null || sheetId === null || lastBatchPlan === null) {
    lastError = "쓰기: 사전 조건 미충족";
    renderApp();
    return;
  }
  writeStatus = "running";
  for (const k of Object.keys(writeStages)) delete writeStages[k];
  writeResult = null;
  renderApp();

  try {
    const result = await writeRaidData(sheetId, lastBatchPlan, token, {
      skipFingerprint: true, // ALLOWED_FINGERPRINTS 미실측 — dev 모드 임시 우회
    });
    writeStatus = "done";
    writeResult = result;
    lastError = null;
  } catch (e) {
    writeStatus = "error";
    lastError = e instanceof Error ? e.message : String(e);
    console.error("[NRA-SPA] writeRaidData error", e);
  }
  renderApp();
}

let lastAutoSync: AutoSyncResult | null = null;

/**
 * SHEET_SCHEMA §2.2 4·5번 자동 sync — leaving 삭제 + Col A 재번호 + joining 추가.
 * 호출 후 자동 재진단 + 재매칭으로 시트 ↔ payload 100% 일치 상태 만든다.
 */
async function autoSyncMembers(): Promise<void> {
  const token = getAccessToken();
  const sheetId = getSheetId();
  const payload = getLastPayload();
  const classResult = getSyncClassification();
  if (
    token === null ||
    sheetId === null ||
    payload === null ||
    payload.type !== "nikke-raid-data" ||
    classResult === null
  ) {
    lastError = "auto-sync 조건 미충족 (로그인/시트/payload/매칭 결과 필요)";
    renderApp();
    return;
  }
  if (
    classResult.unmatchedSheetNicknames.length === 0 &&
    classResult.unmatchedPayloadMembers.length === 0
  ) {
    lastError = "auto-sync 대상 없음 (unmatched 0건)";
    renderApp();
    return;
  }

  try {
    lastError = null;
    const layout =
      lastDiagnostic?.guessedFormat === "pre-migration"
        ? "pre-migration"
        : "post-migration";
    lastAutoSync = await applyMemberSync(
      sheetId,
      token,
      classResult.unmatchedSheetNicknames,
      classResult.unmatchedPayloadMembers,
      { layout }
    );
    console.info("[NRA-SPA] auto-sync 완료", lastAutoSync);
    // 시트 변경 후 재진단 + 재매칭
    await autoDiagnose();
    await runMatching();
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    console.error("[NRA-SPA] auto-sync error", e);
    renderApp();
  }
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
      lastDiagnostic = null;
      renderApp();
      void autoDiagnose();
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

  const diag = authed && sheetId !== null ? lastDiagnostic : null;
  const diagBlock =
    diag !== null
      ? `
          <h3>🔍 시트 자동 진단 <button type="button" id="rediag-btn" class="inline">↻ 재진단</button></h3>
          ${
            diag.error !== undefined
              ? `<p class="status status--error">진단 실패: ${escapeHtml(diag.error)}</p>`
              : `
                  <p class="status">format=<code>${escapeHtml(diag.guessedFormat)}</code> · 채워진 행 ${diag.filledRows}/${diag.rowCount} · Col B 데이터 ${diag.colBNonEmpty} · Col C 데이터 ${diag.colCNonEmpty}</p>
                  <details open>
                    <summary>헤더 row 1 (${diag.header.length}개 컬럼)</summary>
                    <pre><code>${escapeHtml(JSON.stringify(diag.header))}</code></pre>
                  </details>
                  ${
                    diag.sampleRows.length > 0
                      ? `
                          <details>
                            <summary>데이터 샘플 (최대 5행)</summary>
                            <pre><code>${escapeHtml(diag.sampleRows.map((r, i) => `row${i + 2}: ${JSON.stringify(r)}`).join("\n"))}</code></pre>
                          </details>
                        `
                      : ""
                  }
                  ${
                    diag.guessedFormat === "pre-migration"
                      ? `<p class="status status--warn">⚠️ 마이그레이션 전 구조 — col-b-reader가 헤더 자동 감지하여 Col B(닉네임)를 backfill 소스로 처리. Col B에 닉네임이 비어있으면 mock payload로 자동 채움 가능</p>
                         ${
                           diag.colBNonEmpty === 0 && getLastPayload() !== null
                             ? `<button type="button" id="autofill-btn">payload 닉네임으로 시트 Col B 자동 입력 (dev)</button>`
                             : ""
                         }`
                      : ""
                  }
                  ${
                    diag.guessedFormat === "empty"
                      ? `<p class="status status--warn">⚠️ 빈 시트 — 운영자가 가입 순서·닉네임을 먼저 입력해야 매칭 시작 가능 (SHEET_SCHEMA §2.2 마이그레이션 단계).
                         ${getLastPayload() !== null ? `mock payload 닉네임으로 시트 Col B 자동 입력 가능:` : "Row 2부터 가입 순서(A)·닉네임(B 또는 C)을 채운 뒤 [↻ 재진단] 클릭"}</p>
                         ${
                           getLastPayload() !== null
                             ? `<button type="button" id="autofill-btn">payload 닉네임으로 시트 Col B 자동 입력 (dev)</button>`
                             : ""
                         }`
                      : ""
                  }
                  ${
                    diag.guessedFormat === "post-migration"
                      ? `<p class="status status--ok">✅ 마이그레이션 후 구조 — 정상</p>`
                      : ""
                  }
                `
          }
        `
      : authed && sheetId !== null
        ? `<p class="status">🔍 시트 진단 중...</p>`
        : "";

  const fetchTriggerBlock =
    authed && sheetId !== null
      ? `
          <h3>🎯 회차 데이터 수집</h3>
          <p class="meta">Tampermonkey + Greasyfork 유저스크립트 <code>579278</code> 설치 필요. 클릭 시 blablalink.com 새 탭이 열리고 자동으로 4 API를 intercept하여 본 페이지로 postMessage 송신.</p>
          <button type="button" id="fetch-raid-btn">🎯 신규 회차 데이터 가져오기 (blablalink 새 탭)</button>
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
            <p class="status status--ok">📨 payload 수신: <strong>${escapeHtml(payload.raidNum ?? "(회차 메타 미캡처)")}${payload.raidNum ? "차" : ""}</strong> · members ${payload.members.length}명 · raid ${payload.raid.length}행</p>
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
          ${
            !classification.isComplete &&
            (classification.unmatchedSheetNicknames.length > 0 ||
              classification.unmatchedPayloadMembers.length > 0)
              ? `<p class="meta">↑ 시트 정정이 필요해. <strong>자동 처리</strong> 시 시트에서 매칭 실패 닉네임 row가 삭제되고(가입 순서 재번호) payload 신규 닉네임이 마지막 행 다음에 추가돼.</p>
                 <button type="button" id="auto-sync-btn">🔄 탈퇴/신규 자동 처리 (leaving ${classification.unmatchedSheetNicknames.length} + joining ${classification.unmatchedPayloadMembers.length})</button>`
              : ""
          }
          ${
            lastAutoSync !== null
              ? `<p class="status status--ok">✅ auto-sync 완료 — 삭제 ${lastAutoSync.removedRows.length}행 / 추가 ${lastAutoSync.addedRows.length}행</p>`
              : ""
          }
          ${
            classification.isComplete && lastBatchPlan === null
              ? `<button type="button" id="prepare-dryrun-btn">🧪 dry-run 계산</button>`
              : ""
          }
        `
      : "";

  const dryRunBlock =
    lastBatchPlan !== null
      ? `
          <h3>🧪 dry-run 미리보기</h3>
          <p class="status">
            회차 <strong>${escapeHtml(lastBatchPlan.raidNum)}차</strong> ·
            백업 탭 <code>${escapeHtml(lastBatchPlan.backupTabName)}</code> ·
            회차 컬럼 <code>${escapeHtml(lastBatchPlan.syncroColumn)}</code>
          </p>
          <p class="meta">
            레이드 통계 신규 행 ${lastBatchPlan.raidStatsRows.length} ·
            멤버 syncro PUT ${lastBatchPlan.memberSyncroUpdates.length}건 ·
            range <code>${escapeHtml(lastBatchPlan.raidStatsRange === "" ? "(레이드 통계 skip)" : lastBatchPlan.raidStatsRange)}</code>
          </p>
          ${
            lastBatchPlan.unmatchedNames.length > 0
              ? `<p class="status status--warn">⚠️ unmatched ${lastBatchPlan.unmatchedNames.length}건</p>`
              : ""
          }
          ${
            writeStatus === "idle"
              ? `<button type="button" id="confirm-write-btn" ${lastBatchPlan.isConfirmable ? "" : "disabled"}>확인 후 시트에 기록 (실제 쓰기 · _backup_탭 자동 생성)</button>`
              : ""
          }
          ${
            writeStatus === "running"
              ? `<p class="status">🔄 쓰기 진행: <code>${escapeHtml(JSON.stringify(writeStages))}</code></p>`
              : ""
          }
          ${
            writeStatus === "done" && writeResult !== null
              ? `<p class="status status--ok">✅ 쓰기 완료 · backup 탭 <code>${escapeHtml(writeResult.backupTabName)}</code></p>`
              : ""
          }
          ${
            writeStatus === "error"
              ? `<p class="status status--error">⚠️ 쓰기 실패: ${escapeHtml(lastError ?? "")}</p>`
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
      ${diagBlock !== "" ? `<section class="diagnostic">${diagBlock}</section>` : ""}
      ${fetchTriggerBlock !== "" ? `<section class="fetch-trigger">${fetchTriggerBlock}</section>` : ""}
      ${payloadBlock !== "" ? `<section class="payload">${payloadBlock}</section>` : ""}
      ${classificationBlock !== "" ? `<section class="classification">${classificationBlock}</section>` : ""}
      ${dryRunBlock !== "" ? `<section class="dryrun">${dryRunBlock}</section>` : ""}
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
  document
    .getElementById("rediag-btn")
    ?.addEventListener("click", () => void autoDiagnose());
  document
    .getElementById("autofill-btn")
    ?.addEventListener("click", () => void autofillMemberNicknames());
  document
    .getElementById("prepare-dryrun-btn")
    ?.addEventListener("click", () => void prepareDryRunFlow());
  document
    .getElementById("confirm-write-btn")
    ?.addEventListener("click", () => void confirmWriteFlow());
  document
    .getElementById("fetch-raid-btn")
    ?.addEventListener("click", () => openBlablalinkRaidPage());
  document
    .getElementById("auto-sync-btn")
    ?.addEventListener("click", () => void autoSyncMembers());

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
  // postmessage 모듈을 먼저 초기화하여 lastPayload 갱신 listener가 가장 먼저 등록되도록.
  // 그래야 inject 시 main listener에서 getLastPayload()가 이미 갱신된 값을 반환함.
  initMessageListener();

  window.addEventListener("authStateChange", () => {
    if (isAuthenticated() && getSheetId() !== null && lastDiagnostic === null) {
      void autoDiagnose();
    } else {
      renderApp();
    }
  });
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
  window.listSheetTabs = listSheetTabs;
  window.inspectMemberHeader = inspectMemberHeader;
  window.diagnoseSheet = diagnoseSheet;
  window.autofillMemberNicknames = autofillMemberNicknames;
  window.prepareDryRunFlow = prepareDryRunFlow;
  window.confirmWriteFlow = confirmWriteFlow;
  window.getBatchPlan = () => lastBatchPlan;
  window.autoSyncMembers = autoSyncMembers;

  window.addEventListener("sheetsWriteProgress", (e) => {
    const detail = (e as CustomEvent).detail as { stage: string; status: string };
    writeStages[detail.stage] = detail.status;
    renderApp();
  });
  window.addEventListener("sheetsWriteComplete", (e) => {
    const detail = (e as CustomEvent).detail as {
      raidNum: string;
      backupTabName: string;
    };
    writeStatus = "done";
    writeResult = { backupTabName: detail.backupTabName };
    console.info("[NRA-SPA] sheetsWriteComplete", detail);
    renderApp();
  });

  // 페이지 로드 시 자동 진단 (로그인 + 시트 둘 다 있을 때)
  if (isAuthenticated() && getSheetId() !== null) {
    void autoDiagnose();
  }

  renderApp();
  console.info(`[NRA-SPA] v${APP_VERSION} initialized`);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}
