// F-NRA-002-07 백업 탭 생성 + 데이터 복사 (SHEET_SCHEMA §5).
// 1. `_backup_{회차}` 탭 생성 (중복 시 `_2` fallback)
// 2. `유니온 멤버` + `레이드 통계` 변경 대상 영역 데이터 fetch
// 3. backup 탭에 라벨 + 두 영역 데이터 쓰기
// 4. 백업탭은 최대 3개만 유지 (가장 오래된 회차부터 삭제)

const MAX_BACKUP_TABS = 3;
const BACKUP_TAB_PATTERN = /^_backup_(\d+)(_\d+)?$/;

interface SheetsErrorBody {
  error?: { code?: number; status?: string; message?: string };
}

interface BatchGetResponse {
  spreadsheetId: string;
  valueRanges: Array<{ range: string; values?: string[][] }>;
}

const UNION_MEMBER_RANGE = "유니온 멤버!A1:Z40";
const RAID_STATS_RANGE = "레이드 통계!A1:P2000";

async function attemptAddSheet(
  spreadsheetId: string,
  title: string,
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
      requests: [{ addSheet: { properties: { title } } }],
    }),
  });
  if (res.ok) return;

  const errBody = (await res.json().catch(() => ({}))) as SheetsErrorBody;
  const msg = errBody.error?.message ?? "";
  if (
    res.status === 400 &&
    (msg.includes("already exists") || msg.toLowerCase().includes("duplicate"))
  ) {
    throw new Error("ALREADY_EXISTS");
  }
  throw new Error(`BACKUP_TAB_FAILED: HTTP ${res.status} ${msg}`);
}

async function fetchTwoRanges(
  spreadsheetId: string,
  accessToken: string,
  fetchImpl: typeof fetch
): Promise<{ memberRows: string[][]; statsRows: string[][] }> {
  const params = [UNION_MEMBER_RANGE, RAID_STATS_RANGE]
    .map((r) => `ranges=${encodeURIComponent(r)}`)
    .join("&");
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchGet?${params}`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`BACKUP_FETCH_FAILED: HTTP ${res.status}`);
  }
  const body = (await res.json()) as BatchGetResponse;
  const memberRows = body.valueRanges?.[0]?.values ?? [];
  const statsRows = body.valueRanges?.[1]?.values ?? [];
  return { memberRows, statsRows };
}

function padRows(rows: readonly string[][], targetCols: number): string[][] {
  return rows.map((r) => {
    if (r.length === targetCols) return [...r];
    if (r.length > targetCols) return r.slice(0, targetCols);
    return [...r, ...Array<string>(targetCols - r.length).fill("")];
  });
}

function buildBackupValues(
  raidNum: string,
  memberRows: readonly string[][],
  statsRows: readonly string[][]
): string[][] {
  const timestamp = new Date()
    .toISOString()
    .replace("T", " ")
    .slice(0, 16); // YYYY-MM-DD HH:MM
  // 단일 탭에 두 영역을 16-col 너비로 padding 하여 일관 표시
  const TARGET_COLS = 16;
  const lines: string[][] = [];

  lines.push([
    `${raidNum}차 backup - ${timestamp}`,
    ...Array<string>(TARGET_COLS - 1).fill(""),
  ]);
  lines.push(Array<string>(TARGET_COLS).fill(""));

  lines.push([
    "=== 유니온 멤버 ===",
    ...Array<string>(TARGET_COLS - 1).fill(""),
  ]);
  lines.push(...padRows(memberRows, TARGET_COLS));
  lines.push(Array<string>(TARGET_COLS).fill(""));

  lines.push([
    "=== 레이드 통계 ===",
    ...Array<string>(TARGET_COLS - 1).fill(""),
  ]);
  lines.push(...padRows(statsRows, TARGET_COLS));

  return lines;
}

async function writeBackupRows(
  spreadsheetId: string,
  tabName: string,
  rows: readonly string[][],
  accessToken: string,
  fetchImpl: typeof fetch
): Promise<void> {
  if (rows.length === 0) return;
  const range = `${tabName}!A1:P${rows.length}`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
  const res = await fetchImpl(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values: rows }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`BACKUP_WRITE_FAILED: HTTP ${res.status} ${errText.slice(0, 200)}`);
  }
}

interface SheetInfo {
  sheetId: number;
  title: string;
}

async function listAllSheets(
  spreadsheetId: string,
  accessToken: string,
  fetchImpl: typeof fetch
): Promise<SheetInfo[]> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets(properties(sheetId,title))`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`BACKUP_LIST_FAILED: HTTP ${res.status}`);
  }
  const body = (await res.json()) as {
    sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>;
  };
  const list: SheetInfo[] = [];
  for (const s of body.sheets ?? []) {
    const id = s.properties?.sheetId;
    const t = s.properties?.title;
    if (id !== undefined && t !== undefined && t.length > 0) {
      list.push({ sheetId: id, title: t });
    }
  }
  return list;
}

