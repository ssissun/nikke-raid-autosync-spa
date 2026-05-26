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
