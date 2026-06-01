// raidNum 추측 — 유저스크립트가 GetUnionRaidLevelInfo 미캡처 시 fallback.
// 1순위: `유니온 멤버` 헤더 row1 에서 max "N차" → N+1
// 2순위: `레이드 통계` Col A 에서 max "N차" → N+1
// 둘 다 부재면 "40"(기본) 또는 throw

interface ValuesGetResponse {
  range: string;
  values?: string[][];
}

const RAID_NUM_PATTERN = /^(\d+)차$/;

function extractMaxRaidNum(values: readonly string[]): number | null {
  let max = -1;
  for (const v of values) {
    const m = v?.trim().match(RAID_NUM_PATTERN);
    if (m === null || m === undefined) continue;
    const n = Number.parseInt(m[1], 10);
    if (Number.isNaN(n)) continue;
    if (n > max) max = n;
  }
  return max >= 0 ? max : null;
}

// "N차" 패턴 매칭되는 회차 숫자 문자열 집합 (max 대신 전체).
export function extractRaidNumSet(values: readonly string[]): Set<string> {
  const set = new Set<string>();
  for (const v of values) {
    const m = v?.trim().match(RAID_NUM_PATTERN);
    if (m) set.add(m[1]);
  }
  return set;
}

export interface ExistingRaidNumsByTab {
  memberRounds: Set<string>; // 유니온 멤버 회차 컬럼 헤더에 존재
  statsRounds: Set<string>; // 레이드 통계 ColA 회차 라벨에 존재
  resultRounds: Set<string>; // 레이드 결과 "회차" 컬럼 행 라벨에 존재
}

// 2D 표(rows)의 "회차" 헤더 컬럼에서 "N차" 집합 추출. 헤더 부재 시 빈 집합.
function extractRaidNumSetFromTable(rows: string[][]): Set<string> {
  if (rows.length === 0) return new Set();
  const header = rows[0] ?? [];
  const colIdx = header.findIndex((h) => (h ?? "").trim() === "회차");
  if (colIdx === -1) return new Set();
  const colValues = rows.slice(1).map((r) => r[colIdx] ?? "");
  return extractRaidNumSet(colValues);
}

/**
 * 시트 기존 회차를 탭별로 분리하여 반환 — 탭별 누락 판정용.
 *   memberRounds: 유니온 멤버 헤더 row1 의 "N차" 컬럼
 *   statsRounds:  레이드 통계 ColA 의 "N차" 행 라벨
 *   resultRounds: 레이드 결과 "회차" 컬럼의 "N차" 행 라벨
 */
export async function readExistingRaidNumsByTab(
  spreadsheetId: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<ExistingRaidNumsByTab> {
  const ranges = [
    encodeURIComponent("유니온 멤버!A1:Z1"),
    encodeURIComponent("레이드 통계!A1:A2000"),
    encodeURIComponent("레이드 결과!A1:Z500"),
  ];
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchGet?ranges=${ranges.join("&ranges=")}`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    return { memberRounds: new Set(), statsRounds: new Set(), resultRounds: new Set() };
  }
  const body = (await res.json()) as {
    valueRanges?: Array<{ values?: string[][] }>;
  };
  const vr = body.valueRanges ?? [];
  const memberHeader = vr[0]?.values?.[0] ?? [];
  const statsColA = (vr[1]?.values ?? []).map((r) => r[0] ?? "");
  const resultRows = vr[2]?.values ?? [];
  return {
    memberRounds: extractRaidNumSet(memberHeader),
    statsRounds: extractRaidNumSet(statsColA),
    resultRounds: extractRaidNumSetFromTable(resultRows),
  };
}

/**
 * 시트에 이미 존재하는 회차 집합 — 유니온 멤버 헤더 + 레이드 통계 ColA 합집합.
 * (레거시 / fallback 용. 탭별 판정은 readExistingRaidNumsByTab.)
 */
export async function readExistingRaidNums(
  spreadsheetId: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<Set<string>> {
  const { memberRounds, statsRounds } = await readExistingRaidNumsByTab(
    spreadsheetId,
    accessToken,
    fetchImpl
  );
  const set = new Set(memberRounds);
  for (const n of statsRounds) set.add(n);
  return set;
}

/**
 * `유니온 멤버` 헤더 row1 에서 max "N차" 추출.
 */
export async function guessFromMemberHeader(
  spreadsheetId: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<number | null> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent("유니온 멤버!A1:Z1")}`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as ValuesGetResponse;
  const row = body.values?.[0] ?? [];
  return extractMaxRaidNum(row);
}

/**
 * `레이드 통계` Col A 에서 max "N차" 추출.
 */
export async function guessFromRaidStats(
  spreadsheetId: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<number | null> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent("레이드 통계!A1:A2000")}`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as ValuesGetResponse;
  const colA = (body.values ?? []).map((r) => r[0] ?? "");
  return extractMaxRaidNum(colA);
}

/**
 * 두 곳에서 추출 → 더 큰 값 + 1 반환. 둘 다 부재면 null.
 */
export async function guessNextRaidNum(
  spreadsheetId: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  const [memberMax, statsMax] = await Promise.all([
    guessFromMemberHeader(spreadsheetId, accessToken, fetchImpl),
    guessFromRaidStats(spreadsheetId, accessToken, fetchImpl),
  ]);
  const candidates = [memberMax, statsMax].filter(
    (v): v is number => v !== null
  );
  if (candidates.length === 0) return null;
  const max = Math.max(...candidates);
  return String(max + 1);
}

export { extractMaxRaidNum };
