// F-NRA-002-08 자동 멤버 sync — 옵션 D (data shift) 방식.
// 사용자 SHEET_SCHEMA 보강: row delete 대신 데이터만 위로 shift (Col A 가입순서 보존).
//
// 동작:
//   1) 시트 전체 read (가입 순서 32명 row + 헤더)
//   2) leaving sheetRows 를 큰 순서대로 처리 — 각 leaving row 아래 데이터를 한 칸 위로 shift (Col B~끝)
//   3) joining members 를 빈 닉네임 슬롯 (위에서부터) 에 채움
//   4) 32명 정원 검증 — 빈 슬롯 < joining 수면 throw
//   5) 시트 전체 write (Col B~ 만, Col A 가입순서는 1..N 으로 normalize)

import type { GuildMember } from "../types";
import type { UnmatchedSheetNickname } from "../matching";

const UNION_MEMBER_SHEET = "유니온 멤버";
const MAX_MEMBERS = 32;

export interface AutoSyncOptions {
  fetchImpl?: typeof fetch;
  /** pre-migration: Col B = 닉네임. post-migration: Col B = member_id (hidden), Col C = 닉네임. */
  layout?: "pre-migration" | "post-migration";
}

export interface AutoSyncResult {
  removedRows: number[]; // leaving 처리한 원래 sheetRow (1-indexed)
  addedRows: Array<{ sheetRow: number; nickname: string; member_id: string }>;
  emptySlotsBefore: number;
  emptySlotsAfter: number;
}

interface ValueRangeResponse {
  range: string;
  values?: string[][];
}

/**
 * pre-migration 의 닉네임 컬럼 index (0-based) — Col B = 1.
 * post-migration: Col C = 2.
 */
function getNicknameColIdx(layout: "pre-migration" | "post-migration"): number {
  return layout === "pre-migration" ? 1 : 2;
}

