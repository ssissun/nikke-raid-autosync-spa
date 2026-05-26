// F-NRA-002-07 SHA-256 fingerprint — 옵션 B: 도구 추가 컬럼(member_id) + _nra_ 탭 제외.
// 마스터 원본 헤더만 hash → oddoido 협조 불필요, 도구 추가로 인한 fingerprint 변경 없음.

const TOOL_OWNED_COLUMNS = new Set<string>(["member_id"]);
const TOOL_OWNED_TAB_PREFIX = "_nra_";

// 실측 시트 fingerprint 등록 후 채움. 빈 배열이면 항상 MISMATCH.
export const ALLOWED_FINGERPRINTS: readonly string[] = [];

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

  const masterColumns = memberHeader.filter(
    (col) =>
      !TOOL_OWNED_COLUMNS.has(col) && !String(col).startsWith(TOOL_OWNED_TAB_PREFIX)
  );

  const raw = [...masterColumns, ...raidStatsHeader].map((h) => h.trim()).join("|");
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