async function deleteSheets(
  spreadsheetId: string,
  sheetIds: readonly number[],
  accessToken: string,
  fetchImpl: typeof fetch
): Promise<void> {
  if (sheetIds.length === 0) return;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`;
  const requests = sheetIds.map((sid) => ({ deleteSheet: { sheetId: sid } }));
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
    throw new Error(`BACKUP_DELETE_FAILED: HTTP ${res.status} ${errText.slice(0, 120)}`);
  }
}

/**
 * 백업탭을 최신 N개만 남기고 오래된 것 삭제 (회차 번호 큰 순으로 유지).
 * `_backup_{N}` 또는 `_backup_{N}_{suffix}` 패턴만 대상. 그 외 탭은 건드리지 않음.
 */
export async function pruneOldBackupTabs(
  spreadsheetId: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
  keepMax: number = MAX_BACKUP_TABS
): Promise<{ kept: string[]; removed: string[] }> {
  const sheets = await listAllSheets(spreadsheetId, accessToken, fetchImpl);
  const backupSheets: Array<SheetInfo & { raidNum: number }> = [];
  for (const s of sheets) {
    const m = s.title.match(BACKUP_TAB_PATTERN);
    if (m === null) continue;
    backupSheets.push({ ...s, raidNum: Number.parseInt(m[1], 10) });
  }
  // 큰 회차부터 정렬 → 상위 keepMax 개 유지, 나머지 삭제
  backupSheets.sort((a, b) => b.raidNum - a.raidNum);
  const kept = backupSheets.slice(0, keepMax);
  const toRemove = backupSheets.slice(keepMax);
  if (toRemove.length > 0) {
    await deleteSheets(
      spreadsheetId,
      toRemove.map((s) => s.sheetId),
      accessToken,
      fetchImpl
    );
  }
  return {
    kept: kept.map((s) => s.title),
    removed: toRemove.map((s) => s.title),
  };
}

export async function createBackupTab(
  spreadsheetId: string,
  raidNum: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const primary = `_backup_${raidNum}`;
  let tabName: string;
  try {
    await attemptAddSheet(spreadsheetId, primary, accessToken, fetchImpl);
    tabName = primary;
  } catch (e) {
    if (e instanceof Error && e.message === "ALREADY_EXISTS") {
      const fallback = `${primary}_2`;
      await attemptAddSheet(spreadsheetId, fallback, accessToken, fetchImpl);
      tabName = fallback;
    } else {
      throw e;
    }
  }

  const { memberRows, statsRows } = await fetchTwoRanges(
    spreadsheetId,
    accessToken,
    fetchImpl
  );
  const lines = buildBackupValues(raidNum, memberRows, statsRows);
  await writeBackupRows(spreadsheetId, tabName, lines, accessToken, fetchImpl);

  // 오래된 backup 탭 정리 (최신 3개만 유지) — 신규 추가 후 정리해서 신규는 항상 포함됨
  await pruneOldBackupTabs(spreadsheetId, accessToken, fetchImpl);

  return tabName;
}

export { buildBackupValues };
