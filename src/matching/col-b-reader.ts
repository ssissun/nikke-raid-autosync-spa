// 유니온 멤버 Col A/B/C 읽기 — Sheets API values.get.
// SOT: ai_docs/nikke-raid-autosync/API_SPEC.md §3 / SHEET_SCHEMA.md §2

const UNION_MEMBER_RANGE = "유니온 멤버!A2:C33";

interface ValuesGetResponse {
  range: string;
  majorDimension: "ROWS" | "COLUMNS";
  values?: string[][];
}

export interface ReadColBMapResult {
  colBMap: Map<string, number>; // member_id → sheetRow (2-based, header=row1)
  colCNicknames: Map<number, string>; // sheetRow → nickname
  allColBEmpty: boolean;
}

export async function readColBMap(
  accessToken: string,
  sheetId: string
): Promise<ReadColBMapResult> {
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}` +
    `/values/${encodeURIComponent(UNION_MEMBER_RANGE)}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    throw new Error(
      `Sheets API values.get 실패 (status ${res.status}) — range ${UNION_MEMBER_RANGE}`
    );
  }

  const data = (await res.json()) as ValuesGetResponse;
  const rows = data.values ?? [];

  const colBMap = new Map<string, number>();
  const colCNicknames = new Map<number, string>();
  let anyColB = false;

  // rows[i]는 시트 i+2 행 (A2부터 시작). Col B = idx 1, Col C = idx 2.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const sheetRow = i + 2;
    const colB = (row[1] ?? "").trim();
    const colC = (row[2] ?? "").trim();
    if (colB.length > 0) {
      colBMap.set(colB, sheetRow);
      anyColB = true;
    }
    if (colC.length > 0) {
      colCNicknames.set(sheetRow, colC);
    }
  }

  return {
    colBMap,
    colCNicknames,
    allColBEmpty: !anyColB,
  };
}
