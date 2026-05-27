import { describe, expect, it, vi } from "vitest";
import {
  columnNumberToLetter,
  ensureRaidColumn,
  findRaidColumn,
} from "./find-column";

function mockRow(values: string[]): Response {
  return new Response(
    JSON.stringify({ range: "유니온 멤버!D1:Z1", values: [values] }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function okPut(): Response {
  return new Response(JSON.stringify({}), { status: 200 });
}

// 시트 grid info 응답 — '유니온 멤버' 탭 sheetId=1 + columnCount 지정
function gridInfoResponse(columnCount: number): Response {
  return new Response(
    JSON.stringify({
      sheets: [
        {
          properties: {
            sheetId: 1,
            title: "유니온 멤버",
            gridProperties: { rowCount: 33, columnCount },
          },
        },
      ],
    }),
    { status: 200 }
  );
}

function okBatchUpdate(): Response {
  return new Response(JSON.stringify({}), { status: 200 });
}

describe("columnNumberToLetter", () => {
  it("기본 매핑 A=1, D=4, H=8, Z=26", () => {
    expect(columnNumberToLetter(1)).toBe("A");
    expect(columnNumberToLetter(4)).toBe("D");
    expect(columnNumberToLetter(8)).toBe("H");
    expect(columnNumberToLetter(26)).toBe("Z");
  });
  it("AA=27, AZ=52", () => {
    expect(columnNumberToLetter(27)).toBe("AA");
    expect(columnNumberToLetter(52)).toBe("AZ");
  });
});

describe("findRaidColumn (Col B hidden 삽입 후 D 기준)", () => {
  it("5차 → H (D=4, idx=4 → colNum=8)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockRow(["1차", "2차", "3차", "4차", "5차", "6차"]));
    const col = await findRaidColumn(
      "sid",
      "5",
      "tok",
      fetchMock as unknown as typeof fetch
    );
    expect(col).toBe("H");
  });

  it("OO차 placeholder fallback → 매칭 위치 column", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockRow(["1차", "2차", "OO차"]));
    const col = await findRaidColumn(
      "sid",
      "10",
      "tok",
      fetchMock as unknown as typeof fetch
    );
    expect(col).toBe("F");
  });

  it("정확 일치 우선 — '5차' 있고 OO차 있으면 5차 채택", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockRow(["1차", "OO차", "3차", "4차", "5차"]));
    const col = await findRaidColumn(
      "sid",
      "5",
      "tok",
      fetchMock as unknown as typeof fetch
    );
    expect(col).toBe("H");
  });

  it("회차 컬럼 없음 → null", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(mockRow(["1차", "2차"]));
    const col = await findRaidColumn(
      "sid",
      "99",
      "tok",
      fetchMock as unknown as typeof fetch
    );
    expect(col).toBeNull();
  });
});

describe("ensureRaidColumn (SHEET_SCHEMA §2.2 3단계 분기)", () => {
  it("1) 정확 일치 → isNew=false, isPlaceholder=false, PUT 호출 없음", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockRow(["35차", "36차", "37차"]));
    const r = await ensureRaidColumn(
      "sid",
      "36",
      "tok",
      fetchMock as unknown as typeof fetch
    );
    expect(r.column).toBe("E"); // D + idx 1
    expect(r.isNew).toBe(false);
    expect(r.isPlaceholder).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("2) OO차 placeholder → isPlaceholder=true (grid 확장 불필요 path)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockRow(["35차", "OO차"]))
      .mockResolvedValueOnce(gridInfoResponse(10)) // 이미 충분
      .mockResolvedValueOnce(okPut());
    const r = await ensureRaidColumn(
      "sid",
      "36",
      "tok",
      fetchMock as unknown as typeof fetch
    );
    expect(r.column).toBe("E"); // D + idx 1
    expect(r.isNew).toBe(false);
    expect(r.isPlaceholder).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][1]?.method).toBe("PUT");
  });

  it("3) 둘 다 부재 → grid 확장 + 마지막 +1 신규 헤더", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockRow(["35차", "36차", "37차", "38차", "39차"]))
      .mockResolvedValueOnce(gridInfoResponse(7)) // 부족 → expand 필요
      .mockResolvedValueOnce(okBatchUpdate()) // appendDimension
      .mockResolvedValueOnce(okPut());
    const r = await ensureRaidColumn(
      "sid",
      "40",
      "tok",
      fetchMock as unknown as typeof fetch
    );
    expect(r.column).toBe("I"); // D + idx 5 → D(4)+5 = 9 → I
    expect(r.isNew).toBe(true);
    expect(r.isPlaceholder).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const putCall = fetchMock.mock.calls[3];
    expect(putCall[1]?.method).toBe("PUT");
    const body = JSON.parse(putCall[1].body as string);
    expect(body.values).toEqual([["40차"]]);
    // appendDimension 검증
    const buCall = fetchMock.mock.calls[2];
    const buBody = JSON.parse(buCall[1].body as string);
    expect(buBody.requests[0].appendDimension.dimension).toBe("COLUMNS");
    expect(buBody.requests[0].appendDimension.length).toBe(2); // 9 - 7 = 2
  });

  it("3) pre-migration layout — Col C 기준, 빈 헤더 → 첫 컬럼", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockRow([])) // 빈 헤더
      .mockResolvedValueOnce(gridInfoResponse(3)) // 충분
      .mockResolvedValueOnce(okPut());
    const r = await ensureRaidColumn(
      "sid",
      "40",
      "tok",
      fetchMock as unknown as typeof fetch,
      "pre-migration"
    );
    expect(r.column).toBe("C"); // C(3) + 0 = C
    expect(r.isNew).toBe(true);
  });

  it("3) pre-migration 35-39차 + 신규 40차 → H 컬럼 (grid 7 → 8 확장)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockRow(["35차", "36차", "37차", "38차", "39차"]))
      .mockResolvedValueOnce(gridInfoResponse(7)) // 7컬럼 → H(8) 필요 → +1 expand
      .mockResolvedValueOnce(okBatchUpdate())
      .mockResolvedValueOnce(okPut());
    const r = await ensureRaidColumn(
      "sid",
      "40",
      "tok",
      fetchMock as unknown as typeof fetch,
      "pre-migration"
    );
    expect(r.column).toBe("H"); // C(3) + 5 = 8 → H
    expect(r.isNew).toBe(true);
    const buBody = JSON.parse(fetchMock.mock.calls[2][1].body as string);
    expect(buBody.requests[0].appendDimension.length).toBe(1); // 8 - 7 = 1
  });
});
