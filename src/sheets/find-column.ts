import { ensureSheetGrid } from "./grid";

// F-NRA-002-07 회차 컬럼 자동 탐색 + 부재 시 신규 추가.
// 마이그레이션 후: 회차 컬럼은 Col D부터 (A=가입순서, B=member_id, C=닉네임, D+=회차)
// 마이그레이션 전: 회차 컬럼은 Col C부터 (A=가입순서, B=닉네임, C+=회차)
// SHEET_SCHEMA §2.2 회차 컬럼 결정 3단계:
//   1) 정확 일치 → 그 컬럼
//   2) "OO차" placeholder → placeholder 컬럼 + 헤더 번호 입력
//   3) 둘 다 부재 → 마지막 컬럼 +1 위치에 신규 헤더 + 데이터

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

export interface RaidColumnResolution {
  column: string; // Letter (예: "C", "H")
  /** 신규 컬럼 헤더 쓰기가 필요한지. ensureRaidColumn 에서만 true */
  isNew: boolean;
  /** "OO차" placeholder 위치 매칭 시 placeholder 컬럼 헤더에 raidNum 쓰기 필요 */
  isPlaceholder: boolean;
}

const RAID_NUM_HEADER_PATTERN = /^(\d+|OO)차$/;

/**
 * 기존 동작 유지 — 정확 일치 또는 OO차 placeholder 매칭. 둘 다 부재면 null.
 */
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

/**
 * columnLetter "A"→1, "Z"→26, "AA"→27, "AZ"→52 변환 (역연산).
 */
export function columnLetterToNumber(letter: string): number {
  let n = 0;
  for (const ch of letter.toUpperCase()) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) return 0;
    n = n * 26 + (code - 64);
  }
  return n;
}

async function writeColumnHeader(
  spreadsheetId: string,
  column: string,
  raidNum: string,
  accessToken: string,
  fetchImpl: typeof fetch
): Promise<void> {
  // grid 한계 초과 방지 — 먼저 columnCount 확장 (rowCount는 기존 유지)
  const requiredCols = columnLetterToNumber(column);
  if (requiredCols > 0) {
    await ensureSheetGrid(
      spreadsheetId,
      "유니온 멤버",
      0, // rowCount 변경 없음
      requiredCols,
      accessToken,
      fetchImpl
    );
  }
  const range = `유니온 멤버!${column}1`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  const res = await fetchImpl(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values: [[`${raidNum}차`]] }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`COLUMN_HEADER_WRITE_FAILED: HTTP ${res.status} ${errText.slice(0, 120)}`);
  }
}


/**
 * SHEET_SCHEMA §2.2 3단계 분기 완전 구현.
 * findRaidColumn 호출 후 null 이면 마지막 컬럼 +1 위치에 신규 헤더 쓰기.
 * "OO차" placeholder 매칭 시 placeholder 컬럼 헤더를 raidNum 으로 갱신.
 */
export async function ensureRaidColumn(
  spreadsheetId: string,
  raidNum: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
  layout: RaidColumnLayout = "post-migration"
): Promise<RaidColumnResolution> {
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

  // 1) 정확 일치
  const exactIdx = row.findIndex((h) => h.trim() === target);
  if (exactIdx !== -1) {
    return {
      column: columnNumberToLetter(offset + exactIdx),
      isNew: false,
      isPlaceholder: false,
    };
  }

  // 2) "OO차" placeholder
  const placeholderIdx = row.findIndex((h) => h.trim() === "OO차");
  if (placeholderIdx !== -1) {
    const col = columnNumberToLetter(offset + placeholderIdx);
    await writeColumnHeader(spreadsheetId, col, raidNum, accessToken, fetchImpl);
    return { column: col, isNew: false, isPlaceholder: true };
  }

  // 3) 둘 다 부재 → 마지막 비어있지 않은 컬럼 +1 위치에 신규 헤더
  //    row에서 마지막 "N차" 패턴 매칭 위치 또는 마지막 비어있지 않은 위치 +1
  let lastFilledIdx = -1;
  for (let i = row.length - 1; i >= 0; i--) {
    const h = (row[i] ?? "").trim();
    if (h.length > 0) {
      lastFilledIdx = i;
      break;
    }
  }
  const newIdx = lastFilledIdx + 1;
  const newCol = columnNumberToLetter(offset + newIdx);
  await writeColumnHeader(spreadsheetId, newCol, raidNum, accessToken, fetchImpl);
  return { column: newCol, isNew: true, isPlaceholder: false };
}

export { RAID_NUM_HEADER_PATTERN };
