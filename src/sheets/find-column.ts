// F-NRA-002-07 회차 컬럼 자동 탐색.
// 마이그레이션 후: 회차 컬럼은 Col D부터 (A=가입순서, B=member_id, C=닉네임, D+=회차)
// 마이그레이션 전: 회차 컬럼은 Col C부터 (A=가입순서, B=닉네임, C+=회차)

const POST_MIG_OFFSET = 4; // D=4
const PRE_MIG_OFFSET = 3; // C=3

export function columnNumberToLetter(n: number): string {
  if (n <= 0) return "";
  let result = "";
  let v = n;
  while (v > 0) {
    const rem = (v - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    v = Math.floor((v - 1) / 26);
  }
  return result;
}

interface ValuesGetResponse {
  range: string;
  values?: string[][];
}

export type RaidColumnLayout = "pre-migration" | "post-migration";

export async function findRaidColumn(
  spreadsheetId: string,
  raidNum: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
  layout: RaidColumnLayout = "post-migration"
): Promise<string | null> {
  const startCol = layout === "pre-migration" ? "C" : "D";
  const offset = layout === "pre-migration" ? PRE_MIG_OFFSET : POST_MIG_OFFSET;
  const range = `유니온 멤버!${startCol}1:Z1`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`FIND_COLUMN_FAILED: HTTP ${res.status}`);
  }
  const body = (await res.json()) as ValuesGetResponse;
  const row = body.values?.[0] ?? [];

  const target = `${raidNum}차`;
  let idx = row.findIndex((h) => h.trim() === target);
  if (idx === -1) {
    idx = row.findIndex((h) => h.trim() === "OO차");
  }
  if (idx === -1) return null;

  return columnNumberToLetter(offset + idx);
}
