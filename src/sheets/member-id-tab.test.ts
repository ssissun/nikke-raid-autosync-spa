import { describe, it, expect, vi } from "vitest";
import { readMemberIdTab, writeMemberIdTab, reverseMigrateColB } from "./member-id-tab";

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
    if (u.includes(`${MAPPING}!A1:A33`) && method === "PUT") {
      const body = JSON.parse(String(init!.body));
      writes.push({ range: `${MAPPING}!A1:A33`, values: body.values });
      return new Response(JSON.stringify({}), { status: 200 });
    }
    if (u.includes(`${MAPPING}!A1:A33`) && method === "GET") {
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
    expect(r.memberIdByRow.size).toBe(0);
  });

  it("탭 존재 → 행 정렬 파싱 (빈 셀 skip)", async () => {
    const { fetchImpl } = makeFetch({
      sheets: [
        { sheetId: 1, title: "유니온 멤버" },
        { sheetId: 9, title: MAPPING },
      ],
      tabValues: [["member_id"], ["100"], ["200"], [""], ["400"]],
    });
    const r = await readMemberIdTab("s", "t", fetchImpl);
    expect(r.present).toBe(true);
    expect(r.memberIdByRow.get(2)).toBe("100"); // A2 ↔ 유니온 멤버 row2
    expect(r.memberIdByRow.get(3)).toBe("200");
    expect(r.memberIdByRow.has(4)).toBe(false); // 빈 셀
    expect(r.memberIdByRow.get(5)).toBe("400");
  });
});

describe("writeMemberIdTab", () => {
  it("탭 없으면 생성 후 A1:A33 행 정렬 기록", async () => {
    const { fetchImpl, writes, added } = makeFetch({
      sheets: [{ sheetId: 1, title: "유니온 멤버" }],
    });
    await writeMemberIdTab("s", "t", new Map([[2, "100"], [3, "200"]]), fetchImpl);
    expect(added).toContain(MAPPING);
    expect(writes).toHaveLength(1);
    expect(writes[0].values).toHaveLength(33); // 헤더 + 32
    expect(writes[0].values[0]).toEqual(["member_id"]);
    expect(writes[0].values[1]).toEqual(["100"]); // A2 = row2
    expect(writes[0].values[2]).toEqual(["200"]); // A3 = row3
    expect(writes[0].values[3]).toEqual([""]); // A4 빈
  });

  it("탭 이미 존재 → addSheet 안 함", async () => {
    const { fetchImpl, added } = makeFetch({
      sheets: [
        { sheetId: 1, title: "유니온 멤버" },
        { sheetId: 9, title: MAPPING },
      ],
    });
    await writeMemberIdTab("s", "t", new Map([[2, "100"]]), fetchImpl);
    expect(added).toHaveLength(0);
  });
});

describe("reverseMigrateColB", () => {
  it("Col B=member_id (버그 상태) → 탭 기록 + Col B 삭제", async () => {
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
    expect(writes[0].values[1]).toEqual(["100"]); // row2
    expect(writes[0].values[2]).toEqual(["200"]); // row3
    // 유니온 멤버(sheetId 1) Col B(startIndex 1) 삭제
    expect(deletes).toEqual([{ sheetId: 1, startIndex: 1 }]);
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
