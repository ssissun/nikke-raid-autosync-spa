// SPA 진입점 — F-NRA-002-02 OAuth 와이어링 적용.

import { getAccessToken, getEmail, getTokenExpiry, isAuthenticated, login, logout } from "./auth";
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
import {
  addUserFingerprint,
  clearStorage,
  getSheetId,
  getSheetName,
  getUserFingerprints,
} from "./storage";
import {
  prepareDryRun,
  type BatchUpdatePlan,
} from "./dryrun";
import {
  ALLOWED_FINGERPRINTS,
  appendRaidResultRow,
  computeFingerprint,
  ensureRaidColumn,
  guessNextRaidNum,
  writeRaidData,
} from "./sheets";
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
    computeFingerprintHelper?: () => Promise<string | null>;
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

// 변경 미리보기 (2-button 흐름) — payload 수신 시 자동 계산.
interface ChangesPreview {
  raidNum: string;
  leavingNicknames: string[]; // 시트에만 있는 닉네임 = 탈퇴
  joiningNicknames: string[]; // payload에만 있는 닉네임 = 신규
  raidStatsRowsCount: number;
  bossNames: string[]; // 이번 회차 보스 distinct list
  layout: "pre-migration" | "post-migration";
}
let lastChangesPreview: ChangesPreview | null = null;
let nonParticipatingNicknames: string[] | null = null;

// 신뢰 다이얼로그 (Hybrid fingerprint — BUILT_IN 미일치 시 사용자 옵트인)
interface TrustDialogState {
  hash: string;
  checkedItems: Set<string>;
}
let pendingTrust: TrustDialogState | null = null;

const TRUST_CHECKLIST: ReadonlyArray<{ id: string; label: string }> = [
  {
    id: "tab-union-member",
    label:
      "<code>유니온 멤버</code> 탭이 존재하며 헤더가 <code>가입 순서 / 닉네임</code> (또는 <code>가입 순서 / member_id / 닉네임</code>) 구조이다",
  },
  {
    id: "tab-raid-stats",
    label:
      "<code>레이드 통계</code> 탭이 존재하며 16개 컬럼 헤더(<code>회차 / 닉네임 / 보스명 / 단계 / 1~5번 자리·돌파 / 딜량 / 막타 여부</code>)가 정확히 일치한다",
  },
  {
    id: "tab-raid-result",
    label:
      "<code>레이드 결과</code> 탭이 존재하며 <code>회차</code> 컬럼이 있다",
  },
  {
    id: "is-operational",
    label:
      "본인이 운영하는 NIKKE 유니온 레이드 시트이다 (백업·테스트 사본 또는 다른 프로젝트 시트가 아님)",
  },
  {
    id: "header-untouched",
    label:
      "시트 헤더 컬럼명을 임의로 수정한 적 없거나, 수정했어도 도구 동작에 영향 없음을 확인했다",
  },
  {
    id: "responsibility",
    label:
      "잘못된 위치에 쓰이거나 데이터 손상 발생 시 본인이 복원 책임을 진다는 점에 동의한다",
  },
];

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
  await checkFingerprintTrust();
  renderApp();
}

/**
 * 시트 fingerprint 검증 — 진단 / 시트 선택 / 재진단 시점에 즉시 차단 알림.
 * Hybrid: BUILT_IN + USER_REGISTERED 매칭. 미일치 시 pendingTrust 설정.
 */
