// F-NRA-002-07 보강 — `레이드 결과` 탭에 새 회차 행 1개 추가 (회차 컬럼만 채움).
// 순위·머장 한줄평 등 다른 컬럼은 사용자가 직접 입력 (빈 상태로 둠).

import { columnNumberToLetter } from "./find-column";
import { ensureSheetGrid } from "./grid";

const RAID_RESULT_SHEET = "레이드 결과";
const RAID_NUM_COL_NAME = "회차";

interface ValueRangeResponse {
  range: string;
  values?: string[][];
}

export interface AppendRaidResultResult {
  sheetRow: number;
  raidNumCol: string;
  /** true 이면 이미 동일 회차 행이 있어 입력 안 함 (idempotent). */
  alreadyExisted: boolean;
}

/**
 * `레이드 결과` 탭에 신규 회차 row 1개 추가.
 *   - 헤더에서 "회차" 컬럼 찾기 (보통 Col A)
 *   - 마지막 데이터 행 +1 위치에 `{N}차` 입력
 *   - 다른 컬럼은 비워둠 (사용자 입력)
 *   - 동일 회차 행이 이미 있으면 idempotent 처리
 */
export async function appendRaidResultRow(
  spreadsheetId: string,
  raidNum: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<AppendRaidResultResult> {
  // 1) 헤더 + 데이터 fetch
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`${RAID_RESULT_SHEET}!A1:Z500`)}`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`RAID_RESULT_READ_FAILED: HTTP ${res.status}`);
  }
  const body = (await res.json()) as ValueRangeResponse;
  const rows = body.values ?? [];
  if (rows.length === 0) {
    throw new Error("RAID_RESULT_EMPTY: 레이드 결과 시트가 비어있음");
  }

  // 2) "회차" 컬럼 인덱스 찾기
  const header = rows[0];
  const raidNumColIdx = header.findIndex(
    (h) => h?.trim() === RAID_NUM_COL_NAME
  );
  if (raidNumColIdx === -1) {
    throw new Error(
      `RAID_RESULT_HEADER_MISSING: "${RAID_NUM_COL_NAME}" 컬럼이 헤더에 없음`
    );
  }
  const raidNumCol = columnNumberToLetter(raidNumColIdx + 1);
  const target = `${raidNum}차`;

  // 3) 동일 회차 row 존재 검사 — idempotent
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i]?.[raidNumColIdx] ?? "").trim() === target) {
      return {
        sheetRow: i + 1,
        raidNumCol,
        alreadyExisted: true,
      };
    }
  }

  // 4) 마지막 데이터 row 찾기 (회차 컬럼 기준 — 빈 행은 skip)
  let lastDataRow = 1; // header = row 1
  for (let i = rows.length - 1; i >= 1; i--) {
    const v = (rows[i]?.[raidNumColIdx] ?? "").trim();
    if (v.length > 0) {
      lastDataRow = i + 1;
      break;
    }
  }

  // 5) grid 확장 (rowCount + columnCount)
  const newRow = lastDataRow + 1;
  const requiredCols = Math.max(header.length, raidNumColIdx + 1);
  await ensureSheetGrid(
    spreadsheetId,
    RAID_RESULT_SHEET,
    newRow,
    requiredCols,
    accessToken,
    fetchImpl
  );

  // 6) 회차 컬럼만 PUT (다른 컬럼은 비워둠)
  const range = `${RAID_RESULT_SHEET}!${raidNumCol}${newRow}`;
  const putUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  const putRes = await fetchImpl(putUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values: [[target]] }),
  });
  if (!putRes.ok) {
    const errText = await putRes.text().catch(() => "");
    throw new Error(
      `RAID_RESULT_WRITE_FAILED: HTTP ${putRes.status} ${errText.slice(0, 120)}`
    );
  }

  return { sheetRow: newRow, raidNumCol, alreadyExisted: false };
}
