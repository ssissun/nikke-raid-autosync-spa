// F-NRA-002-07 SHA-256 fingerprint — 옵션 B: 도구 추가 영역 제외 + 회차 컬럼 OO차 placeholder normalize.
// 마스터 원본 헤더 구조만 hash → 회차 진행 + 도구 추가에 무관하게 안정.
//
// 검증 대상:
//   유니온 멤버 헤더: 가입 순서 / 닉네임 / OO차 (회차 컬럼 placeholder 단일)
//   레이드 통계 헤더: 16 컬럼 그대로
//
// 자동 제외:
//   - TOOL_OWNED_COLUMNS (member_id) — 도구 자동 추가
//   - TOOL_OWNED_TAB_PREFIX (_nra_) — 도구 자동 추가 탭 prefix
//   - 회차 컬럼 (\d+차 / OO차) — 단일 "OO차" 로 normalize (회차 진행 무관)

const TOOL_OWNED_COLUMNS = new Set<string>(["member_id"]);
const TOOL_OWNED_TAB_PREFIX = "_nra_";
const RAID_COLUMN_PATTERN = /^(?:\d+|OO)차$/;
const RAID_COLUMN_PLACEHOLDER = "OO차";

// 실측 시트 fingerprint 등록 후 채움. 빈 배열이면 항상 MISMATCH.
//
// 등록 이력:
//   2026-05-27 — ssissun 본인 사본 + 베타 사본(아이보 추정) 교차 측정 동일 hash 확인.
//   oddoido 마스터 v1.12 (가입 순서/닉네임/OO차 + 회차 16컬럼) 구조 표준.
export const ALLOWED_FINGERPRINTS: readonly string[] = [
  "14c9b03b53810c97c1866dd30f29b812930b2aa0ab820c8a7c9b78c4638e8ad9",
];

interface BatchGetResponse {
  spreadsheetId: string;
  valueRanges: Array<{ range: string; values?: string[][] }>;
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 두 헤더 행(유니온 멤버!A1:Z1 + 레이드 통계!A1:P1)을 batchGet으로 읽어 SHA-256 hex 반환.
 * 도구 추가 컬럼(member_id) + _nra_ prefix 탭은 제외.
 */
export async function computeFingerprint(
  spreadsheetId: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const ranges = [
    encodeURIComponent("유니온 멤버!A1:Z1"),
    encodeURIComponent("레이드 통계!A1:P1"),
  ];
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchGet?ranges=${ranges.join("&ranges=")}`;

  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`FINGERPRINT_READ_FAILED: HTTP ${res.status}`);
  }

  const body = (await res.json()) as BatchGetResponse;
  const valueRanges = body.valueRanges ?? [];
  const memberHeader = valueRanges[0]?.values?.[0] ?? [];
  const raidStatsHeader = valueRanges[1]?.values?.[0] ?? [];

  if (memberHeader.length === 0 || raidStatsHeader.length === 0) {
    throw new Error("FINGERPRINT_READ_FAILED: 헤더 행이 비어 있음");
  }

  const masterColumns: string[] = [];
  let raidColumnSeen = false;
  for (const col of memberHeader) {
    const trimmed = String(col ?? "").trim();
    if (trimmed.length === 0) continue;
    if (TOOL_OWNED_COLUMNS.has(trimmed)) continue;
    if (trimmed.startsWith(TOOL_OWNED_TAB_PREFIX)) continue;
    // 회차 컬럼 (35차, 36차, ..., OO차) 은 단일 OO차 placeholder 로 normalize.
    // 회차 진행에 따라 컬럼이 추가되어도 hash 안정.
    if (RAID_COLUMN_PATTERN.test(trimmed)) {
      if (!raidColumnSeen) {
        masterColumns.push(RAID_COLUMN_PLACEHOLDER);
        raidColumnSeen = true;
      }
      continue;
    }
    masterColumns.push(trimmed);
  }

  const raw = [
    ...masterColumns,
    ...raidStatsHeader.map((h) => String(h ?? "").trim()),
  ].join("|");
  const encoded = new TextEncoder().encode(raw);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return hex(digest);
}

export async function verifyFingerprint(
  spreadsheetId: string,
  accessToken: string,
  options: { skip?: boolean; allowed?: readonly string[]; fetchImpl?: typeof fetch } = {}
): Promise<string> {
  if (options.skip === true) {
    return "SKIPPED";
  }
  const computed = await computeFingerprint(
    spreadsheetId,
    accessToken,
    options.fetchImpl
  );
  const allowed = options.allowed ?? ALLOWED_FINGERPRINTS;
  if (!allowed.includes(computed)) {
    throw new Error(`FINGERPRINT_MISMATCH: computed=${computed.slice(0, 16)}...`);
  }
  return computed;
}
