// F-NRA-002-08 자동 멤버 sync — SHEET_SCHEMA §2.2 4·5번 따라 leaving row 삭제 + joining row 추가.
// 사용자 동의 후 호출. dry-run 전 시트를 매칭 100% 상태로 만든다.
//
// 동작:
//   1) leaving (시트 unmatched nicknames) → deleteDimension ROWS (역순)
//   2) Col A 재번호 (가입 순서 1..N)
//   3) joining (payload unmatched members) → 마지막 row+1 부터 추가
//   4) 32명 한도 검증

import type { GuildMember } from "../types";
import type { UnmatchedSheetNickname } from "../matching";

const UNION_MEMBER_SHEET = "유니온 멤버";
const MAX_MEMBERS = 32;

export interface AutoSyncOptions {
  fetchImpl?: typeof fetch;
  /** pre-migration (Col B = 닉네임) vs post-migration (Col B = member_id hidden, Col C = 닉네임) */
  layout?: "pre-migration" | "post-migration";
}

export interface AutoSyncResult {
  removedRows: number[]; // 삭제된 sheetRow 목록 (1-indexed, 원래 번호)
  addedRows: Array<{ sheetRow: number; nickname: string; member_id: string }>;
  reorderApplied: boolean;
}

interface SheetProperties {
  sheetId: number;
  title?: string;
  gridProperties?: { rowCount?: number; columnCount?: number };
}

interface SpreadsheetGetResponse {
  sheets?: Array<{ properties?: SheetProperties }>;
}

interface ValueRangeResponse {
  range: string;
  values?: string[][];
}

async function getMemberSheetId(
  spreadsheetId: string,
  accessToken: string,
  fetchImpl: typeof fetch
): Promise<number> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets(properties(sheetId,title))`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`AUTO_SYNC_SHEET_ID_FAILED: HTTP ${res.status}`);
  }
  const body = (await res.json()) as SpreadsheetGetResponse;
  const found = (body.sheets ?? []).find(
    (s) => s.properties?.title === UNION_MEMBER_SHEET
  );
  if (found === undefined || found.properties === undefined) {
    throw new Error(`AUTO_SYNC_SHEET_ID_FAILED: '${UNION_MEMBER_SHEET}' 탭 부재`);
  }
  return found.properties.sheetId;
}

async function readCurrentRowCount(
  spreadsheetId: string,
  accessToken: string,
  fetchImpl: typeof fetch
): Promise<number> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`${UNION_MEMBER_SHEET}!A:A`)}`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`AUTO_SYNC_READ_FAILED: HTTP ${res.status}`);
  }
  const body = (await res.json()) as ValueRangeResponse;
  const values = body.values ?? [];
  // 마지막 비어있지 않은 데이터 행 (header row1 제외)
  let lastDataRow = 1;
  for (let i = values.length - 1; i >= 1; i--) {
    if ((values[i][0] ?? "").trim().length > 0) {
      lastDataRow = i + 1;
      break;
    }
  }
  return lastDataRow;
}

async function deleteRowsBatch(
  spreadsheetId: string,
  sheetId: number,
  sheetRows: readonly number[],
  accessToken: string,
  fetchImpl: typeof fetch
): Promise<void> {
  if (sheetRows.length === 0) return;
  // 역순 정렬 — 위에서부터 삭제하면 아래 row 번호가 shift 되어 인덱스가 어긋남
  const sorted = [...sheetRows].sort((a, b) => b - a);
  const requests = sorted.map((row) => ({
    deleteDimension: {
      range: {
        sheetId,
        dimension: "ROWS" as const,
        startIndex: row - 1, // 0-based
        endIndex: row,
      },
    },
  }));
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`AUTO_SYNC_DELETE_FAILED: HTTP ${res.status} ${errText.slice(0, 120)}`);
  }
}

