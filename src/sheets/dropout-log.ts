// 탈퇴자 레벨 기록 — 탈퇴 멤버(현재 유니온에 없는 멤버)의 회차별 레벨 보존.
// 탭 구조: A열 닉네임 | B열~ 회차 컬럼(29차, 30차, …). 닉네임 기준.
// '탈퇴자 레벨 기록' 탭이 없는 시트는 모든 함수가 no-op(null 반환) — 하위호환.

const DROPOUT_SHEET = "탈퇴자 레벨 기록";
const ROUND_RE = /^(\d+)차$/;

// 0-based 컬럼 인덱스 → A1 표기 letter (A, B, …, Z, AA).
function colLetter(idx0: number): string {
  let n = idx0 + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export interface DropoutTab {
  gridId: number; // sheetId
  roundCols: Map<string, number>; // 회차("40") → 0-based 컬럼 인덱스
  byNick: Map<string, { rowIndex: number; cells: string[] }>; // 닉네임 → {1-based sheetRow, 행 셀}
  lastRow: number; // 마지막 데이터 행(1-based). 헤더만 있으면 1.
  colCount: number; // 헤더 컬럼 수
}

interface SheetMeta {
  sheetId: number;
  title: string;
}

async function listSheets(
  spreadsheetId: string,
  token: string,
  fetchImpl: typeof fetch
): Promise<SheetMeta[]> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets(properties(sheetId,title))`;
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`DROPOUT_LIST_FAILED: HTTP ${res.status}`);
  const body = (await res.json()) as {
    sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>;
  };
  const out: SheetMeta[] = [];
  for (const s of body.sheets ?? []) {
    const id = s.properties?.sheetId;
    const t = s.properties?.title;
    if (id !== undefined && t !== undefined) out.push({ sheetId: id, title: t });
  }
  return out;
}

/**
 * '탈퇴자 레벨 기록' 탭을 읽어 구조를 반환. 탭이 없으면 null (하위호환 — 기록 skip).
 */
export async function readDropoutTab(
  spreadsheetId: string,
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<DropoutTab | null> {
  const sheets = await listSheets(spreadsheetId, token, fetchImpl);
  const meta = sheets.find((s) => s.title === DROPOUT_SHEET);
  if (meta === undefined) return null;

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`${DROPOUT_SHEET}!A1:ZZ1000`)}`;
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`DROPOUT_READ_FAILED: HTTP ${res.status}`);
  const body = (await res.json()) as { values?: string[][] };
  const values = body.values ?? [];
  const header = values[0] ?? [];

  const roundCols = new Map<string, number>();
  header.forEach((h, i) => {
    const m = String(h ?? "").trim().match(ROUND_RE);
    if (m) roundCols.set(m[1], i);
  });

  const byNick = new Map<string, { rowIndex: number; cells: string[] }>();
  for (let i = 1; i < values.length; i++) {
    const row = values[i] ?? [];
    const nick = String(row[0] ?? "").trim();
    if (nick.length === 0) continue;
    byNick.set(nick, { rowIndex: i + 1, cells: row });
  }

  return {
    gridId: meta.sheetId,
    roundCols,
    byNick,
    lastRow: values.length, // 1-based 마지막 행 (헤더 포함 행 수)
    colCount: header.length,
  };
}

