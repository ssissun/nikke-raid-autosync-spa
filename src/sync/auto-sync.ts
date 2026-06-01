// F-NRA-002-08 자동 멤버 sync — data shift 방식 (원본 레이아웃: Col B = 닉네임).
// member_id 는 유니온 멤버에 저장하지 않고 _nra_member_mapping 탭에 별도 보관하므로,
// 여기서는 닉네임/회차만 shift 하고 member_id 는 병렬 배열로 함께 추적하여 최종 매핑을 반환한다.
// (호출부가 finalMemberIdByRow 를 매핑 탭에 기록.)
//
// 동작:
//   1) 시트 전체 read (헤더 + 데이터 32 row)
//   2) leaving sheetRows 를 큰 순서부터 처리 — 데이터(Col B~)를 한 칸 위로 shift (member_id 병렬 shift)
//   3) joining 을 빈 닉네임 슬롯(위에서부터)에 채움 (member_id 병렬 기록)
//   4) Col A 가입순서 1..N normalize
//   5) 시트 write
//   6) 최종 {sheetRow → member_id} 반환

import type { GuildMember } from "../types";
import type { UnmatchedSheetNickname } from "../matching";
import { columnNumberToLetter } from "../sheets/find-column";

const UNION_MEMBER_SHEET = "유니온 멤버";
// 회차 컬럼은 Col C 부터 우측 누적 — Z(24회차) 초과분도 shift 대상에 포함되도록 넓게 읽는다.
const READ_RANGE = `${UNION_MEMBER_SHEET}!A1:AZ33`;
const MAX_MEMBERS = 32;
const NICKNAME_COL_IDX = 1; // Col B = 닉네임 (원본 레이아웃)

export interface AutoSyncOptions {
  fetchImpl?: typeof fetch;
  /** 현재 {sheetRow → member_id} (매핑 탭/분류 결과). shift 에 함께 실어 최종 매핑 산출. */
  initialMemberIdByRow?: ReadonlyMap<number, string>;
}

export interface AutoSyncResult {
  removedRows: number[]; // leaving 처리한 원래 sheetRow (1-indexed)
  addedRows: Array<{ sheetRow: number; nickname: string; member_id: string }>;
  emptySlotsBefore: number;
  emptySlotsAfter: number;
  /** shift/append 반영된 최종 {sheetRow → member_id} — 매핑 탭 기록용 */
  finalMemberIdByRow: Map<number, string>;
}

interface ValueRangeResponse {
  range: string;
  values?: string[][];
}

