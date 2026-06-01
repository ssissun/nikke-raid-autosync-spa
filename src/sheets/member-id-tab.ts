// member_id 저장 — '_nra_member_mapping' 숨김 탭 (유니온 멤버 행과 1:1 정렬된 A열).
// 유니온 멤버 탭을 원본 레이아웃(A 가입순서·B 닉네임·C+ 회차)으로 유지하기 위해
// member_id 를 별도 탭으로 분리. 마스터 Apps Script/수식은 유니온 멤버 고정 열을 읽으므로
// 유니온 멤버에 열을 삽입하면 깨진다(역마이그레이션으로 기존 Col B 삽입분 제거).
//
// 탭 구조: A1="member_id" 헤더, A{R}(R≥2) = 유니온 멤버 row R 의 member_id. 빈 셀 = 매칭 없음.
// 매 실행 최종 스냅샷으로 통째 덮어쓰기(증분 시프트 불필요).
// 마스터 sync 는 명명된 5개 탭만 복사하므로 _nra_ 접두 탭은 보존됨.

const MAPPING_TAB = "_nra_member_mapping";
const UNION_MEMBER_SHEET = "유니온 멤버";
const MAX_DATA_ROWS = 32; // 유니온 멤버 정원

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
 * 매핑 탭을 읽어 {유니온 멤버 sheetRow → member_id} 반환. 탭 부재 시 present=false.
 */
export async function readMemberIdTab(
  spreadsheetId: string,
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ present: boolean; memberIdByRow: Map<number, string> }> {
  const sheets = await listSheets(spreadsheetId, token, fetchImpl);
  const memberIdByRow = new Map<number, string>();
  if (!sheets.some((s) => s.title === MAPPING_TAB)) {
    return { present: false, memberIdByRow };
  }

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`${MAPPING_TAB}!A1:A${MAX_DATA_ROWS + 1}`)}`;
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`MAPPING_READ_FAILED: HTTP ${res.status}`);
  const values = ((await res.json()) as { values?: string[][] }).values ?? [];
  // values[0]=A1(헤더), values[i]=A{i+1} ↔ 유니온 멤버 row (i+1)
  for (let i = 1; i < values.length; i++) {
    const memberId = String(values[i]?.[0] ?? "").trim();
    if (memberId.length > 0) memberIdByRow.set(i + 1, memberId);
  }
  return { present: true, memberIdByRow };
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
              gridProperties: { rowCount: MAX_DATA_ROWS + 1, columnCount: 1 },
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
 * 최종 {sheetRow → member_id} 스냅샷을 매핑 탭에 통째로 기록(없으면 생성).
 * A1 헤더 + A2..A33 (유니온 멤버 row 2..33 정렬).
 */
export async function writeMemberIdTab(
  spreadsheetId: string,
  token: string,
  memberIdByRow: ReadonlyMap<number, string>,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  await ensureMappingTab(spreadsheetId, token, fetchImpl);
  const values: string[][] = [["member_id"]];
  for (let r = 2; r <= MAX_DATA_ROWS + 1; r++) {
    values.push([memberIdByRow.get(r) ?? ""]);
  }
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`${MAPPING_TAB}!A1:A${MAX_DATA_ROWS + 1}`)}?valueInputOption=RAW`;
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
 * Col B 의 member_id 를 추출 → 매핑 탭에 기록 → 유니온 멤버 Col B 삭제(닉네임 B·회차 C+ 원복).
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

  // Col B(idx 1) = member_id 추출, 행 정렬
  const memberIdByRow = new Map<number, string>();
  for (let i = 1; i < rows.length && i <= MAX_DATA_ROWS; i++) {
    const memberId = String(rows[i]?.[1] ?? "").trim();
    const sheetRow = i + 1; // values index i ↔ sheetRow i+1
    if (memberId.length > 0) memberIdByRow.set(sheetRow, memberId);
  }

  // 1) 탭 기록 (생성 포함)
  await writeMemberIdTab(spreadsheetId, token, memberIdByRow, fetchImpl);

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

  return { migrated: true, count: memberIdByRow.size };
}

export { MAPPING_TAB };
