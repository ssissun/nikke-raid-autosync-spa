// SPA 진입점 — F-NRA-002-02 OAuth 와이어링 적용.

import "./style.css";
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
  prepareRoundBatchUpdate,
  type BatchUpdatePlan,
} from "./dryrun";
import {
  ALLOWED_FINGERPRINTS,
  appendRaidResultRow,
  applyMultiRoundWrite,
  computeFingerprint,
  ensureRaidColumn,
  guessNextRaidNum,
  migrateToMemberId,
  readExistingRaidNums,
  writeRaidData,
} from "./sheets";
import { applyMemberSync, type AutoSyncResult } from "./sync/auto-sync";
import { normalizePayload, type NormalizedMultiPayload } from "./payload/normalize";
import { selectMissingRounds } from "./payload/round-planner";
import type { NikkeRaidPayload, ProcessedRaidRow } from "./types";
import type { NicknameChange } from "./matching/types";

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
let writeResult: { backupTabName: string; writtenRaidNums?: string[] } | null = null;

// 회차별 미리보기 요약
interface RoundPreview {
  raidNum: string;
  raidStatsRowsCount: number;
  bossNames: string[];
}

// 변경 미리보기 (2-button 흐름) — payload 수신 시 자동 계산.
interface ChangesPreview {
  targetRaidNums: string[]; // 처리 대상 회차 (오름차순)
  alreadyInSheet: string[]; // 시트에 이미 있어 skip
  unavailableButRequested: string[]; // 가용 목록엔 있으나 데이터 없는 회차
  rounds: RoundPreview[]; // 회차별 요약
  // 멤버 변동(auto-sync)은 현재 멤버 기준 1회 — 회차별 아님
  leavingNicknames: string[]; // 시트에만 있는 닉네임 = 탈퇴
  joiningNicknames: string[]; // payload에만 있는 닉네임 = 신규
  nicknameChanges: NicknameChange[]; // staying 멤버 중 닉네임이 바뀐 항목
  layout: "pre-migration" | "post-migration";
  needsMemberIdMigration: boolean; // layout === pre-migration 일 때 true
}
let lastChangesPreview: ChangesPreview | null = null;
let lastNormalized: NormalizedMultiPayload | null = null; // previewChanges → applyAllChanges 전달
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

// 시트 기존 회차 집합 — userscript 백필 핸드셰이크(from + need) 계산용. autoDiagnose 시 캐시.
let lastExistingRounds: Set<string> = new Set();
let lastMaxExistingRound: number | null = null;

async function refreshExistingRounds(): Promise<void> {
  const token = getAccessToken();
  const sheetId = getSheetId();
  if (token === null || sheetId === null) {
    lastExistingRounds = new Set();
    lastMaxExistingRound = null;
    return;
  }
  try {
    const existing = await readExistingRaidNums(sheetId, token);
    lastExistingRounds = existing;
    let max = 0;
    for (const n of existing) {
      const v = Number(n);
      if (Number.isFinite(v) && v > max) max = v;
    }
    lastMaxExistingRound = max > 0 ? max : null;
  } catch (e) {
    console.warn("[NRA-SPA] readExistingRaidNums 실패:", e);
    lastExistingRounds = new Set();
    lastMaxExistingRound = null;
  }
}

// interior gap — 시트 기존 회차 범위 [min,max] 안에서 빠진 회차 (오름차순).
// 최근 MAX_GAP_NEED 개로 제한 (블라가 과거 회차 미제공 → 오래된 gap 은 어차피 빈 응답).
const MAX_GAP_NEED = 15;
function computeInteriorGaps(existing: ReadonlySet<string>): number[] {
  const nums = [...existing].map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (nums.length < 2) return [];
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const present = new Set(nums);
  const gaps: number[] = [];
  for (let r = min + 1; r < max; r++) {
    if (!present.has(r)) gaps.push(r);
  }
  // 최근(높은) gap 우선 — 블라 제공 한도 내에서만 의미
  return gaps.slice(-MAX_GAP_NEED);
}

