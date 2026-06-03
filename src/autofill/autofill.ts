// 첫 실행 멤버 자동 채움 — 핵심 로직 (E-NRA-006).
//
// 빈 `유니온 멤버` 시트(첫 실행 = detectMigrationMode "block")에서 캡처된 payload
// 닉네임을 캡처 순서 그대로 RAW 로 안전하게 쓴다. 가입 순서 정렬은 사용자가 시트에서 직접
// 수정한다(32명 드래그 UX 불편 회피 — 사용자 결정 2026-06-03). 쓰기 직후 회차 동기화까지
// 한 번에 진행하므로 재fetch 가 필요 없다.
//
// 데이터 무결성 가드:
//   - BR-1: 쓰기 직전 Col B 재read(preWriteCheck) — 비어있을 때만 쓴다(첫 실행 한정).
//   - BR-6: valueInputOption=RAW — `=`/`+`/`@` 시작 닉네임을 수식 평가 없이 리터럴 보존.
//   - BR-4: 캡처 N명만 채움(부족분은 비워둠).
//   - BR-3: 닉네임(Col B)만 쓰고 member_id 매핑/분류 로직은 건드리지 않는다.

import type { NikkeRaidPayload } from "../types";

export const AUTOFILL_CAPACITY = 32;

export type AutofillWriteResult =
  | { ok: true; written: number }
  | { ok: false; reason: "not_empty" }; // BR-1 가드 차단

const UNION_MEMBER_AUTOFILL_RANGE_READ = "유니온 멤버!B2:B33";

// payload(multi/data)에서 닉네임 배열 추출. 빈/공백 닉네임은 제외(닉네임으로 안 셈).
// 추출 순서 = payload.members 배열 순서 (가입 순서와 무관, 0/32).
export function extractNicknames(payload: NikkeRaidPayload | null): string[] {
  if (payload === null) return [];
  if (payload.type !== "nikke-raid-multi" && payload.type !== "nikke-raid-data") {
    return [];
  }
  return payload.members
    .map((m) => m.nickname)
    .filter((n) => typeof n === "string" && n.trim().length > 0);
}

// 쓰기 직전 가드 (BR-1) — `유니온 멤버!B2:B33` 재read 하여 전부 비었으면 true.
// 판정 시점과 쓰기 시점 사이 사용자가 시트에 직접 입력하는 race 를 차단.
export async function preWriteCheck(
  sheetId: string,
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}` +
    `/values/${encodeURIComponent(UNION_MEMBER_AUTOFILL_RANGE_READ)}`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`AUTOFILL_PREWRITE_READ_FAILED: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { values?: string[][] };
  const rows = data.values ?? [];
  // Sheets API 는 trailing 빈 행을 생략하므로 빈 시트는 rows=[] → every() true.
  return rows.every((row) => (row[0] ?? "").trim().length === 0);
}

// 자동 채움 쓰기 (BR-1 + BR-6) — preWriteCheck 통과 시에만 RAW 로 N개 닉네임 쓰기.
// 닉네임 쓰기만 RAW (회차 숫자 등 기존 USER_ENTERED 경로와 분리).
// member_id 매핑/분류 로직은 건드리지 않는다 (BR-3 회귀 가드).
export async function writeAutofill(
  nicknames: readonly string[],
  sheetId: string,
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<AutofillWriteResult> {
  if (nicknames.length === 0) {
    throw new Error("AUTOFILL_NO_MEMBERS: 쓸 닉네임이 없습니다");
  }
  const empty = await preWriteCheck(sheetId, token, fetchImpl);
  if (!empty) {
    console.warn("[autofill] blocked: sheet not empty (BR-1 guard)");
    return { ok: false, reason: "not_empty" };
  }
  const values = nicknames.map((n) => [n]);
  const range = `유니온 멤버!B2:B${1 + values.length}`;
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}` +
    `/values/${encodeURIComponent(range)}?valueInputOption=RAW`; // BR-6: RAW
  const res = await fetchImpl(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`AUTOFILL_WRITE_FAILED: HTTP ${res.status} ${txt.slice(0, 120)}`);
  }
  console.info(`[autofill] written=${values.length} rows, valueInputOption=RAW`);
  return { ok: true, written: values.length };
}