async function readMemberRows(
  spreadsheetId: string,
  accessToken: string,
  fetchImpl: typeof fetch
): Promise<string[][]> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(READ_RANGE)}`;
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
  const maxCols = Math.max(...values.map((r) => r.length), 1);
  const padded = values.map((r) => {
    if (r.length === maxCols) return [...r];
    return [...r, ...Array<string>(maxCols - r.length).fill("")];
  });
  const endRow = values.length;
  const endColLetter = columnNumberToLetter(maxCols); // 26열 초과(AA+)도 안전
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
 * data shift up — 큰 idx 부터 처리하여 어긋남 방지.
 * leaving row 의 데이터(Col B~)를 비우고 아래 row 데이터를 한 칸씩 위로 이동. member_id 병렬 shift.
 * Col A (가입순서) 는 normalizeColA 에서 별도 처리.
 */
function shiftRowsUp(
  rows: string[][],
  memberIds: string[],
  leavingSheetRows: readonly number[]
): void {
  const leavingIdx = leavingSheetRows
    .map((r) => r - 2) // 1-indexed sheetRow → 0-indexed data row (header=row1)
    .filter((i) => i >= 0 && i < rows.length)
    .sort((a, b) => b - a); // 큰 idx 부터

  for (const idx of leavingIdx) {
    for (let i = idx; i < rows.length - 1; i++) {
      const next = rows[i + 1] ?? [];
      const maxCols = Math.max(rows[i]?.length ?? 0, next.length);
      if (rows[i] === undefined) rows[i] = [];
      for (let c = 1; c < maxCols; c++) {
        rows[i][c] = next[c] ?? "";
      }
      memberIds[i] = memberIds[i + 1] ?? "";
    }
    const last = rows[rows.length - 1];
    if (last !== undefined) {
      for (let c = 1; c < last.length; c++) last[c] = "";
    }
    memberIds[rows.length - 1] = "";
  }
}

/**
 * 빈 닉네임 슬롯(위에서부터)에 joining members 채움 (Col B 닉네임 + member_id 병렬 기록).
 * @returns 채워진 sheetRow 목록 (1-indexed).
 */
function fillJoiningSlots(
  rows: string[][],
  memberIds: string[],
  joiningMembers: readonly GuildMember[]
): number[] {
  const filledSheetRows: number[] = [];
  let joiningIdx = 0;
  for (let i = 0; i < rows.length && joiningIdx < joiningMembers.length; i++) {
    const row = rows[i];
    if (row === undefined) continue;
    const currentNickname = (row[NICKNAME_COL_IDX] ?? "").trim();
    if (currentNickname.length > 0) continue; // 닉네임 채워진 row 스킵
    const m = joiningMembers[joiningIdx];
    row[NICKNAME_COL_IDX] = m.nickname;
    memberIds[i] = m.member_id;
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

/** Col A 가입순서를 1..N 으로 normalize. */
function normalizeColA(rows: string[][]): void {
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] === undefined) rows[i] = [];
    rows[i][0] = String(i + 1);
  }
}

function countEmptyNicknames(rows: readonly string[][]): number {
  let count = 0;
  for (const r of rows) {
    if ((r[NICKNAME_COL_IDX] ?? "").trim().length === 0) count++;
  }
  return count;
}

/**
 * 자동 멤버 동기화 — leaving 데이터 shift up + joining 빈 슬롯 입력 + Col A normalize.
 * row 자체 삭제 안 함 (가입순서 보존). member_id 는 병렬 추적하여 최종 매핑 반환.
 */
export async function applyMemberSync(
  spreadsheetId: string,
  accessToken: string,
  unmatchedSheetNicknames: readonly UnmatchedSheetNickname[],
  joiningMembers: readonly GuildMember[],
  options: AutoSyncOptions = {}
): Promise<AutoSyncResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const initialMemberIdByRow = options.initialMemberIdByRow ?? new Map<number, string>();

  // 1) 시트 read (header + data)
  const allRows = await readMemberRows(spreadsheetId, accessToken, fetchImpl);
  if (allRows.length === 0) {
    throw new Error("AUTO_SYNC_EMPTY_SHEET: 유니온 멤버 시트가 비어있음");
  }
  const header = allRows[0];
  const dataRows: string[][] = [];
  for (let i = 1; i < allRows.length && i <= MAX_MEMBERS; i++) {
    dataRows.push([...(allRows[i] ?? [])]);
  }
  while (dataRows.length < MAX_MEMBERS) {
    dataRows.push([]);
  }

  // member_id 병렬 배열 — dataRows[i] ↔ sheetRow (i+2)
  const memberIds: string[] = dataRows.map(
    (_, i) => initialMemberIdByRow.get(i + 2) ?? ""
  );

  const emptySlotsBefore = countEmptyNicknames(dataRows);

  // 2) leaving — data shift up (큰 sheetRow 부터)
  const leavingSheetRows = unmatchedSheetNicknames.map((u) => u.sheetRow);
  if (leavingSheetRows.length > 0) {
    shiftRowsUp(dataRows, memberIds, leavingSheetRows);
  }

  // 3) joining — 빈 닉네임 슬롯에 채움
  const filledSheetRows = fillJoiningSlots(dataRows, memberIds, joiningMembers);

  // 4) Col A normalize
  normalizeColA(dataRows);

  const emptySlotsAfter = countEmptyNicknames(dataRows);

  // 5) 시트 일괄 write (header + data)
  const writeValues: string[][] = [header, ...dataRows];
  await writeMemberRows(spreadsheetId, writeValues, accessToken, fetchImpl);

  // 6) 최종 {sheetRow → member_id}
  const finalMemberIdByRow = new Map<number, string>();
  for (let i = 0; i < memberIds.length; i++) {
    const id = (memberIds[i] ?? "").trim();
    if (id.length > 0) finalMemberIdByRow.set(i + 2, id);
  }

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
    finalMemberIdByRow,
  };
}
