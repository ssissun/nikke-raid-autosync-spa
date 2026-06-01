// 차수 순서 위치 삽입 — 레이드 통계 행 블록 / 레이드 결과 단일 행.
// 기존 append(맨 끝) 대신 회차 번호에 맞는 위치에 insertDimension(ROWS) 으로 삽입.
// inheritFromBefore:true 로 위 행의 서식을 자동 상속 (별도 copyPaste 불필요).
// (유니온 멤버 회차 컬럼 삽입은 find-column.ts ensureRaidColumn 에서 처리.)

import { columnNumberToLetter } from "./find-column";

const RAID_STATS_SHEET = "레이드 통계";
const RAID_RESULT_SHEET = "레이드 결과";

// "40차" → 40, "OO차"/비라벨 → null
export function parseRoundNum(label: string | undefined): number | null {
  const m = String(label ?? "").trim().match(/^(\d+)차$/);
  return m ? Number(m[1]) : null;
}

async function getSheetIdByTitle(
  spreadsheetId: string,
  title: string,
  accessToken: string,
  fetchImpl: typeof fetch
): Promise<number> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets(properties(sheetId,title))`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`SHEET_ID_LOOKUP_FAILED: HTTP ${res.status}`);
  const body = (await res.json()) as {
    sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>;
  };
  const found = (body.sheets ?? []).find((s) => s.properties?.title === title);
  if (found?.properties?.sheetId === undefined) {
    throw new Error(`SHEET_ID_LOOKUP_FAILED: '${title}' 탭 부재`);
  }
  return found.properties.sheetId;
}

async function readColumn(
  spreadsheetId: string,
  rangeA1: string,
  accessToken: string,
  fetchImpl: typeof fetch
): Promise<string[][]> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(rangeA1)}`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`ORDERED_READ_FAILED: HTTP ${res.status} ${rangeA1}`);
  const body = (await res.json()) as { values?: string[][] };
  return body.values ?? [];
}

async function insertRows(
  spreadsheetId: string,
  sheetId: number,
  startIndex: number, // 0-based grid row
  count: number,
  accessToken: string,
  fetchImpl: typeof fetch
): Promise<void> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requests: [
        {
          insertDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex,
              endIndex: startIndex + count,
            },
            inheritFromBefore: startIndex > 0,
          },
        },
      ],
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`ROW_INSERT_FAILED: HTTP ${res.status} ${t.slice(0, 120)}`);
  }
}

async function writeValues(
  spreadsheetId: string,
  rangeA1: string,
  values: string[][],
  accessToken: string,
  fetchImpl: typeof fetch
): Promise<void> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(rangeA1)}?valueInputOption=USER_ENTERED`;
  const res = await fetchImpl(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`ORDERED_WRITE_FAILED: HTTP ${res.status} ${t.slice(0, 120)}`);
  }
}

// labels 중 round > target 인 첫 데이터 행의 0-based grid index. 없으면 마지막 데이터 행 +1.
// labelColIdx: 회차 라벨이 있는 컬럼 인덱스(0-based). headerRows: 헤더 행 수(보통 1).
// 회차 라벨 행이 하나도 없어도(빈 시트의 "OO차 …" placeholder 등) 마지막으로 채워진 행 뒤에 삽입.
function findInsertRowIndex(
  rows: string[][],
  labelColIdx: number,
  headerRows: number,
  target: number
): number {
  let lastFilledIdx = headerRows - 1;
  for (let i = headerRows; i < rows.length; i++) {
    const cell = String(rows[i]?.[labelColIdx] ?? "").trim();
    if (cell.length === 0) continue; // 완전 빈 행 → 위치 추적 안 함
    lastFilledIdx = i; // 비어있지 않은 행(회차 라벨 + placeholder 모두 포함)
    const r = parseRoundNum(cell);
    if (r !== null && r > target) return i; // 더 큰 회차 라벨 앞에 삽입
  }
  return lastFilledIdx + 1; // 마지막으로 채워진 행 뒤 (placeholder 보존, 그 아래 삽입)
}

/**
 * 레이드 통계 — raidNum 회차 행 블록을 차수 순서 위치에 삽입.
 * ColA 회차 라벨 기준으로 삽입 위치 계산 → insertDimension(ROWS) → 값 쓰기.
 */
export async function insertStatsRowsOrdered(
  spreadsheetId: string,
  raidNum: string,
  rows: string[][],
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  if (rows.length === 0) return;
  const sheetId = await getSheetIdByTitle(spreadsheetId, RAID_STATS_SHEET, accessToken, fetchImpl);
  const colA = await readColumn(spreadsheetId, `${RAID_STATS_SHEET}!A1:A5000`, accessToken, fetchImpl);
  const target = Number(raidNum);
  const insertAt = findInsertRowIndex(colA, 0, 1, target); // header 1행, ColA(0)
  await insertRows(spreadsheetId, sheetId, insertAt, rows.length, accessToken, fetchImpl);
  const startRow1 = insertAt + 1; // 0-based → 1-based
  const endRow1 = insertAt + rows.length;
  await writeValues(
    spreadsheetId,
    `${RAID_STATS_SHEET}!A${startRow1}:P${endRow1}`,
    rows,
    accessToken,
    fetchImpl
  );
}

export interface InsertResultRowResult {
  inserted: boolean; // false = 이미 존재(idempotent)
}

/**
 * 레이드 결과 — raidNum 단일 행을 차수 순서 위치에 삽입 (회차 컬럼만 채움).
 * 이미 동일 회차 행 있으면 idempotent no-op.
 */
export async function insertResultRowOrdered(
  spreadsheetId: string,
  raidNum: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<InsertResultRowResult> {
  const sheetId = await getSheetIdByTitle(spreadsheetId, RAID_RESULT_SHEET, accessToken, fetchImpl);
  const rows = await readColumn(spreadsheetId, `${RAID_RESULT_SHEET}!A1:Z500`, accessToken, fetchImpl);
  if (rows.length === 0) throw new Error("RAID_RESULT_EMPTY: 레이드 결과 시트가 비어있음");
  const header = rows[0];
  const colIdx = header.findIndex((h) => (h ?? "").trim() === "회차");
  if (colIdx === -1) {
    throw new Error('RAID_RESULT_HEADER_MISSING: "회차" 컬럼이 헤더에 없음');
  }
  const target = `${raidNum}차`;
  // idempotent
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i]?.[colIdx] ?? "").trim() === target) return { inserted: false };
  }
  const insertAt = findInsertRowIndex(rows, colIdx, 1, Number(raidNum));
  await insertRows(spreadsheetId, sheetId, insertAt, 1, accessToken, fetchImpl);
  const colLetter = columnNumberToLetter(colIdx + 1);
  await writeValues(
    spreadsheetId,
    `${RAID_RESULT_SHEET}!${colLetter}${insertAt + 1}`,
    [[target]],
    accessToken,
    fetchImpl
  );
  return { inserted: true };
}
