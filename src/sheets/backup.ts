// F-NRA-002-07 백업 탭 생성 + 데이터 복사 (SHEET_SCHEMA §5).
// 1. `_backup_{생성시각}` 탭 생성 (회차 무관, 매 실행마다 유일 → 충돌 없음)
// 2. `유니온 멤버` + `레이드 통계` 변경 대상 영역 데이터 fetch
// 3. backup 탭에 라벨 + 두 영역 데이터 쓰기
// 4. 백업탭은 최근 3개만 유지 (생성 시각 기준 가장 오래된 것부터 삭제)

const MAX_BACKUP_TABS = 3;

// 백업탭 이름의 recency(최신도) 정렬 키. 신규 `_backup_YYYYMMDD-HHmmss` 는 항상
// 구버전 `_backup_{회차}` 보다 최신으로 취급되어, 구버전 탭이 먼저 정리된다.
// 백업탭이 아니면 null.
function backupRecencyKey(title: string): string | null {
  const ts = title.match(/^_backup_(\d{8}-\d{6})(?:_(\d+))?$/);
  if (ts) return `1_${ts[1]}_${(ts[2] ?? "0").padStart(4, "0")}`;
  const legacy = title.match(/^_backup_(\d+)(?:_(\d+))?$/);
  if (legacy) {
    return `0_${legacy[1].padStart(8, "0")}_${(legacy[2] ?? "0").padStart(4, "0")}`;
  }
  return null;
}

// 회차 무관 백업탭 이름/라벨 — 생성 시각 기반.
function backupTimestamp(): { name: string; label: string } {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  const time = `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return {
    name: `_backup_${date}-${time}`,
    label: `백업 - ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,
  };
}

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

  // 이름 충돌은 createBackupTab 이 사전 조회로 회피하므로 여기 도달 시는 실질 실패.
  const errBody = (await res.json().catch(() => ({}))) as SheetsErrorBody;
  const msg = errBody.error?.message ?? "";
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
  label: string,
  memberRows: readonly string[][],
  statsRows: readonly string[][]
): string[][] {
  // 단일 탭에 두 영역을 16-col 너비로 padding 하여 일관 표시
  const TARGET_COLS = 16;
  const lines: string[][] = [];

  lines.push([label, ...Array<string>(TARGET_COLS - 1).fill("")]);
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
 * 백업탭을 최근 N개만 남기고 오래된 것 삭제 (생성 시각 기준).
 * `_backup_*` 패턴만 대상 (신규 시각 기반 + 구버전 회차 기반 모두). 그 외 탭은 건드리지 않음.
 */
export async function pruneOldBackupTabs(
  spreadsheetId: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
  keepMax: number = MAX_BACKUP_TABS
): Promise<{ kept: string[]; removed: string[] }> {
  const sheets = await listAllSheets(spreadsheetId, accessToken, fetchImpl);
  const backupSheets: Array<SheetInfo & { key: string }> = [];
  for (const s of sheets) {
    const key = backupRecencyKey(s.title);
    if (key === null) continue;
    backupSheets.push({ ...s, key });
  }
  // 최신(key 큰 것)부터 정렬 → 상위 keepMax 개 유지, 나머지 삭제
  backupSheets.sort((a, b) => b.key.localeCompare(a.key));
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
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const { name: base, label } = backupTimestamp();

  // 생성 시각 기반 이름이라 매 실행마다 유일 → 충돌이 사실상 없음.
  // 같은 초 재실행 등 드문 충돌 대비: 기존 탭 목록을 먼저 조회해 비충돌 이름 선택.
  const takenTitles = new Set(
    (await listAllSheets(spreadsheetId, accessToken, fetchImpl)).map((s) => s.title)
  );
  const pickFreeName = (): string => {
    let name = base;
    for (let n = 2; takenTitles.has(name); n++) name = `${base}_${n}`;
    return name;
  };

  // API eventual-consistency/동시 실행으로 400(중복)이 나면 이름을 늘려 최대 3회 재시도.
  // 403/500 등 비-400 은 즉시 throw (백업 실패 시 적용 중단 — 쓰기 전 안전장치).
  let tabName = pickFreeName();
  for (let attempt = 1; ; attempt++) {
    try {
      await attemptAddSheet(spreadsheetId, tabName, accessToken, fetchImpl);
      break;
    } catch (e) {
      const isDuplicate =
        e instanceof Error && /^BACKUP_TAB_FAILED: HTTP 400/.test(e.message);
      if (!isDuplicate || attempt >= 3) throw e;
      takenTitles.add(tabName);
      tabName = pickFreeName();
    }
  }

  const { memberRows, statsRows } = await fetchTwoRanges(
    spreadsheetId,
    accessToken,
    fetchImpl
  );
  const lines = buildBackupValues(label, memberRows, statsRows);
  await writeBackupRows(spreadsheetId, tabName, lines, accessToken, fetchImpl);

  // 새 백업 추가 후 최근 3개만 유지 — 신규가 가장 최신이라 항상 보존, 가장 오래된 것 삭제.
  await pruneOldBackupTabs(spreadsheetId, accessToken, fetchImpl);

  return tabName;
}

export { buildBackupValues };
