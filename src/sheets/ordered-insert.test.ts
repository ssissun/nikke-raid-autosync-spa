import { describe, it, expect, vi } from "vitest";
import {
  parseRoundNum,
  insertStatsRowsOrdered,
  insertResultRowOrdered,
} from "./ordered-insert";

describe("parseRoundNum", () => {
  it("'40차' → 40, 'OO차'/빈값 → null", () => {
    expect(parseRoundNum("40차")).toBe(40);
    expect(parseRoundNum(" 38차 ")).toBe(38);
    expect(parseRoundNum("OO차")).toBeNull();
    expect(parseRoundNum("")).toBeNull();
    expect(parseRoundNum(undefined)).toBeNull();
    expect(parseRoundNum("회차")).toBeNull();
  });
});

// fetch mock: sheetId 조회 + ColA/range 읽기 + insertDimension + values PUT 캡처
function makeFetch(opts: {
  statsColA?: string[]; // 레이드 통계 ColA (header 포함)
  resultRows?: string[][]; // 레이드 결과 A1:Z (header 포함)
}) {
  const inserts: Array<{ dimension: string; startIndex: number; endIndex: number }> = [];
  const puts: Array<{ range: string; values: string[][] }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const u = decodeURIComponent(String(url));
    // sheetId 조회
    if (u.includes("fields=sheets(properties(sheetId,title))")) {
      return new Response(
        JSON.stringify({
          sheets: [
            { properties: { sheetId: 10, title: "레이드 통계" } },
            { properties: { sheetId: 20, title: "레이드 결과" } },
          ],
        }),
        { status: 200 }
      );
    }
    // insertDimension
    if (u.endsWith(":batchUpdate") && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      const r = body.requests?.[0]?.insertDimension?.range;
      if (r) inserts.push({ dimension: r.dimension, startIndex: r.startIndex, endIndex: r.endIndex });
      return new Response(JSON.stringify({}), { status: 200 });
    }
    // values PUT
    if (u.includes("/values/") && init?.method === "PUT") {
      const m = u.match(/\/values\/([^?]+)\?/);
      const range = m ? m[1] : "";
      const body = JSON.parse(String(init.body));
      puts.push({ range, values: body.values });
      return new Response(JSON.stringify({}), { status: 200 });
    }
    // values GET (read)
    if (u.includes("/values/") && (!init || init.method === undefined || init.method === "GET")) {
      if (u.includes("레이드 통계!A1:A5000")) {
        return new Response(
          JSON.stringify({ values: (opts.statsColA ?? []).map((v) => [v]) }),
          { status: 200 }
        );
      }
      if (u.includes("레이드 결과!A1:Z500")) {
        return new Response(JSON.stringify({ values: opts.resultRows ?? [] }), {
          status: 200,
        });
      }
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, inserts, puts };
}

describe("insertStatsRowsOrdered", () => {
  it("interior gap — 37차를 38차 블록 앞에 삽입", async () => {
    // ColA: header + 35×1, 36×1, 38×2 (37 누락). 38 첫 행 = grid index 3 (0-based)
    const statsColA = ["회차", "35차", "36차", "38차", "38차"];
    const { fetchImpl, inserts, puts } = makeFetch({ statsColA });
    await insertStatsRowsOrdered("s", "37", [["37차", "A"], ["37차", "B"]], "tok", fetchImpl);
    // 38차 첫 행(index 3) 앞에 2행 삽입
    expect(inserts).toEqual([{ dimension: "ROWS", startIndex: 3, endIndex: 5 }]);
    // 값은 A4:P5 (1-based = index+1)
    expect(puts[0].range).toBe("레이드 통계!A4:P5");
    expect(puts[0].values).toHaveLength(2);
  });

  it("최신 회차 — 더 큰 회차 없으면 맨 끝 append", async () => {
    const statsColA = ["회차", "38차", "39차"];
    const { fetchImpl, inserts, puts } = makeFetch({ statsColA });
    await insertStatsRowsOrdered("s", "40", [["40차", "A"]], "tok", fetchImpl);
    // 마지막 데이터 행(index 2) +1 = index 3 에 삽입
    expect(inserts[0].startIndex).toBe(3);
    expect(puts[0].range).toBe("레이드 통계!A4:P4");
  });

  it("빈 시트 — 'OO차 레이드 통계' placeholder 행 아래(row 3)에 삽입", async () => {
    // 헤더(row1) + "OO차 레이드 통계" placeholder(row2). 회차 라벨 행 없음.
    const statsColA = ["회차", "OO차 레이드 통계"];
    const { fetchImpl, inserts, puts } = makeFetch({ statsColA });
    await insertStatsRowsOrdered("s", "40", [["40차", "A"]], "tok", fetchImpl);
    // placeholder(index 1) 아래 = index 2 (row 3)에 삽입 — placeholder 보존
    expect(inserts[0].startIndex).toBe(2);
    expect(puts[0].range).toBe("레이드 통계!A3:P3");
  });
});

describe("insertResultRowOrdered", () => {
  it("interior gap — 36차를 37차 행 앞에 삽입", async () => {
    // 회차 컬럼 = ColA(idx0). header + 35,37,38 (36 누락)
    const resultRows = [["회차", "순위"], ["35차"], ["37차"], ["38차"]];
    const { fetchImpl, inserts, puts } = makeFetch({ resultRows });
    const r = await insertResultRowOrdered("s", "36", "tok", fetchImpl);
    expect(r.inserted).toBe(true);
    // 37차(index 2) 앞에 1행 삽입
    expect(inserts).toEqual([{ dimension: "ROWS", startIndex: 2, endIndex: 3 }]);
    expect(puts[0].range).toBe("레이드 결과!A3");
    expect(puts[0].values).toEqual([["36차"]]);
  });

  it("이미 존재하면 idempotent no-op", async () => {
    const resultRows = [["회차"], ["35차"], ["36차"], ["37차"]];
    const { fetchImpl, inserts, puts } = makeFetch({ resultRows });
    const r = await insertResultRowOrdered("s", "36", "tok", fetchImpl);
    expect(r.inserted).toBe(false);
    expect(inserts).toHaveLength(0);
    expect(puts).toHaveLength(0);
  });

  it("회차 컬럼이 ColB 인 경우도 정확히 삽입", async () => {
    // 회차 = idx1 (B열). header + 40차 1행
    const resultRows = [["순위", "회차"], ["1", "40차"]];
    const { fetchImpl, inserts, puts } = makeFetch({ resultRows });
    await insertResultRowOrdered("s", "39", "tok", fetchImpl);
    // 40차(index 1) 앞에 삽입
    expect(inserts[0].startIndex).toBe(1);
    expect(puts[0].range).toBe("레이드 결과!B2");
    expect(puts[0].values).toEqual([["39차"]]);
  });
});