async function autoDiagnose(): Promise<void> {
  await diagnoseSheet();
  await checkFingerprintTrust();
  await refreshExistingRounds();
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
  // &from={n} — tail 백필 시작 회차 (시트 max 기존 회차 + 1). userscript 가 from~현재 수집.
  //   시트가 비었으면 from 생략 → userscript 가 가용한 과거 회차까지 백필.
  // &need={a,b} — interior gap 회차 (시트 기존 범위 안에서 빠진 회차). gap-aware 백필.
  //   둘 다 블라 제공 한도 내에서만 동작 (빈 응답 회차는 userscript 가 자동 skip).
  const fromRound =
    lastMaxExistingRound !== null && lastMaxExistingRound > 0
      ? lastMaxExistingRound + 1
      : null;
  const gaps = computeInteriorGaps(lastExistingRounds);
  const fromParam = fromRound !== null ? `&from=${fromRound}` : "";
  const needParam = gaps.length > 0 ? `&need=${gaps.join(",")}` : "";
  const w = window.open(
    `https://www.blablalink.com/shiftyspad/union-raid?lang=ko&nra=1${fromParam}${needParam}`,
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
function bossNamesOf(rows: readonly ProcessedRaidRow[]): string[] {
  const set = new Set<string>();
  for (const row of rows) {
    const boss = row[2];
    if (typeof boss === "string" && boss.length > 0) set.add(boss);
  }
  return Array.from(set);
}

async function previewChanges(): Promise<void> {
  const token = getAccessToken();
  const sheetId = getSheetId();
  const payload = getLastPayload();
  if (token === null || sheetId === null || payload === null) return;
  if (payload.type !== "nikke-raid-data" && payload.type !== "nikke-raid-multi") {
    return;
  }

  try {
    lastError = null;

    // 0) 정규화 (single/multi → 다회차 정규형)
    const normalized = normalizePayload(payload);
    if (normalized === null) return;
    lastNormalized = normalized;

    // 1) 자동 매칭 (현재 멤버 기준 1회)
    clearSyncClassification();
    await startClassificationFlow(token, sheetId, normalized.members);
    const classResult = getSyncClassification();
    if (classResult === null) return;

    // 2) 시트 기존 회차 → 누락 회차 선별
    const existing = await readExistingRaidNums(sheetId, token);
    let selection = selectMissingRounds(normalized, existing);

    // fallback: 회차 정보 전무(레거시 single, raidNum 부재로 round 0개) → guessNextRaidNum
    if (
      selection.targetRounds.length === 0 &&
      normalized.rounds.length === 0
    ) {
      const guessed = await guessNextRaidNum(sheetId, token);
      if (guessed !== null && payload.type === "nikke-raid-data") {
        // 단일 추측 회차로 normalized 보강
        const syncro: Record<string, number> = {};
        for (const m of normalized.members) {
          if (m.synchro_level > 0) syncro[m.member_id] = m.synchro_level;
        }
        const fallbackRound = {
          raidNum: guessed,
          raid: payload.raid,
          memberSyncroLevels: syncro,
        };
        lastNormalized = { ...normalized, rounds: [fallbackRound] };
        selection = {
          targetRounds: [fallbackRound],
          alreadyInSheet: [],
          unavailableButRequested: [],
        };
      }
    }

    const layout =
      lastDiagnostic?.guessedFormat === "pre-migration"
        ? "pre-migration"
        : "post-migration";

    lastChangesPreview = {
      targetRaidNums: selection.targetRounds.map((r) => r.raidNum),
      alreadyInSheet: selection.alreadyInSheet,
      unavailableButRequested: selection.unavailableButRequested,
      rounds: selection.targetRounds.map((r) => ({
        raidNum: r.raidNum,
        raidStatsRowsCount: r.raid.length,
        bossNames: bossNamesOf(r.raid),
      })),
      leavingNicknames: classResult.unmatchedSheetNicknames.map((u) => u.nickname),
      joiningNicknames: classResult.unmatchedPayloadMembers.map((m) => m.nickname),
      nicknameChanges: classResult.nicknameChanges,
      layout,
      needsMemberIdMigration: layout === "pre-migration",
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
  if (
    token === null ||
    sheetId === null ||
    lastChangesPreview === null ||
    lastNormalized === null
  ) {
    lastError = "조건 미충족 (로그인/시트/payload/preview 필요)";
    renderApp();
    return;
  }
  const preview = lastChangesPreview;
  const normalized = lastNormalized;

  if (preview.targetRaidNums.length === 0) {
    lastError = "처리할 회차 없음 — 시트가 이미 최신 상태입니다.";
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
    const allowedFp = [...ALLOWED_FINGERPRINTS, ...getUserFingerprints()];
    if (!allowedFp.includes(fingerprint)) {
      pendingTrust = { hash: fingerprint, checkedItems: new Set() };
      writeStatus = "idle";
      renderApp();
      return;
    }

    // 0.5) Pre→Post member_id 마이그레이션 (1회). 회차 무관.
    if (preview.needsMemberIdMigration) {
      const classResult = getSyncClassification();
      if (classResult === null) throw new Error("마이그레이션 진행 불가 — 매칭 결과 부재");
      const memberIdByRow = new Map<number, string>();
      for (const s of classResult.classification.staying) {
        memberIdByRow.set(s.sheetRow, s.member_id);
      }
      const migrateResult = await migrateToMemberId(sheetId, token, memberIdByRow);
      console.info(`[NRA-SPA] member_id 마이그레이션 완료 (${migrateResult.filledRows}건)`);
      preview.layout = "post-migration";
      preview.needsMemberIdMigration = false;
      await diagnoseSheet();
    }

    // 1) auto-sync (현재 멤버 기준 1회 — 탈퇴/신규 있을 때만)
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
        { layout: preview.layout }
      );
      console.info("[NRA-SPA] auto-sync 완료", lastAutoSync);
      await diagnoseSheet();
      clearSyncClassification();
      await startClassificationFlow(token, sheetId, normalized.members);
    }

    const refreshedClass = getSyncClassification();
    if (refreshedClass === null) throw new Error("재매칭 결과 부재");

    // 2) 회차 루프 — ensureRaidColumn 순차 + prepareRoundBatchUpdate (lastRaidRow 누적)
    const roundByNum = new Map(normalized.rounds.map((r) => [r.raidNum, r]));
    let cumLastRaidRow = await getLastRaidRow(sheetId, token);
    const plans: BatchUpdatePlan[] = [];
    for (const raidNum of preview.targetRaidNums) {
      const round = roundByNum.get(raidNum);
      if (round === undefined) continue;
      const resolution = await ensureRaidColumn(
        sheetId,
        raidNum,
        token,
        fetch,
        preview.layout
      );
      // index 0 라벨을 `${raidNum}차` 로 정규화
      const targetLabel = `${raidNum}차`;
      const normalizedRaid = round.raid.map((row) => {
        const next = [...row] as ProcessedRaidRow;
        next[0] = targetLabel;
        return next;
      });
      const plan = prepareRoundBatchUpdate({
        classification: refreshedClass.classification,
        alerts: refreshedClass.alerts,
        raidNum,
        raidRows: normalizedRaid,
        roundSyncroLevels: round.memberSyncroLevels,
        members: normalized.members,
        lastRaidRow: cumLastRaidRow,
        syncroColumn: resolution.column,
      });
      plans.push(plan);
      cumLastRaidRow += plan.raidStatsRows.length;
    }
    lastBatchPlan = plans[plans.length - 1] ?? null;

    // 3) 통합 쓰기 — fingerprint 1회 + backup 1회(라벨=max 회차) + executeBatchUpdate N회
    const maxRaidNum = preview.targetRaidNums
      .map((n) => Number(n))
      .reduce((a, b) => Math.max(a, b), 0)
      .toString();
    const result = await applyMultiRoundWrite({
      spreadsheetId: sheetId,
      accessToken: token,
      plans,
      backupRaidNum: maxRaidNum,
      allowedFingerprints: allowedFp,
    });
    console.info("[NRA-SPA] 다회차 쓰기 완료:", result.writtenRaidNums.join(", "));

    // 4) 레이드 결과 row 추가 — 회차별 (idempotent)
    for (const raidNum of result.writtenRaidNums) {
      try {
        const rr = await appendRaidResultRow(sheetId, raidNum, token);
        console.info(
          `[NRA-SPA] 레이드 결과 row: ${rr.raidNumCol}${rr.sheetRow}` +
            (rr.alreadyExisted ? " (이미 존재)" : "")
        );
      } catch (e) {
        console.warn(`[NRA-SPA] 레이드 결과 row 추가 실패 ${raidNum}차 (치명적 아님):`, e);
      }
    }

    // 5) 미참여 멤버 — 최신(max) 회차 기준
    const latestNum = result.writtenRaidNums
      .map((n) => Number(n))
      .reduce((a, b) => Math.max(a, b), 0)
      .toString();
    const latestRound = roundByNum.get(latestNum);
    if (latestRound) {
      const participating = new Set<string>();
      for (const row of latestRound.raid) {
        const nick = row[1];
        if (typeof nick === "string" && nick.length > 0) participating.add(nick);
      }
      nonParticipatingNicknames = normalized.members
        .map((m) => m.nickname)
        .filter((n) => !participating.has(n));
    } else {
      nonParticipatingNicknames = null;
    }

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
        <p class="status">시작하려면 Google 계정으로 로그인해주세요.</p>
        <button type="button" id="login-btn">Google 로그인</button>
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
          <p class="status">본인이 만든 NIKKE 유레 시트 사본을 선택해주세요.</p>
          <button type="button" id="select-sheet-btn">시트 선택</button>
        `
    : "";

  const diag = authed && sheetId !== null ? lastDiagnostic : null;
  const diagBlock =
    diag !== null
      ? `
          <h3>🔍 시트 검증 <button type="button" id="rediag-btn" class="inline">↻ 다시 검증</button></h3>
          ${
            diag.error !== undefined
              ? `<p class="status status--error">시트 정보를 읽을 수 없습니다. 다시 시도해주세요.</p>`
              : `
                  ${
                    pendingTrust !== null
                      ? `<p class="status status--error">⛔ 이 시트는 도구가 알고 있는 구조와 일치하지 않습니다. 아래 안내를 확인해주세요.</p>`
                      : diag.guessedFormat === "empty"
                        ? `<p class="status status--warn">⚠️ 시트가 비어있습니다. <strong>유니온 멤버</strong> 탭에 가입 순서대로 닉네임을 32명 입력한 뒤 <strong>[↻ 다시 검증]</strong>을 눌러주세요.</p>`
                        : `<p class="status status--ok">✅ 시트 구조 검증 통과 (유니온 멤버 ${diag.colBNonEmpty + diag.colCNonEmpty > 0 ? `${Math.max(diag.colBNonEmpty, diag.colCNonEmpty)}명 인식` : ""})</p>`
                  }
                `
          }
        `
      : authed && sheetId !== null
        ? `<p class="status">🔍 시트 검증 중...</p>`
        : "";

  // hash 미일치 시 이후 버튼 모두 비활성화 — 사용자가 신뢰 다이얼로그 통과 후에만 진행 가능
  const trustGate = pendingTrust !== null;
  const fetchTriggerBlock =
    authed && sheetId !== null
      ? `
          <h3>🎯 회차 데이터 가져오기</h3>
          <p class="meta">
            아래 버튼을 누르면 blablalink.com이 새 탭에서 열리고, 회차 데이터를 자동으로 수집해서 이 페이지로 가져옵니다.
          </p>
          <p class="meta">
            처음 사용하시는 분은
            <a href="https://www.tampermonkey.net/" target="_blank" rel="noopener noreferrer">Tampermonkey 확장프로그램</a>과
            <a href="https://greasyfork.org/scripts/579278" target="_blank" rel="noopener noreferrer">전용 유저스크립트</a>를 먼저 설치해주세요.
          </p>
          <button type="button" id="fetch-raid-btn" ${trustGate ? "disabled" : ""}>🎯 신규 회차 데이터 가져오기</button>
        `
      : "";

  const payload = authed ? getLastPayload() : null;

  // 2-button 흐름 — payload 수신 시 자동으로 previewChanges 호출 → lastChangesPreview 채워짐.
  const payloadBlock = authed && sheetId !== null && !trustGate
    ? payload === null
      ? ""
      : payload.type === "nikke-raid-data" || payload.type === "nikke-raid-multi"
        ? lastChangesPreview === null
          ? `<p class="status">📨 데이터를 받았습니다. 변경사항을 계산 중...</p>`
          : ""
        : `<p class="status status--warn">데이터를 가져오지 못했습니다. blablalink 로그인 상태와 유저스크립트 설치를 확인해주세요.</p>`
    : "";

  const preview = lastChangesPreview;
  const totalNewRows = preview
    ? preview.rounds.reduce((a, r) => a + r.raidStatsRowsCount, 0)
    : 0;
  const noTarget = preview !== null && preview.targetRaidNums.length === 0;
  const previewBlock =
    preview !== null
      ? `
          <h3>📋 예상되는 변경사항</h3>
          ${
            noTarget
              ? `<p class="status status--ok">✅ 시트가 이미 최신 상태입니다. 추가할 회차가 없습니다.${preview.alreadyInSheet.length > 0 ? ` (시트 보유 회차: ${preview.alreadyInSheet.map((n) => escapeHtml(n) + "차").join(", ")})` : ""}</p>`
              : `
          <ul class="changes">
            <li><strong>처리할 회차</strong> (${preview.targetRaidNums.length}개): ${preview.targetRaidNums.map((n) => escapeHtml(n) + "차").join(" · ")}</li>
            ${preview.alreadyInSheet.length > 0 ? `<li><strong>이미 시트에 있어 skip</strong>: ${preview.alreadyInSheet.map((n) => escapeHtml(n) + "차").join(", ")}</li>` : ""}
            ${preview.unavailableButRequested.length > 0 ? `<li class="status--warn"><strong>데이터 없는 회차</strong>: ${preview.unavailableButRequested.map((n) => escapeHtml(n) + "차").join(", ")}</li>` : ""}
            <li><strong>레이드 통계 신규 행</strong>: 총 ${totalNewRows}행</li>
            <li><strong>탈퇴 멤버</strong> (${preview.leavingNicknames.length}명)${preview.leavingNicknames.length > 0 ? `: ${preview.leavingNicknames.map((n) => escapeHtml(n)).join(", ")}` : ""}</li>
            <li><strong>신규 가입 멤버</strong> (${preview.joiningNicknames.length}명)${preview.joiningNicknames.length > 0 ? `: ${preview.joiningNicknames.map((n) => escapeHtml(n)).join(", ")}` : ""}</li>
            <li><strong>닉네임 변경 멤버</strong> (${preview.nicknameChanges.length}명)${preview.nicknameChanges.length > 0 ? `: ${preview.nicknameChanges.map((c) => `${escapeHtml(c.old)} → ${escapeHtml(c.new)}`).join(", ")}` : ""}</li>
            ${
              preview.needsMemberIdMigration
                ? `<li><strong>최초 1회 자동 작업</strong>: 시트 <code>유니온 멤버</code> 탭에 <code>member_id</code> 숨김 컬럼이 자동 추가됩니다 (다음 사용부터 닉네임 변경에도 매칭이 정확히 유지됨)</li>`
                : ""
            }
          </ul>
          <details>
            <summary>회차별 상세 (${preview.rounds.length}개)</summary>
            <ul class="changes">
              ${preview.rounds.map((r) => `<li><strong>${escapeHtml(r.raidNum)}차</strong>: ${r.raidStatsRowsCount}행 · 보스 ${r.bossNames.length}종 (${r.bossNames.map((b) => escapeHtml(b)).join(" · ")})</li>`).join("")}
            </ul>
          </details>
          <p class="meta">⚠️ 과거 회차의 싱크로 레벨은 현재 잔류 멤버 기준으로만 기록됩니다 (그 시점 탈퇴 멤버 제외).</p>
              `
          }
          ${
            writeStatus === "idle" && !noTarget
              ? `<button type="button" id="apply-all-btn" ${trustGate ? "disabled" : ""}>✅ 모든 변경 적용 (${preview.targetRaidNums.length}개 회차)</button>`
              : ""
          }
          ${
            writeStatus === "running"
              ? `<p class="status">🔄 적용 중: <code>${escapeHtml(JSON.stringify(writeStages))}</code></p>`
              : ""
          }
          ${
            writeStatus === "done" && writeResult !== null
              ? `<p class="status status--ok">✅ ${writeResult.writtenRaidNums && writeResult.writtenRaidNums.length > 0 ? `${writeResult.writtenRaidNums.map((n) => escapeHtml(n) + "차").join("·")} 적용 완료` : "모든 변경 완료"} · backup 탭 <code>${escapeHtml(writeResult.backupTabName)}</code></p>
                 ${
                   nonParticipatingNicknames !== null
                     ? nonParticipatingNicknames.length > 0
                       ? `<p class="status status--warn">⚠️ 최신 회차 미참여 멤버 (${nonParticipatingNicknames.length}명): ${nonParticipatingNicknames.map((n) => escapeHtml(n)).join(", ")}</p>`
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
            <summary><strong>📛 그대로 진행하면 발생할 수 있는 문제</strong></summary>
            <ul class="alerts">
              <li>시트의 잘못된 위치에 데이터가 입력되어 기존 데이터가 손상될 수 있습니다.</li>
              <li>레이드 결과의 보스명·돌파·딜량 등이 잘못된 칸에 들어갈 수 있습니다.</li>
              <li>멤버 매칭이 실패하거나 다른 멤버 행에 싱크로 레벨이 입력될 수 있습니다.</li>
              <li>백업 탭은 자동 생성되지만, 손상된 데이터 복원은 사용자가 직접 해야 합니다.</li>
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
      <h1>NIKKE 유레 자동 동기화 도구</h1>
      <p class="meta">레이드 결과 + 멤버 싱크로 레벨을 본인 시트 사본에 자동 입력</p>
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
        <p>처음 사용하시는 분은 <a href="https://github.com/ssissun/nikke-raid-autosync-spa/blob/main/SIMPLE_USER_GUIDE.md" target="_blank" rel="noopener noreferrer">간편 가이드</a> 또는 <a href="https://github.com/ssissun/nikke-raid-autosync-spa/blob/main/USER_GUIDE.md" target="_blank" rel="noopener noreferrer">전체 사용자 가이드</a>를 확인해주세요.</p>
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
    lastNormalized = null;
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
