// F-NRA-002-07 회차 컬럼 자동 탐색 — `유니온 멤버!D1:Z1`.
// Col B(member_id, hidden) 삽입 이후 회차 컬럼은 D부터 시작 (A=가입순서, B=member_id, C=닉네임, D+=회차).

const RANGE = "유니온 멤버!D1:Z1";
const D_COLUMN_OFFSET = 4; // A=1, B=2, C=3, D=4

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

export async function findRaidColumn(
  spreadsheetId: string,
  raidNum: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(RANGE)}`;
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

  return columnNumberToLetter(D_COLUMN_OFFSET + idx);
}
