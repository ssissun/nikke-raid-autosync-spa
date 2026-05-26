import { describe, expect, it, vi } from "vitest";
import { columnNumberToLetter, findRaidColumn } from "./find-column";

function mockRow(values: string[]): Response {
  return new Response(
    JSON.stringify({ range: "유니온 멤버!D1:Z1", values: [values] }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
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
    // OO차 idx=2 → D + 2 = F
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
    expect(col).toBe("H"); // idx 4 → D+4=H
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
