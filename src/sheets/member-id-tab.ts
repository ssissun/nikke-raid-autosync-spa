// member_id 저장 — '_nra_member_mapping' 숨김 탭 (유니온 멤버 행과 1:1 정렬).
// 유니온 멤버 탭을 원본 레이아웃(A 가입순서·B 닉네임·C+ 회차)으로 유지하기 위해
// member_id 를 별도 탭으로 분리. 마스터 Apps Script/수식은 유니온 멤버 고정 열을 읽으므로
// 유니온 멤버에 열을 삽입하면 깨진다(역마이그레이션으로 기존 Col B 삽입분 제거).
//
// 탭 구조: A=닉네임, B=member_id (A1/B1 헤더). 행 R(R≥2) = 유니온 멤버 row R.
//   - 닉네임을 함께 저장 → 행 정렬이 틀어져도(수동 재정렬·부분 실패) 닉네임으로 복구 가능.
//   - 매 실행 최종 스냅샷으로 통째 덮어쓰기(증분 시프트 불필요).
//   - 마스터 sync 는 명명된 5개 탭만 복사하므로 _nra_ 접두 탭은 보존됨.

const MAPPING_TAB = "_nra_member_mapping";
const UNION_MEMBER_SHEET = "유니온 멤버";
const MAX_DATA_ROWS = 32; // 유니온 멤버 정원

export interface MemberMapEntry {
  nickname: string;
  member_id: string;
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
  if (!res.ok) throw new Error(`MAPPING_LIST_FAILED: HTTP ${res.status}`);
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
 * 매핑 탭을 읽어 {유니온 멤버 sheetRow → {nickname, member_id}} 반환. 탭 부재 시 present=false.
 */
export async function readMemberIdTab(
  spreadsheetId: string,
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ present: boolean; byRow: Map<number, MemberMapEntry> }> {
  const sheets = await listSheets(spreadsheetId, token, fetchImpl);
  const byRow = new Map<number, MemberMapEntry>();
  if (!sheets.some((s) => s.title === MAPPING_TAB)) {
    return { present: false, byRow };
  }

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`${MAPPING_TAB}!A1:B${MAX_DATA_ROWS + 1}`)}`;
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`MAPPING_READ_FAILED: HTTP ${res.status}`);
  const values = ((await res.json()) as { values?: string[][] }).values ?? [];
  // values[0]=헤더(A1/B1), values[i]=행 (i+1) ↔ 유니온 멤버 row (i+1)
  for (let i = 1; i < values.length; i++) {
    const nickname = String(values[i]?.[0] ?? "").trim();
    const member_id = String(values[i]?.[1] ?? "").trim();
    if (member_id.length > 0) byRow.set(i + 1, { nickname, member_id });
  }
  return { present: true, byRow };
}

/**
 * 탭(행→{nickname,member_id})과 유니온 멤버 현재 닉네임(행→nickname)으로 {member_id → sheetRow} 산출.
 * 행 정렬 일치(탭 닉네임 == 시트 닉네임) → 신뢰. 틀어진 행 → 닉네임으로 복구.
 */
export function resolveColBMap(
  tabByRow: ReadonlyMap<number, MemberMapEntry>,
  sheetNickByRow: ReadonlyMap<number, string>
): Map<string, number> {
  // 닉네임 → member_id (행 드리프트 복구용). 중복 닉네임은 마지막 우선(희소 케이스).
  const byNick = new Map<string, string>();
  for (const { nickname, member_id } of tabByRow.values()) {
    if (nickname.length > 0 && member_id.length > 0) byNick.set(nickname, member_id);
  }
  const colBMap = new Map<string, number>();
  for (const [row, nick] of sheetNickByRow.entries()) {
    const entry = tabByRow.get(row);
    if (entry !== undefined && entry.member_id.length > 0 && entry.nickname === nick) {
      colBMap.set(entry.member_id, row); // 행 정렬 일치 → 신뢰
    } else {
      const recovered = byNick.get(nick); // 드리프트 → 닉네임으로 복구
      if (recovered !== undefined) colBMap.set(recovered, row);
    }
  }
  return colBMap;
}

async function ensureMappingTab(
  spreadsheetId: string,
  token: string,
  fetchImpl: typeof fetch
): Promise<void> {
  const sheets = await listSheets(spreadsheetId, token, fetchImpl);
  if (sheets.some((s) => s.title === MAPPING_TAB)) return;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [
        {
          addSheet: {
            properties: {
              title: MAPPING_TAB,
              hidden: true,
              gridProperties: { rowCount: MAX_DATA_ROWS + 1, columnCount: 2 },
            },
          },
        },
      ],
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`MAPPING_CREATE_FAILED: HTTP ${res.status} ${t.slice(0, 150)}`);
  }
}

/**
 * 최종 {sheetRow → {nickname, member_id}} 스냅샷을 매핑 탭에 통째로 기록(없으면 생성).
 * A1/B1 헤더 + A2:B33 (유니온 멤버 row 2..33 정렬).
 */
export async function writeMemberIdTab(
  spreadsheetId: string,
  token: string,
  mappingByRow: ReadonlyMap<number, MemberMapEntry>,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  await ensureMappingTab(spreadsheetId, token, fetchImpl);
  const values: string[][] = [["닉네임", "member_id"]];
  for (let r = 2; r <= MAX_DATA_ROWS + 1; r++) {
    const e = mappingByRow.get(r);
    values.push([e?.nickname ?? "", e?.member_id ?? ""]);
  }
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`${MAPPING_TAB}!A1:B${MAX_DATA_ROWS + 1}`)}?valueInputOption=RAW`;
  const res = await fetchImpl(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`MAPPING_WRITE_FAILED: HTTP ${res.status} ${t.slice(0, 150)}`);
  }
}