async function checkFingerprintTrust(): Promise<void> {
  const token = getAccessToken();
  const sheetId = getSheetId();
  if (token === null || sheetId === null) {
    pendingTrust = null;
    return;
  }
  try {
    const fingerprint = await computeFingerprint(sheetId, token);
    const allowed = [...ALLOWED_FINGERPRINTS, ...getUserFingerprints()];
    if (allowed.includes(fingerprint)) {
      pendingTrust = null;
    } else {
      // pendingTrust 이미 같은 hash 면 체크 상태 보존
      if (pendingTrust === null || pendingTrust.hash !== fingerprint) {
        pendingTrust = { hash: fingerprint, checkedItems: new Set() };
      }
    }
  } catch (e) {
    console.warn("[NRA-SPA] fingerprint check 실패 (진단 단계, 쓰기 단계 재검증):", e);
    pendingTrust = null;
  }
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
  // ?nra=1 — userscript SPA-only trigger 식별자
  // userscript 는 이 query param 이 있을 때만 active (일반 blablalink 사용 시 차단)
  const w = window.open(
    "https://www.blablalink.com/shiftyspad/union-raid?lang=ko&nra=1",
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
    // raid Col A 가 비어있거나 잘못된 회차로 들어왔으면 raidNumStr 으로 통일.
    // userscript 가 GetUnionRaidLevelInfo 미캡처 시 빈 또는 'null차' 가 들어올 수 있음.
    const targetLabel = `${raidNumStr}차`;
    const normalizedRaid = payload.raid.map((row) => {
      const next = [...row] as typeof row;
      next[0] = targetLabel;
      return next;
    });
    const plan = prepareDryRun({
      payload: { ...payload, raidNum: raidNumStr, raid: normalizedRaid },
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
      skipFingerprint: false,
      allowedFingerprints: [
        ...ALLOWED_FINGERPRINTS,
        ...getUserFingerprints(),
      ],
    });
    // `레이드 결과` 탭에도 새 회차 row 추가 (회차 컬럼만, 다른 컬럼 사용자 입력 대기)
    try {
      const rrResult = await appendRaidResultRow(
        sheetId,
        lastBatchPlan.raidNum,
        token
      );
      console.info(
        `[NRA-SPA] 레이드 결과 row 추가: ${rrResult.raidNumCol}${rrResult.sheetRow}` +
          (rrResult.alreadyExisted ? " (이미 존재)" : "")
      );
    } catch (e) {
      // 부수적 작업 — 실패해도 메인 쓰기는 성공으로 처리
      console.warn("[NRA-SPA] 레이드 결과 row 추가 실패 (치명적 아님):", e);
    }
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

/**
 * 2-button 흐름 1단계 — payload 수신 후 자동 호출.
 * 자동 매칭 + 변경사항 미리보기 계산. 실제 시트 변경 없음.
 */
async function previewChanges(): Promise<void> {
  const token = getAccessToken();
  const sheetId = getSheetId();
  const payload = getLastPayload();
  if (token === null || sheetId === null || payload === null) return;
  if (payload.type !== "nikke-raid-data") return;

  try {
    lastError = null;
    // 1) 자동 매칭
    clearSyncClassification();
    await startClassificationFlow(token, sheetId, payload.members);
    const classResult = getSyncClassification();
    if (classResult === null) return;

    // 2) raidNum 결정
    let raidNumStr: string;
    if (payload.raidNum !== undefined && payload.raidNum !== null) {
      raidNumStr = payload.raidNum;
    } else {
      const guessed = await guessNextRaidNum(sheetId, token);
      if (guessed === null) {
        lastError =
          "raidNum 결정 실패 — 유저스크립트 회차 메타 미캡처 + 시트 기존 회차 데이터도 부재";
        renderApp();
        return;
      }
      raidNumStr = guessed;
    }

    // 3) 변경사항 추출
    const leavingNicknames = classResult.unmatchedSheetNicknames.map(
      (u) => u.nickname
    );
    const joiningNicknames = classResult.unmatchedPayloadMembers.map(
      (m) => m.nickname
    );
    const bossSet = new Set<string>();
    for (const row of payload.raid) {
      const boss = row[2];
      if (typeof boss === "string" && boss.length > 0) bossSet.add(boss);
    }
    const layout =
      lastDiagnostic?.guessedFormat === "pre-migration"
        ? "pre-migration"
        : "post-migration";

    lastChangesPreview = {
      raidNum: raidNumStr,
      leavingNicknames,
      joiningNicknames,
      raidStatsRowsCount: payload.raid.length,
      bossNames: Array.from(bossSet),
      layout,
    };
    nonParticipatingNicknames = null;
    renderApp();
  } catch (e) {
    if (e instanceof SyncError) {
      lastError = `${e.code}: ${e.message}`;
    } else {
      lastError = e instanceof Error ? e.message : String(e);
    }
    console.error("[NRA-SPA] previewChanges error", e);
    renderApp();
  }
}

/**
 * 2-button 흐름 2단계 — 사용자 클릭으로 호출.
 * auto-sync (필요 시) → 재매칭 → dry-run plan → writeRaidData → appendRaidResultRow → 미참여 알림.
 */
async function applyAllChanges(): Promise<void> {
  const token = getAccessToken();
  const sheetId = getSheetId();
  const payload = getLastPayload();
  if (
    token === null ||
    sheetId === null ||
    payload === null ||
    payload.type !== "nikke-raid-data" ||
    lastChangesPreview === null
  ) {
    lastError = "조건 미충족 (로그인/시트/payload/preview 필요)";
    renderApp();
    return;
  }

  writeStatus = "running";
  for (const k of Object.keys(writeStages)) delete writeStages[k];
  writeResult = null;
  renderApp();

  try {
    lastError = null;

    // 0) Fingerprint 사전 검증 (Hybrid — BUILT_IN + USER_REGISTERED)
    const fingerprint = await computeFingerprint(sheetId, token);
    const allowed = [...ALLOWED_FINGERPRINTS, ...getUserFingerprints()];
    if (!allowed.includes(fingerprint)) {
      // 신뢰 다이얼로그 표시 — 사용자 옵트인 흐름 진입
      pendingTrust = { hash: fingerprint, checkedItems: new Set() };
      writeStatus = "idle";
      renderApp();
      return;
    }

    // 1) auto-sync (탈퇴/신규 있을 때만)
    const classResult = getSyncClassification();
    if (
      classResult !== null &&
      (classResult.unmatchedSheetNicknames.length > 0 ||
        classResult.unmatchedPayloadMembers.length > 0)
    ) {
      lastAutoSync = await applyMemberSync(
        sheetId,
        token,
        classResult.unmatchedSheetNicknames,
        classResult.unmatchedPayloadMembers,
        { layout: lastChangesPreview.layout }
      );
      console.info("[NRA-SPA] auto-sync 완료", lastAutoSync);
      // 시트 변경 후 재진단 + 재매칭 (member_id 매칭 새로)
      await diagnoseSheet();
      clearSyncClassification();
      await startClassificationFlow(token, sheetId, payload.members);
    }

    // 2) 회차 컬럼 보장
    const raidNumStr = lastChangesPreview.raidNum;
    const resolution = await ensureRaidColumn(
      sheetId,
      raidNumStr,
      token,
      fetch,
      lastChangesPreview.layout
    );
    const syncroColumn = resolution.column;

    // 3) dry-run plan
    const lastRaidRow = await getLastRaidRow(sheetId, token);
    const targetLabel = `${raidNumStr}차`;
    const normalizedRaid = payload.raid.map((row) => {
      const next = [...row] as typeof row;
      next[0] = targetLabel;
      return next;
    });
    const refreshedClass = getSyncClassification();
    if (refreshedClass === null) {
      throw new Error("재매칭 결과 부재");
    }
    const plan = prepareDryRun({
      payload: { ...payload, raidNum: raidNumStr, raid: normalizedRaid },
      classification: refreshedClass.classification,
      alerts: refreshedClass.alerts,
      lastRaidRow,
      syncroColumn,
    });
    lastBatchPlan = plan;

    // 4) 실제 쓰기 — Hybrid allowed list (BUILT_IN + USER_REGISTERED) 전달.
    //    사전 0 단계에서 이미 검증했지만 방어적 재검증 (allowed 일관 유지).
    const result = await writeRaidData(sheetId, plan, token, {
      skipFingerprint: false,
      allowedFingerprints: [
        ...ALLOWED_FINGERPRINTS,
        ...getUserFingerprints(),
      ],
    });

    // 5) 레이드 결과 row 추가 (부수)
    try {
      const rrResult = await appendRaidResultRow(sheetId, raidNumStr, token);
      console.info(
        `[NRA-SPA] 레이드 결과 row 추가: ${rrResult.raidNumCol}${rrResult.sheetRow}` +
          (rrResult.alreadyExisted ? " (이미 존재)" : "")
      );
    } catch (e) {
      console.warn("[NRA-SPA] 레이드 결과 row 추가 실패 (치명적 아님):", e);
    }

    // 6) 미참여 멤버 계산 — staying 닉네임 중 payload.raid 에 한 번도 안 나온 닉네임
    const participatingNames = new Set<string>();
    for (const row of payload.raid) {
      const nick = row[1];
      if (typeof nick === "string" && nick.length > 0) participatingNames.add(nick);
    }
    const allMemberNicknames = payload.members.map((m) => m.nickname);
    nonParticipatingNicknames = allMemberNicknames.filter(
      (n) => !participatingNames.has(n)
    );

    writeStatus = "done";
    writeResult = result;
  } catch (e) {
    writeStatus = "error";
    lastError = e instanceof Error ? e.message : String(e);
    console.error("[NRA-SPA] applyAllChanges error", e);
  }
  renderApp();
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

  const email = authed ? getEmail() : null;
  const authBlock = authed
    ? `
        <p class="status status--ok">✅ 로그인됨${email !== null ? ` · <strong>${escapeHtml(email)}</strong>` : ""}</p>
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
                  ${
                    pendingTrust !== null
                      ? `<p class="status status--error">⛔ 시트 구조 fingerprint 미등록 — 아래 신뢰 다이얼로그에서 검토 후 진행 가능</p>`
                      : `<p class="status status--ok">🔐 시트 구조 fingerprint 검증 통과</p>`
                  }
                `
          }
        `
      : authed && sheetId !== null
        ? `<p class="status">🔍 시트 진단 중...</p>`
        : "";

  // hash 미일치 시 이후 버튼 모두 비활성화 — 사용자가 신뢰 다이얼로그 통과 후에만 진행 가능
  const trustGate = pendingTrust !== null;
  const fetchTriggerBlock =
    authed && sheetId !== null
      ? `
          <h3>🎯 회차 데이터 수집</h3>
          <p class="meta">Tampermonkey + Greasyfork 유저스크립트 <code>579278</code> 설치 필요. 클릭 시 blablalink.com 새 탭이 열리고 자동으로 4 API를 intercept하여 본 페이지로 postMessage 송신.</p>
          <button type="button" id="fetch-raid-btn" ${trustGate ? "disabled" : ""}>🎯 신규 회차 데이터 가져오기 (blablalink 새 탭)</button>
        `
      : "";

  const payload = authed ? getLastPayload() : null;

  // 2-button 흐름 — payload 수신 시 자동으로 previewChanges 호출 → lastChangesPreview 채워짐.
  const payloadBlock = authed
    ? payload === null
      ? `
          <p class="status">📨 데이터 미수신 — <strong>🎯 신규 회차 데이터 가져오기</strong> 클릭 후 blablalink 새 탭에서 자동 수집 대기</p>
        `
      : payload.type === "nikke-raid-data"
        ? lastChangesPreview === null
          ? `<p class="status">📨 데이터 수신 — 변경사항 계산 중...</p>`
          : ""
        : `<p class="status">📨 payload type=${escapeHtml(payload.type)} — 처리 불가</p>`
    : "";

  const preview = lastChangesPreview;
  const previewBlock =
    preview !== null
      ? `
          <h3>📋 예상되는 변경사항</h3>
          <ul class="changes">
            <li><strong>회차</strong>: ${escapeHtml(preview.raidNum)}차</li>
            <li><strong>레이드 통계 신규 행</strong>: ${preview.raidStatsRowsCount}행</li>
            <li><strong>이번 회차 보스</strong> (${preview.bossNames.length}종): ${preview.bossNames.map((b) => escapeHtml(b)).join(" · ")}</li>
            <li><strong>탈퇴 멤버</strong> (${preview.leavingNicknames.length}명)${preview.leavingNicknames.length > 0 ? `: ${preview.leavingNicknames.map((n) => escapeHtml(n)).join(", ")}` : ""}</li>
            <li><strong>신규 가입 멤버</strong> (${preview.joiningNicknames.length}명)${preview.joiningNicknames.length > 0 ? `: ${preview.joiningNicknames.map((n) => escapeHtml(n)).join(", ")}` : ""}</li>
          </ul>
          ${
            writeStatus === "idle"
              ? `<button type="button" id="apply-all-btn" ${trustGate ? "disabled" : ""}>✅ 모든 변경 적용 (유니온 멤버 · 레이드 통계 · 레이드 결과)</button>`
              : ""
          }
          ${
            writeStatus === "running"
              ? `<p class="status">🔄 적용 중: <code>${escapeHtml(JSON.stringify(writeStages))}</code></p>`
              : ""
          }
          ${
            writeStatus === "done" && writeResult !== null
              ? `<p class="status status--ok">✅ 모든 변경 완료 · backup 탭 <code>${escapeHtml(writeResult.backupTabName)}</code></p>
                 ${
                   nonParticipatingNicknames !== null
                     ? nonParticipatingNicknames.length > 0
                       ? `<p class="status status--warn">⚠️ 이번 레이드 미참여 멤버 (${nonParticipatingNicknames.length}명): ${nonParticipatingNicknames.map((n) => escapeHtml(n)).join(", ")}</p>`
                       : `<p class="status status--ok">🎉 모든 멤버 참여 완료 — 미참여자 0명</p>`
                     : ""
                 }`
              : ""
          }
          ${
            writeStatus === "error"
              ? `<p class="status status--error">⚠️ 적용 실패: ${escapeHtml(lastError ?? "")}</p>`
              : ""
          }
        `
      : "";

  // Hybrid fingerprint 신뢰 다이얼로그 — BUILT_IN 미일치 시 사용자 옵트인
  const allChecked =
    pendingTrust !== null &&
    TRUST_CHECKLIST.every((item) => pendingTrust!.checkedItems.has(item.id));
  const trustBlock =
    pendingTrust !== null
      ? `
          <h3>⚠️ 등록되지 않은 시트 구조 감지</h3>
          <p class="status status--error">
            선택된 시트의 구조가 도구가 알고 있는 템플릿과 일치하지 않습니다.
          </p>
          <details open>
            <summary><strong>📛 발생 가능한 문제</strong></summary>
            <ul class="alerts">
              <li>도구가 정확히 의존하는 컬럼·탭 구조가 다르면 데이터가 잘못된 위치에 쓰여 시트 손상</li>
              <li>레이드 통계 16-col 매핑 어긋남 → 보스명/돌파/딜량 등이 잘못된 컬럼에 입력</li>
              <li>유니온 멤버 매칭 실패 또는 잘못된 멤버 row 에 syncro 입력</li>
              <li>backup 탭은 생성되지만 손상된 데이터 복원 부담은 사용자에게 있음</li>
            </ul>
          </details>
          <p class="meta">
            <strong>이 시트를 신뢰하려면 아래 항목을 모두 직접 확인 후 체크해주세요.</strong>
          </p>
          <ul class="trust-checklist">
            ${TRUST_CHECKLIST.map(
              (item) => `
              <li>
                <label>
                  <input type="checkbox" class="trust-check" data-id="${escapeHtml(item.id)}" ${pendingTrust!.checkedItems.has(item.id) ? "checked" : ""}>
                  <span>${item.label}</span>
                </label>
              </li>`
            ).join("")}
          </ul>
          <button type="button" id="trust-confirm-btn" ${allChecked ? "" : "disabled"}>✅ 이 시트를 신뢰하고 진행 (${pendingTrust.checkedItems.size}/${TRUST_CHECKLIST.length})</button>
          <p class="meta">신뢰하지 않으면 상단 <strong>[변경]</strong> 버튼으로 다른 시트를 선택해주세요.</p>
        `
      : "";

  // Legacy 변수 — UI 블록은 사용 안 하지만 DevTools 호출용 함수 보존을 위해 변수 유지
  const classification = authed ? getSyncClassification() : null;
  void classification;
  void lastAutoSync;
  void lastBatchPlan;
  void writeResult;

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
      ${trustBlock !== "" ? `<section class="trust">${trustBlock}</section>` : ""}
      ${fetchTriggerBlock !== "" ? `<section class="fetch-trigger">${fetchTriggerBlock}</section>` : ""}
      ${payloadBlock !== "" ? `<section class="payload">${payloadBlock}</section>` : ""}
      ${previewBlock !== "" ? `<section class="preview">${previewBlock}</section>` : ""}
      ${errorBlock}
      <section class="hint">
        <p>이 도구는 <code>blablalink.com</code> 새 탭에서 postMessage를 수신해 사본 시트를 자동으로 갱신합니다.</p>
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
  document
    .getElementById("apply-all-btn")
    ?.addEventListener("click", () => void applyAllChanges());

  // 신뢰 체크리스트 체크 이벤트 — pendingTrust.checkedItems 갱신 + 재렌더
  document.querySelectorAll<HTMLInputElement>(".trust-check").forEach((el) => {
    el.addEventListener("change", () => {
      if (pendingTrust === null) return;
      const id = el.dataset.id;
      if (id === undefined) return;
      if (el.checked) {
        pendingTrust.checkedItems.add(id);
      } else {
        pendingTrust.checkedItems.delete(id);
      }
      renderApp();
    });
  });

  document
    .getElementById("trust-confirm-btn")
    ?.addEventListener("click", () => {
      if (pendingTrust === null) return;
      const allDone = TRUST_CHECKLIST.every((it) =>
        pendingTrust!.checkedItems.has(it.id)
      );
      if (!allDone) return;
      addUserFingerprint(pendingTrust.hash);
      console.info(
        `[NRA-SPA] 사용자 신뢰 등록 — fingerprint: ${pendingTrust.hash.slice(0, 16)}...`
      );
      pendingTrust = null;
      // 자동 재시도 — applyAllChanges 재실행
      void applyAllChanges();
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
  window.addEventListener("payloadReceived", () => {
    // 2-button 흐름 — payload 수신 후 자동 매칭 + 변경사항 계산
    lastChangesPreview = null;
    nonParticipatingNicknames = null;
    lastBatchPlan = null;
    lastAutoSync = null;
    writeStatus = "idle";
    renderApp();
    void previewChanges();
  });
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
  window.computeFingerprintHelper = async () => {
    const token = getAccessToken();
    const sheetId = getSheetId();
    if (token === null || sheetId === null) {
      console.warn("[NRA-SPA] computeFingerprint: 로그인/시트 필요");
      return null;
    }
    const hash = await computeFingerprint(sheetId, token);
    console.info(`[NRA-SPA] 시트 fingerprint: ${hash}`);
    return hash;
  };

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
