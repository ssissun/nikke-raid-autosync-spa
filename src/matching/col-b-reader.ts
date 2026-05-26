// 유니온 멤버 Col A/B/C 읽기 — Sheets API values.get.
// SOT: ai_docs/nikke-raid-autosync/API_SPEC.md §3 / SHEET_SCHEMA.md §2
// 헤더 자동 감지: 마이그레이션 전(Col B=닉네임) vs 후(Col B=member_id, Col C=닉네임)

const UNION_MEMBER_HEADER_DATA_RANGE = "유니온 멤버!A1:C33";

interface ValuesGetResponse {
  range: string;
  majorDimension: "ROWS" | "COLUMNS";
  values?: string[][];
}

export type SheetLayout = "pre-migration" | "post-migration";

export interface ReadColBMapResult {
  colBMap: Map<string, number>; // member_id → sheetRow (2-based, header=row1)
  colCNicknames: Map<number, string>; // sheetRow → nickname
  allColBEmpty: boolean;
  layout: SheetLayout;
  header: string[];
}

function detectLayout(header: readonly string[]): SheetLayout {
  const colB = (header[1] ?? "").trim();
  if (colB === "member_id") return "post-migration";
  // Col B에 "닉네임" 또는 nickname 키워드 / Col B 비어있고 Col C가 OO차/N차 패턴이면 pre-migration
  if (colB.includes("닉네임") || /nickname/i.test(colB)) return "pre-migration";
  const colC = (header[2] ?? "").trim();
  if (/^(OO차|\d+차)$/.test(colC)) return "pre-migration";
  return "post-migration"; // 기본
}

export async function readColBMap(
  accessToken: string,
  sheetId: string
): Promise<ReadColBMapResult> {
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}` +
    `/values/${encodeURIComponent(UNION_MEMBER_HEADER_DATA_RANGE)}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    throw new Error(
      `Sheets API values.get 실패 (status ${res.status}) — range ${UNION_MEMBER_HEADER_DATA_RANGE}`
    );
  }

  const data = (await res.json()) as ValuesGetResponse;
  const allRows = data.values ?? [];
  const header = allRows[0] ?? [];
  const dataRows = allRows.slice(1);
  const layout = detectLayout(header);

  const colBMap = new Map<string, number>();
  const colCNicknames = new Map<number, string>();
  let anyColB = false;

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const sheetRow = i + 2;
    if (layout === "pre-migration") {
      // Col A=가입순서, Col B=닉네임 (마이그레이션 전 위치), Col C=OO차
      const nickname = (row[1] ?? "").trim();
      if (nickname.length > 0) {
        colCNicknames.set(sheetRow, nickname);
      }
      // colBMap은 빈 상태 유지 (member_id 부재) → allColBEmpty=true → backfill 모드 진입
    } else {
      // Col A=가입순서, Col B=member_id, Col C=닉네임 (마이그레이션 후)
      const memberId = (row[1] ?? "").trim();
      const nickname = (row[2] ?? "").trim();
      if (memberId.length > 0) {
        colBMap.set(memberId, sheetRow);
        anyColB = true;
      }
      if (nickname.length > 0) {
        colCNicknames.set(sheetRow, nickname);
      }
    }
  }

  return {
    colBMap,
    colCNicknames,
    allColBEmpty: !anyColB,
    layout,
    header,
  };
}