async function readMemberRows(
  spreadsheetId: string,
  accessToken: string,
  fetchImpl: typeof fetch
): Promise<string[][]> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`${UNION_MEMBER_SHEET}!A1:Z33`)}`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`AUTO_SYNC_READ_FAILED: HTTP ${res.status}`);
  }
  const body = (await res.json()) as ValueRangeResponse;
  return body.values ?? [];
}

async function writeMemberRows(
  spreadsheetId: string,
  values: readonly string[][],
  accessToken: string,
  fetchImpl: typeof fetch
): Promise<void> {
  if (values.length === 0) return;
  // 일관된 컬럼 너비로 padding
  const maxCols = Math.max(...values.map((r) => r.length), 1);
  const padded = values.map((r) => {
    if (r.length === maxCols) return [...r];
    return [...r, ...Array<string>(maxCols - r.length).fill("")];
  });
  const endRow = values.length;
  const endColLetter = String.fromCharCode(64 + maxCols); // 1→A, 2→B, ..., 7→G
  const range = `${UNION_MEMBER_SHEET}!A1:${endColLetter}${endRow}`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  const res = await fetchImpl(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values: padded }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`AUTO_SYNC_WRITE_FAILED: HTTP ${res.status} ${errText.slice(0, 200)}`);
  }
}

/**
 * data shift up — 큰 sheetRow 부터 처리하여 인덱스 어긋남 방지.
 * leaving row 의 데이터를 비우고 아래 row 데이터를 한 칸씩 위로 이동.
 * Col A (가입순서) 는 별도로 normalize 하므로 여기서 건드리지 않음.
 *
 * @param rows  data rows (header 제외). 0-indexed 배열에서 i 번째가 sheetRow (i+2).
 * @param leavingSheetRows  1-indexed sheetRow 목록.
 * @param nicknameColIdx  닉네임 컬럼의 0-based index.
 */
function shiftRowsUp(
  rows: string[][],
  leavingSheetRows: readonly number[],
  nicknameColIdx: number
): void {
  // 1-indexed sheetRow → 0-indexed data row (sheetRow - 2, header=row1).
  const leavingIdx = leavingSheetRows
    .map((r) => r - 2)
    .filter((i) => i >= 0 && i < rows.length)
    .sort((a, b) => b - a); // 큰 idx 부터

  for (const idx of leavingIdx) {
    // idx 위치를 빈으로 만든 뒤 아래 행 데이터를 한 칸씩 위로 shift.
    // Col A (idx 0) 은 건드리지 않음 — 마지막에 normalize.
    for (let i = idx; i < rows.length - 1; i++) {
      const next = rows[i + 1] ?? [];
      // Col B (idx 1) 이후 모두 복사
      const maxCols = Math.max(rows[i]?.length ?? 0, next.length);
      for (let c = 1; c < maxCols; c++) {
        const val = next[c] ?? "";
        if (rows[i] === undefined) rows[i] = [];
        // Col A 는 그대로
        if (c === 0) continue;
        rows[i][c] = val;
      }
    }
    // 마지막 row 의 Col B 이후 클리어
    const last = rows[rows.length - 1];
    if (last !== undefined) {
      for (let c = 1; c < last.length; c++) {
        last[c] = "";
      }
    }
    // 닉네임이 한 칸씩 올라왔으니 leaving 처리는 끝
    // 다음 leaving idx 처리 시에는 이미 shift 된 상태에서 진행됨 — 큰 idx 부터 처리하므로 영향 없음
    // 다만 마지막 row 가 비었음을 활용해야 함
  }
  // last row 가 비어있도록 유지된 상태
}

/**
 * 빈 닉네임 슬롯 (위에서부터) 에 joining members 채움.
 * pre-migration: Col B = 닉네임만 입력.
 * post-migration: Col B = member_id (hidden), Col C = 닉네임.
 *
 * @returns 채워진 sheetRow 목록 (1-indexed).
 */
function fillJoiningSlots(
  rows: string[][],
  joiningMembers: readonly GuildMember[],
  layout: "pre-migration" | "post-migration",
  nicknameColIdx: number
): number[] {
  const filledSheetRows: number[] = [];
  let joiningIdx = 0;
  for (let i = 0; i < rows.length && joiningIdx < joiningMembers.length; i++) {
    const row = rows[i];
    if (row === undefined) continue;
    const currentNickname = (row[nicknameColIdx] ?? "").trim();
    if (currentNickname.length > 0) continue; // 닉네임 채워진 row 스킵
    const m = joiningMembers[joiningIdx];
    // 닉네임 + (post-migration 이면 member_id) 입력
    row[nicknameColIdx] = m.nickname;
    if (layout === "post-migration") {
      row[1] = m.member_id;
    }
    filledSheetRows.push(i + 2); // 0-indexed → 1-indexed sheetRow (header=row1)
    joiningIdx++;
  }
  if (joiningIdx < joiningMembers.length) {
    const remaining = joiningMembers.length - joiningIdx;
    throw new Error(
      `AUTO_SYNC_LIMIT_EXCEEDED: 정원 ${MAX_MEMBERS}명 초과 — 빈 슬롯 ${filledSheetRows.length}개에 ${joiningMembers.length}명 추가 시도, ${remaining}명 미처리`
    );
  }
  return filledSheetRows;
}

/**
 * Col A 가입순서를 1..N 으로 normalize (N = 데이터 row 개수).
 * 닉네임 채워진 row 만이 아니라 전체 데이터 row 에 대해 적용.
 */
function normalizeColA(rows: string[][]): void {
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] === undefined) rows[i] = [];
    rows[i][0] = String(i + 1);
  }
}

function countEmptyNicknames(
  rows: readonly string[][],
  nicknameColIdx: number
): number {
  let count = 0;
  for (const r of rows) {
    if ((r[nicknameColIdx] ?? "").trim().length === 0) count++;
  }
  return count;
}

/**
 * 자동 멤버 동기화 — leaving 데이터 shift up + joining 빈 슬롯 입력 + Col A normalize.
 * row 자체 삭제 안 함 (가입순서 보존).
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
  const nicknameColIdx = getNicknameColIdx(layout);

  // 1) 시트 read (header + data)
  const allRows = await readMemberRows(spreadsheetId, accessToken, fetchImpl);
  if (allRows.length === 0) {
    throw new Error("AUTO_SYNC_EMPTY_SHEET: 유니온 멤버 시트가 비어있음");
  }
  const header = allRows[0];
  // data rows — header 제외, 최대 32 row 만 (header=row1, data=row2..33)
  const dataRows: string[][] = [];
  for (let i = 1; i < allRows.length && i <= MAX_MEMBERS; i++) {
    dataRows.push([...(allRows[i] ?? [])]);
  }
  // 부족하면 빈 row 로 padding (정원 32까지)
  while (dataRows.length < MAX_MEMBERS) {
    dataRows.push([]);
  }

  const emptySlotsBefore = countEmptyNicknames(dataRows, nicknameColIdx);

  // 2) leaving — data shift up (큰 sheetRow 부터)
  const leavingSheetRows = unmatchedSheetNicknames.map((u) => u.sheetRow);
  if (leavingSheetRows.length > 0) {
    shiftRowsUp(dataRows, leavingSheetRows, nicknameColIdx);
  }

  // 3) joining — 빈 닉네임 슬롯에 채움 (위에서부터)
  const filledSheetRows = fillJoiningSlots(
    dataRows,
    joiningMembers,
    layout,
    nicknameColIdx
  );

  // 4) Col A normalize
  normalizeColA(dataRows);

  const emptySlotsAfter = countEmptyNicknames(dataRows, nicknameColIdx);

  // 5) 시트 일괄 write (header + data)
  const writeValues: string[][] = [header, ...dataRows];
  await writeMemberRows(spreadsheetId, writeValues, accessToken, fetchImpl);

  const addedRows = joiningMembers.map((m, i) => ({
    sheetRow: filledSheetRows[i] ?? 0,
    nickname: m.nickname,
    member_id: m.member_id,
  }));

  return {
    removedRows: leavingSheetRows,
    addedRows,
    emptySlotsBefore,
    emptySlotsAfter,
  };
}
