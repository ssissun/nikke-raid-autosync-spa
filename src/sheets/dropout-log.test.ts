import { describe, it, expect, vi } from "vitest";
import { readDropoutTab, recordDropouts } from "./dropout-log";

const DROPOUT = "탈퇴자 레벨 기록";

// 탈퇴자 탭 grid 를 들고 read/insert/header-put/batchUpdate 에 반응하는 stateful mock.
function makeFetch(opts: {
  present?: boolean;
  grid?: string[][];
  gridRows?: number;
  gridCols?: number;
}) {
  const present = opts.present ?? true;
  const grid = (opts.grid ?? []).map((r) => [...r]);
  const gridRows = opts.gridRows ?? 1000;
  const gridCols = opts.gridCols ?? 100;
  const batchData: Array<{ range: string; values: string[][] }> = [];
  const inserts: Array<{ startIndex: number }> = [];
  const headerPuts: Array<{ range: string; value: string }> = [];
  const appends: Array<{ dimension: string; length: number }> = [];

  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const u = decodeURIComponent(String(url));
    const method = init?.method ?? "GET";

    // ensureSheetGrid 의 grid props 조회 (gridProperties 포함)
    if (u.includes("gridProperties")) {
      return new Response(
        JSON.stringify({
          sheets: [
            {
              properties: {
                sheetId: 9,
                title: DROPOUT,
                gridProperties: { rowCount: gridRows, columnCount: gridCols },
              },
            },
          ],
        }),
        { status: 200 }
      );
    }
    if (u.includes("fields=sheets(properties(sheetId,title))")) {
      const sheets: Array<{ properties: { sheetId: number; title: string } }> = [
        { properties: { sheetId: 1, title: "유니온 멤버" } },
      ];
      if (present) sheets.push({ properties: { sheetId: 9, title: DROPOUT } });
      return new Response(JSON.stringify({ sheets }), { status: 200 });
    }
    // 탭 values 읽기
    if (u.includes(`${DROPOUT}!A1:ZZ1000`) && method === "GET") {
      return new Response(JSON.stringify({ values: grid }), { status: 200 });
    }
    // insertDimension (컬럼 삽입) — grid 에 빈 컬럼 splice. (/values:batchUpdate 와 구분)
    if (u.endsWith(":batchUpdate") && !u.includes("/values") && method === "POST") {
      const body = JSON.parse(String(init!.body));
      const ins = body.requests?.[0]?.insertDimension;
      if (ins) {
        const at = ins.range.startIndex;
        inserts.push({ startIndex: at });
        for (const row of grid) row.splice(at, 0, "");
        return new Response(JSON.stringify({}), { status: 200 });
      }
      const app = body.requests?.[0]?.appendDimension;
      if (app) appends.push({ dimension: app.dimension, length: app.length });
      return new Response(JSON.stringify({}), { status: 200 });
    }
    // 헤더 셀 PUT (신규 컬럼 헤더 작성)
    if (u.includes(`/values/`) && method === "PUT") {
      const m = u.match(/\/values\/([^?]+)/);
      const range = m ? m[1] : "";
      const body = JSON.parse(String(init!.body));
      const val = body.values?.[0]?.[0] ?? "";
      headerPuts.push({ range, value: val });
      // grid 헤더에 반영 (col letter → index)
      const cellM = range.match(/!([A-Z]+)1$/);
      if (cellM) {
        const col = cellM[1].split("").reduce((a, c) => a * 26 + (c.charCodeAt(0) - 64), 0) - 1;
        if (grid[0]) grid[0][col] = val;
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }
    // values:batchUpdate (셀/행 업데이트) — 캡처
    if (u.includes("/values:batchUpdate") && method === "POST") {
      const body = JSON.parse(String(init!.body));
      for (const d of body.data ?? []) batchData.push(d);
      return new Response(JSON.stringify({}), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });

  return { fetchImpl: fetchImpl as unknown as typeof fetch, batchData, inserts, headerPuts, appends };
}

const HEADER = ["닉네임", "35차", "37차", "40차"];

describe("readDropoutTab", () => {
  it("탭 없으면 null (하위호환)", async () => {
    const { fetchImpl } = makeFetch({ present: false });
    expect(await readDropoutTab("s", "t", fetchImpl)).toBeNull();
  });

  it("헤더 회차 컬럼 + 닉네임 행 파싱", async () => {
    const { fetchImpl } = makeFetch({
      present: true,
      grid: [HEADER, ["옛멤버", "500", "", "520"]],
    });
    const tab = await readDropoutTab("s", "t", fetchImpl);
    expect(tab).not.toBeNull();
    expect(tab!.roundCols.get("35")).toBe(1);
    expect(tab!.roundCols.get("40")).toBe(3);
    expect(tab!.byNick.get("옛멤버")?.rowIndex).toBe(2);
  });
});

describe("recordDropouts", () => {
  it("탭 없으면 null 반환 (기록 안 함)", async () => {
    const { fetchImpl, batchData } = makeFetch({ present: false });
    const entries = new Map([["옛멤버", new Map([["40", 500]])]]);
    const r = await recordDropouts("s", "t", entries, "fillEmpty", fetchImpl);
    expect(r).toBeNull();
    expect(batchData).toHaveLength(0);
  });

  it("신규 닉네임 → 새 행 추가", async () => {
    const { fetchImpl, batchData } = makeFetch({ present: true, grid: [HEADER] });
    const entries = new Map([["옛멤버", new Map([["35", 500], ["40", 520]])]]);
    await recordDropouts("s", "t", entries, "fillEmpty", fetchImpl);
    expect(batchData).toHaveLength(1);
    expect(batchData[0].range).toBe(`${DROPOUT}!A2:D2`);
    expect(batchData[0].values).toEqual([["옛멤버", "500", "", "520"]]);
  });

  it("기존 닉네임 fillEmpty → 빈 셀만 채우고 기존 값 보존", async () => {
    const { fetchImpl, batchData } = makeFetch({
      present: true,
      grid: [HEADER, ["옛멤버", "500", "", "520"]],
    });
    // 37차(빈)=480 채움, 40차(520 있음)=999 는 보존(skip)
    const entries = new Map([["옛멤버", new Map([["37", 480], ["40", 999]])]]);
    await recordDropouts("s", "t", entries, "fillEmpty", fetchImpl);
    expect(batchData).toHaveLength(1);
    expect(batchData[0].range).toBe(`${DROPOUT}!C2`); // 37차 = C열
    expect(batchData[0].values).toEqual([["480"]]);
  });

  it("기존 닉네임 overwrite → 기존 값 덮어씀", async () => {
    const { fetchImpl, batchData } = makeFetch({
      present: true,
      grid: [HEADER, ["옛멤버", "500", "", "520"]],
    });
    const entries = new Map([["옛멤버", new Map([["40", 999]])]]);
    await recordDropouts("s", "t", entries, "overwrite", fetchImpl);
    expect(batchData).toHaveLength(1);
    expect(batchData[0].range).toBe(`${DROPOUT}!D2`); // 40차 = D열
    expect(batchData[0].values).toEqual([["999"]]);
  });

  it("탭에 없는 회차 → 차수 순서 위치에 컬럼 추가 후 기록 (Q1=A)", async () => {
    // 헤더 [닉네임,35차,40차] — 37차 없음. 37차를 40차(idx2) 앞에 삽입
    const { fetchImpl, inserts, headerPuts, batchData } = makeFetch({
      present: true,
      grid: [["닉네임", "35차", "40차"]],
    });
    const entries = new Map([["옛멤버", new Map([["37", 480]])]]);
    await recordDropouts("s", "t", entries, "fillEmpty", fetchImpl);
    expect(inserts).toEqual([{ startIndex: 2 }]); // 40차 앞
    expect(headerPuts[0].value).toBe("37차");
    // 신규 행: 헤더가 [닉네임,35차,37차,40차] 가 된 뒤 옛멤버 행 추가
    expect(batchData[0].values[0]).toEqual(["옛멤버", "", "480", ""]);
  });

  it("작은 grid(2행)에 다수 탈퇴자 append 시 grid 행 확장 (regression)", async () => {
    // 헤더만 + grid rowCount=2. 탈퇴자 2명 → 행 2·3 append. 행 3 위해 grid 사전 확장 필요.
    const { fetchImpl, appends, batchData } = makeFetch({
      present: true,
      grid: [HEADER], // 4컬럼
      gridRows: 2,
      gridCols: 14,
    });
    const entries = new Map([
      ["옛멤버A", new Map([["40", 500]])],
      ["옛멤버B", new Map([["40", 520]])],
    ]);
    await recordDropouts("s", "t", entries, "fillEmpty", fetchImpl);
    // requiredRows 3 - currentRows 2 = 1행 ROWS 확장
    const rowAppend = appends.find((a) => a.dimension === "ROWS");
    expect(rowAppend).toBeDefined();
    expect(rowAppend!.length).toBe(1);
    // 두 탈퇴자 행 모두 기록 (data 2건)
    expect(batchData).toHaveLength(2);
    expect(batchData[0].range).toBe(`${DROPOUT}!A2:D2`);
    expect(batchData[1].range).toBe(`${DROPOUT}!A3:D3`);
  });
});
