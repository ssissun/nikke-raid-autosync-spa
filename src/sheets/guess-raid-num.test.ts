import { describe, expect, it, vi } from "vitest";
import {
  extractMaxRaidNum,
  guessFromMemberHeader,
  guessFromRaidStats,
  guessNextRaidNum,
} from "./guess-raid-num";

function memberHeaderResponse(values: string[]): Response {
  return new Response(
    JSON.stringify({
      range: "유니온 멤버!A1:Z1",
      values: [values],
    }),
    { status: 200 }
  );
}

function statsColAResponse(rows: string[]): Response {
  return new Response(
    JSON.stringify({
      range: "레이드 통계!A1:A2000",
      values: rows.map((r) => [r]),
    }),
    { status: 200 }
  );
}

describe("extractMaxRaidNum", () => {
  it("35-39차 + 다른 값들 혼합 → 39", () => {
    expect(
      extractMaxRaidNum(["가입 순서", "닉네임", "35차", "36차", "39차", "37차"])
    ).toBe(39);
  });

  it('"OO차" 같은 placeholder 무시', () => {
    expect(extractMaxRaidNum(["OO차", "5차", "OO차"])).toBe(5);
  });

  it("회차 패턴 없음 → null", () => {
    expect(extractMaxRaidNum(["가입 순서", "닉네임"])).toBeNull();
  });

  it("빈 array → null", () => {
    expect(extractMaxRaidNum([])).toBeNull();
  });
});

describe("guessFromMemberHeader", () => {
  it("헤더에서 max N차 추출", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        memberHeaderResponse([
          "가입 순서",
          "닉네임",
          "35차",
          "36차",
          "37차",
          "38차",
          "39차",
        ])
      );
    const n = await guessFromMemberHeader(
      "sid",
      "tok",
      fetchMock as unknown as typeof fetch
    );
    expect(n).toBe(39);
  });

  it("회차 헤더 없음 → null", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(memberHeaderResponse(["가입 순서", "닉네임"]));
    const n = await guessFromMemberHeader(
      "sid",
      "tok",
      fetchMock as unknown as typeof fetch
    );
    expect(n).toBeNull();
  });
});

describe("guessFromRaidStats", () => {
  it("Col A에서 max N차 추출", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        statsColAResponse([
          "회차",
          "OO차 레이드 통계",
          "35차",
          "",
          "",
          "36차",
          "37차",
          "39차",
          "38차",
        ])
      );
    const n = await guessFromRaidStats(
      "sid",
      "tok",
      fetchMock as unknown as typeof fetch
    );
    expect(n).toBe(39);
  });
});

describe("guessNextRaidNum", () => {
  it("두 곳 모두 있을 때 max + 1 반환", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(memberHeaderResponse(["가입 순서", "닉네임", "39차"]))
      .mockResolvedValueOnce(statsColAResponse(["회차", "35차", "37차"]));
    const next = await guessNextRaidNum(
      "sid",
      "tok",
      fetchMock as unknown as typeof fetch
    );
    expect(next).toBe("40");
  });

  it("헤더만 있고 stats 부재 → 헤더 max + 1", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(memberHeaderResponse(["가입 순서", "닉네임", "12차"]))
      .mockResolvedValueOnce(statsColAResponse(["회차"]));
    const next = await guessNextRaidNum(
      "sid",
      "tok",
      fetchMock as unknown as typeof fetch
    );
    expect(next).toBe("13");
  });

  it("둘 다 부재 → null", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(memberHeaderResponse(["가입 순서", "닉네임"]))
      .mockResolvedValueOnce(statsColAResponse(["회차"]));
    const next = await guessNextRaidNum(
      "sid",
      "tok",
      fetchMock as unknown as typeof fetch
    );
    expect(next).toBeNull();
  });
});