async function insertOrderedRoundColumn(
  spreadsheetId: string,
  tab: DropoutTab,
  round: string,
  token: string,
  fetchImpl: typeof fetch
): Promise<void> {
  // 삽입 위치: 기존 회차 컬럼 중 round 보다 큰 첫 컬럼. 없으면 맨 끝(colCount).
  let insertAt = tab.colCount;
  let smallestLargerCol = Infinity;
  for (const [r, c] of tab.roundCols.entries()) {
    if (Number(r) > Number(round) && c < smallestLargerCol) {
      smallestLargerCol = c;
      insertAt = c;
    }
  }
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`;
  const ins = await fetchImpl(`${base}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [
        {
          insertDimension: {
            range: { sheetId: tab.gridId, dimension: "COLUMNS", startIndex: insertAt, endIndex: insertAt + 1 },
            inheritFromBefore: insertAt > 0,
          },
        },
      ],
    }),
  });
  if (!ins.ok) throw new Error(`DROPOUT_COL_INSERT_FAILED: HTTP ${ins.status}`);

  const headerCell = `${DROPOUT_SHEET}!${colLetter(insertAt)}1`;
  const put = await fetchImpl(
    `${base}/values/${encodeURIComponent(headerCell)}?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [[`${round}차`]] }),
    }
  );
  if (!put.ok) throw new Error(`DROPOUT_COL_HEADER_FAILED: HTTP ${put.status}`);
}

/**
 * 탈퇴자 레벨을 '탈퇴자 레벨 기록' 탭에 기록.
 * @param entries 닉네임 → (회차 → 레벨)
 * @param mode "fillEmpty": 기존 셀이 비었을 때만 채움(경로 1). "overwrite": 덮어씀(경로 2).
 * @returns 기록한 닉네임 목록. 탭이 없으면 null (skip).
 */
export async function recordDropouts(
  spreadsheetId: string,
  token: string,
  entries: Map<string, Map<string, number>>,
  mode: "fillEmpty" | "overwrite",
  fetchImpl: typeof fetch = fetch
): Promise<{ recorded: string[] } | null> {
  let tab = await readDropoutTab(spreadsheetId, token, fetchImpl);
  if (tab === null) return null; // 탭 없음 → 기록 안 함 (하위호환)
  if (entries.size === 0) return { recorded: [] };

  // 1) 필요한 회차 컬럼이 없으면 차수 순서 위치에 추가 (Q1=A)
  const neededRounds = new Set<string>();
  for (const roundMap of entries.values()) {
    for (const r of roundMap.keys()) neededRounds.add(r);
  }
  const missing = [...neededRounds]
    .filter((r) => !tab!.roundCols.has(r))
    .sort((a, b) => Number(a) - Number(b));
  if (missing.length > 0) {
    for (const round of missing) {
      await insertOrderedRoundColumn(spreadsheetId, tab, round, token, fetchImpl);
      // 삽입으로 컬럼 인덱스가 바뀌므로 다시 읽어 정확한 매핑 확보
      tab = (await readDropoutTab(spreadsheetId, token, fetchImpl))!;
    }
  }

  // 2) 셀 업데이트 + 신규 행 구성
  const valueUpdates: Array<{ range: string; values: string[][] }> = [];
  let appendRow = tab.lastRow + 1; // 신규 행은 마지막 다음부터
  const recorded: string[] = [];

  for (const [nick, roundMap] of entries.entries()) {
    const existing = tab.byNick.get(nick);
    if (existing !== undefined) {
      // 기존 행 — 회차별 셀 업데이트
      for (const [round, lv] of roundMap.entries()) {
        const col = tab.roundCols.get(round);
        if (col === undefined || lv <= 0) continue;
        const cur = String(existing.cells[col] ?? "").trim();
        if (mode === "fillEmpty" && cur.length > 0) continue; // 이미 값 있으면 보존
        valueUpdates.push({
          range: `${DROPOUT_SHEET}!${colLetter(col)}${existing.rowIndex}`,
          values: [[String(lv)]],
        });
      }
      recorded.push(nick);
    } else {
      // 신규 행 — 닉네임 + 회차 레벨로 한 행 구성
      const rowCells: string[] = new Array<string>(tab.colCount).fill("");
      rowCells[0] = nick;
      let any = false;
      for (const [round, lv] of roundMap.entries()) {
        const col = tab.roundCols.get(round);
        if (col === undefined || lv <= 0) continue;
        rowCells[col] = String(lv);
        any = true;
      }
      if (!any && nick.length === 0) continue;
      valueUpdates.push({
        range: `${DROPOUT_SHEET}!A${appendRow}:${colLetter(tab.colCount - 1)}${appendRow}`,
        values: [rowCells],
      });
      tab.byNick.set(nick, { rowIndex: appendRow, cells: rowCells });
      appendRow++;
      recorded.push(nick);
    }
  }

  if (valueUpdates.length > 0) {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ valueInputOption: "RAW", data: valueUpdates }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`DROPOUT_WRITE_FAILED: HTTP ${res.status} ${txt.slice(0, 150)}`);
    }
  }

  return { recorded };
}
