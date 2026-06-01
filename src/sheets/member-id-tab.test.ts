import { describe, it, expect, vi } from "vitest";
import {
  readMemberIdTab,
  writeMemberIdTab,
  reverseMigrateColB,
  resolveColBMap,
  type MemberMapEntry,
} from "./member-id-tab";

const MAPPING = "_nra_member_mapping";

function makeFetch(opts: {
  sheets?: Array<{ sheetId: number; title: string }>;
  tabValues?: string[][] | null;
  unionValues?: string[][];
}) {
  const sheets = [...(opts.sheets ?? [{ sheetId: 1, title: "유니온 멤버" }])];
  const tabValues = opts.tabValues ?? null;
  const unionValues = opts.unionValues ?? [];
  const writes: Array<{ range: string; values: string[][] }> = [];
  const added: string[] = [];
  const deletes: Array<{ sheetId: number; startIndex: number }> = [];

  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const u = decodeURIComponent(String(url));
    const method = init?.method ?? "GET";

    if (u.includes("fields=sheets(properties(sheetId,title))")) {
      return new Response(
        JSON.stringify({ sheets: sheets.map((s) => ({ properties: s })) }),
        { status: 200 }
      );
    }
    if (u.includes(`${MAPPING}!A1:B33`) && method === "PUT") {
      const body = JSON.parse(String(init!.body));
      writes.push({ range: `${MAPPING}!A1:B33`, values: body.values });
      return new Response(JSON.stringify({}), { status: 200 });
    }
    if (u.includes(`${MAPPING}!A1:B33`) && method === "GET") {
      return new Response(JSON.stringify({ values: tabValues ?? [] }), { status: 200 });
    }
    if (u.includes("유니온 멤버!A1:Z33") && method === "GET") {
      return new Response(JSON.stringify({ values: unionValues }), { status: 200 });
    }
    if (u.endsWith(":batchUpdate") && method === "POST") {
      const body = JSON.parse(String(init!.body));
      const req = body.requests?.[0];
      if (req?.addSheet) {
        const title = req.addSheet.properties.title;
        added.push(title);
        sheets.push({ sheetId: 99, title });
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (req?.deleteDimension) {
        deletes.push({
          sheetId: req.deleteDimension.range.sheetId,
          startIndex: req.deleteDimension.range.startIndex,
        });
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });

  return { fetchImpl: fetchImpl as unknown as typeof fetch, writes, added, deletes };
}

describe("readMemberIdTab", () => {
  it("탭 부재 → present=false, 빈 맵", async () => {
    const { fetchImpl } = makeFetch({ sheets: [{ sheetId: 1, title: "유니온 멤버" }] });
    const r = await readMemberIdTab("s", "t", fetchImpl);
    expect(r.present).toBe(false);
    expect(r.byRow.size).toBe(0);
  });

  it("탭 존재 → 행별 {닉네임, member_id} 파싱 (member_id 빈 행 skip)", async () => {
    const { fetchImpl } = makeFetch({
      sheets: [
        { sheetId: 1, title: "유니온 멤버" },
        { sheetId: 9, title: MAPPING },
      ],
      tabValues: [["닉네임", "member_id"], ["A", "100"], ["B", "200"], ["", ""], ["D", "400"]],
    });
    const r = await readMemberIdTab("s", "t", fetchImpl);
    expect(r.present).toBe(true);
    expect(r.byRow.get(2)).toEqual({ nickname: "A", member_id: "100" }); // A2 ↔ row2
    expect(r.byRow.get(3)).toEqual({ nickname: "B", member_id: "200" });
    expect(r.byRow.has(4)).toBe(false); // member_id 빈
    expect(r.byRow.get(5)).toEqual({ nickname: "D", member_id: "400" });
  });
});

describe("resolveColBMap (행 정렬 우선 + 닉네임 검증/복구)", () => {
  const tab = new Map<number, MemberMapEntry>([
    [2, { nickname: "A", member_id: "100" }],
    [3, { nickname: "B", member_id: "200" }],
  ]);

  it("행 정렬 일치 → 행 그대로 신뢰", () => {
    const sheet = new Map([[2, "A"], [3, "B"]]);
    const colB = resolveColBMap(tab, sheet);
    expect(colB.get("100")).toBe(2);
    expect(colB.get("200")).toBe(3);
  });

  it("행 드리프트(수동 재정렬) → 닉네임으로 복구", () => {
    const sheet = new Map([[2, "B"], [3, "A"]]); // 행 2↔3 뒤바뀜
    const colB = resolveColBMap(tab, sheet);
    expect(colB.get("200")).toBe(2); // B → 200 (복구)
    expect(colB.get("100")).toBe(3); // A → 100 (복구)
  });
});

describe("writeMemberIdTab", () => {
  it("탭 없으면 생성 후 A1:B33 행 정렬 기록 (닉네임 + member_id)", async () => {
    const { fetchImpl, writes, added } = makeFetch({
      sheets: [{ sheetId: 1, title: "유니온 멤버" }],
    });
    const map = new Map<number, MemberMapEntry>([
      [2, { nickname: "A", member_id: "100" }],
      [3, { nickname: "B", member_id: "200" }],
    ]);
    await writeMemberIdTab("s", "t", map, fetchImpl);
    expect(added).toContain(MAPPING);
    expect(writes).toHaveLength(1);
    expect(writes[0].values).toHaveLength(33); // 헤더 + 32
    expect(writes[0].values[0]).toEqual(["닉네임", "member_id"]);
    expect(writes[0].values[1]).toEqual(["A", "100"]); // row2
    expect(writes[0].values[2]).toEqual(["B", "200"]); // row3
    expect(writes[0].values[3]).toEqual(["", ""]); // row4 빈
  });

  it("탭 이미 존재 → addSheet 안 함", async () => {
    const { fetchImpl, added } = makeFetch({
      sheets: [
        { sheetId: 1, title: "유니온 멤버" },
        { sheetId: 9, title: MAPPING },
      ],
    });
    await writeMemberIdTab(
      "s", "t",
      new Map([[2, { nickname: "A", member_id: "100" }]]),
      fetchImpl
    );
    expect(added).toHaveLength(0);
  });
});

describe("reverseMigrateColB", () => {
  it("Col B=member_id (버그 상태) → 닉네임+member_id 탭 기록 + Col B 삭제", async () => {
    const { fetchImpl, writes, deletes, added } = makeFetch({
      sheets: [{ sheetId: 1, title: "유니온 멤버" }],
      unionValues: [
        ["가입 순서", "member_id", "닉네임", "35차"],
        ["1", "100", "닉A", "500"],
        ["2", "200", "닉B", "510"],
      ],
    });
    const r = await reverseMigrateColB("s", "t", fetchImpl);
    expect(r.migrated).toBe(true);
    expect(r.count).toBe(2);
    expect(added).toContain(MAPPING);
    expect(writes[0].values[1]).toEqual(["닉A", "100"]); // row2: 닉네임(Col C) + member_id(Col B)
    expect(writes[0].values[2]).toEqual(["닉B", "200"]);
    expect(deletes).toEqual([{ sheetId: 1, startIndex: 1 }]); // 유니온 멤버 Col B 삭제
  });

  it("원본 레이아웃 (Col B=닉네임) → no-op", async () => {
    const { fetchImpl, deletes, added } = makeFetch({
      sheets: [{ sheetId: 1, title: "유니온 멤버" }],
      unionValues: [
        ["가입 순서", "닉네임", "35차"],
        ["1", "닉A", "500"],
      ],
    });
    const r = await reverseMigrateColB("s", "t", fetchImpl);
    expect(r.migrated).toBe(false);
    expect(r.count).toBe(0);
    expect(deletes).toHaveLength(0);
    expect(added).toHaveLength(0);
  });
});