/**
 * 이미 유니온 멤버 Col B 에 member_id 가 삽입된 시트(버그 상태) 복구:
 * Col B 의 member_id + Col C 닉네임을 추출 → 매핑 탭에 기록 → 유니온 멤버 Col B 삭제(닉네임 B·회차 C+ 원복).
 * Col B 헤더가 'member_id' 가 아니면 no-op (migrated=false).
 *
 * 순서: 탭 기록 먼저 → Col B 삭제 (삭제 후 탭 쓰기 실패 시 member_id 유실 방지).
 */
export async function reverseMigrateColB(
  spreadsheetId: string,
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ migrated: boolean; count: number }> {
  const readUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`${UNION_MEMBER_SHEET}!A1:Z${MAX_DATA_ROWS + 1}`)}`;
  const readRes = await fetchImpl(readUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!readRes.ok) throw new Error(`REVERSE_READ_FAILED: HTTP ${readRes.status}`);
  const rows = ((await readRes.json()) as { values?: string[][] }).values ?? [];
  const header = rows[0] ?? [];
  if (String(header[1] ?? "").trim() !== "member_id") {
    return { migrated: false, count: 0 };
  }

  // post-migration 레이아웃: Col B(idx 1)=member_id, Col C(idx 2)=닉네임. 행 정렬.
  const mappingByRow = new Map<number, MemberMapEntry>();
  for (let i = 1; i < rows.length && i <= MAX_DATA_ROWS; i++) {
    const member_id = String(rows[i]?.[1] ?? "").trim();
    const nickname = String(rows[i]?.[2] ?? "").trim();
    const sheetRow = i + 1; // values index i ↔ sheetRow i+1
    if (member_id.length > 0) mappingByRow.set(sheetRow, { nickname, member_id });
  }

  // 1) 탭 기록 (생성 포함)
  await writeMemberIdTab(spreadsheetId, token, mappingByRow, fetchImpl);

  // 2) 유니온 멤버 Col B 삭제
  const sheets = await listSheets(spreadsheetId, token, fetchImpl);
  const union = sheets.find((s) => s.title === UNION_MEMBER_SHEET);
  if (union === undefined) throw new Error("REVERSE_FAILED: '유니온 멤버' 탭 부재");
  const delUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`;
  const delRes = await fetchImpl(delUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [
        {
          deleteDimension: {
            range: { sheetId: union.sheetId, dimension: "COLUMNS", startIndex: 1, endIndex: 2 },
          },
        },
      ],
    }),
  });
  if (!delRes.ok) {
    const t = await delRes.text().catch(() => "");
    throw new Error(`REVERSE_DELETE_FAILED: HTTP ${delRes.status} ${t.slice(0, 150)}`);
  }

  return { migrated: true, count: mappingByRow.size };
}

export { MAPPING_TAB };