async function reorderColA(
  spreadsheetId: string,
  totalMembers: number,
  accessToken: string,
  fetchImpl: typeof fetch
): Promise<void> {
  // header=row1, data row 2..(totalMembers+1) Col A 에 1..totalMembers 입력
  if (totalMembers === 0) return;
  const range = `${UNION_MEMBER_SHEET}!A2:A${totalMembers + 1}`;
  const values: string[][] = [];
  for (let i = 1; i <= totalMembers; i++) {
    values.push([String(i)]);
  }
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  const res = await fetchImpl(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`AUTO_SYNC_REORDER_FAILED: HTTP ${res.status} ${errText.slice(0, 120)}`);
  }
}

async function appendJoiningRows(
  spreadsheetId: string,
  members: readonly GuildMember[],
  startSheetRow: number,
  layout: "pre-migration" | "post-migration",
  accessToken: string,
  fetchImpl: typeof fetch
): Promise<void> {
  if (members.length === 0) return;
  // pre-migration: A=가입순서, B=닉네임
  // post-migration: A=가입순서, B=member_id (hidden), C=닉네임
  const values: string[][] = members.map((m, i) => {
    const order = String(startSheetRow + i - 1); // sheetRow 1-indexed - 1 = order
    if (layout === "pre-migration") {
      return [order, m.nickname];
    }
    return [order, m.member_id, m.nickname];
  });
  const endRow = startSheetRow + members.length - 1;
  const endCol = layout === "pre-migration" ? "B" : "C";
  const range = `${UNION_MEMBER_SHEET}!A${startSheetRow}:${endCol}${endRow}`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  const res = await fetchImpl(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`AUTO_SYNC_APPEND_FAILED: HTTP ${res.status} ${errText.slice(0, 120)}`);
  }
}

/**
 * 자동 멤버 동기화 — leaving 삭제 + Col A 재번호 + joining 추가.
 * dry-run 전에 호출하여 시트를 매칭 100% 상태로 만든다.
 */
export async function applyMemberSync(
  spreadsheetId: string,
  accessToken: string,
  unmatchedSheetNicknames: readonly UnmatchedSheetNickname[],
  joiningMembers: readonly GuildMember[],
  options: AutoSyncOptions = {}
): Promise<AutoSyncResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const layout = options.layout ?? "post-migration";

  const sheetId = await getMemberSheetId(
    spreadsheetId,
    accessToken,
    fetchImpl
  );

  // 1) leaving 삭제
  const leavingRows = unmatchedSheetNicknames.map((u) => u.sheetRow);
  await deleteRowsBatch(spreadsheetId, sheetId, leavingRows, accessToken, fetchImpl);

  // 2) 현재 시트 데이터 행 개수 재확인
  const lastDataRow = await readCurrentRowCount(
    spreadsheetId,
    accessToken,
    fetchImpl
  );
  const totalMembersAfterDelete = Math.max(0, lastDataRow - 1); // header=1

  // 3) 32명 한도 검증
  const totalAfterAppend = totalMembersAfterDelete + joiningMembers.length;
  if (totalAfterAppend > MAX_MEMBERS) {
    throw new Error(
      `AUTO_SYNC_LIMIT_EXCEEDED: ${totalAfterAppend}명 → 32명 한도 초과`
    );
  }

  // 4) Col A 재번호 (삭제 후)
  await reorderColA(
    spreadsheetId,
    totalMembersAfterDelete,
    accessToken,
    fetchImpl
  );

  // 5) joining 추가
  const startSheetRow = lastDataRow + 1; // 헤더 row1 + 데이터 row 다음
  await appendJoiningRows(
    spreadsheetId,
    joiningMembers,
    startSheetRow,
    layout,
    accessToken,
    fetchImpl
  );

  const addedRows = joiningMembers.map((m, i) => ({
    sheetRow: startSheetRow + i,
    nickname: m.nickname,
    member_id: m.member_id,
  }));

  return {
    removedRows: leavingRows,
    addedRows,
    reorderApplied: totalMembersAfterDelete > 0,
  };
}
