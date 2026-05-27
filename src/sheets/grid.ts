// grid 확장 헬퍼 — 탭의 rowCount / columnCount 가 부족하면 appendDimension 으로 확장.
// Sheets API 는 grid 밖 셀 쓰기 시 400 (exceeds grid limits) 반환하므로 사전 확장 필수.

interface SheetProperties {
  sheetId: number;
  title?: string;
  gridProperties?: { rowCount?: number; columnCount?: number };
}

interface SpreadsheetGetResponse {
  sheets?: Array<{ properties?: SheetProperties }>;
}

async function fetchSheetProps(
  spreadsheetId: string,
  sheetTitle: string,
  accessToken: string,
  fetchImpl: typeof fetch
): Promise<SheetProperties> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets(properties(sheetId,title,gridProperties))`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`GRID_INFO_FAILED: HTTP ${res.status}`);
  }
  const body = (await res.json()) as SpreadsheetGetResponse;
  const found = (body.sheets ?? []).find(
    (s) => s.properties?.title === sheetTitle
  );
  if (found === undefined || found.properties === undefined) {
    throw new Error(`GRID_INFO_FAILED: '${sheetTitle}' 탭 부재`);
  }
  return found.properties;
}

async function appendDimensionRequest(
  spreadsheetId: string,
  sheetId: number,
  dimension: "ROWS" | "COLUMNS",
  length: number,
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
      requests: [{ appendDimension: { sheetId, dimension, length } }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`GRID_EXPAND_FAILED: HTTP ${res.status} ${errText.slice(0, 120)}`);
  }
}

/**
 * 탭의 rowCount + columnCount 가 required 이상이 되도록 확장.
 * 이미 충분하면 fetch 1번 + no-op return.
 */
export async function ensureSheetGrid(
  spreadsheetId: string,
  sheetTitle: string,
  requiredRows: number,
  requiredCols: number,
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const props = await fetchSheetProps(
    spreadsheetId,
    sheetTitle,
    accessToken,
    fetchImpl
  );
  const currentRows = props.gridProperties?.rowCount ?? 0;
  const currentCols = props.gridProperties?.columnCount ?? 0;

  if (requiredRows > currentRows) {
    await appendDimensionRequest(
      spreadsheetId,
      props.sheetId,
      "ROWS",
      requiredRows - currentRows,
      accessToken,
      fetchImpl
    );
  }
  if (requiredCols > currentCols) {
    await appendDimensionRequest(
      spreadsheetId,
      props.sheetId,
      "COLUMNS",
      requiredCols - currentCols,
      accessToken,
      fetchImpl
    );
  }
}
