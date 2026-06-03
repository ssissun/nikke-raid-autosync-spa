import { describe, it, expect, vi } from "vitest";
import {
  extractNicknames,
  preWriteCheck,
  writeAutofill,
} from "./autofill";
import type { GuildMember, NikkeRaidPayload } from "../types";

function members(nicks: string[]): GuildMember[] {
  return nicks.map((nickname, i) => ({
    member_id: String(1000000000000000 + i),
    nickname,
    synchro_level: 1,
    commander_level: 1,
    icon_id: "0",
  }));
}

function multiPayload(nicks: string[]): NikkeRaidPayload {
  return {
    type: "nikke-raid-multi",
    capturedAt: "2026-06-03T00:00:00+09:00",
    availableRaidNums: [],
    rounds: [],
    members: members(nicks),
    meta: { guildId: "g", areaId: "a" },
  };
}

function dataPayload(nicks: string[]): NikkeRaidPayload {
  return {
    type: "nikke-raid-data",
    capturedAt: "2026-06-03T00:00:00+09:00",
    raid: [],
    members: members(nicks),
    meta: { guildId: "g", areaId: "a" },
  };
}

// fetch mock — GET(preWriteCheck) 와 PUT(write) 을 method 로 구분.
function makeFetch(opts: {
  getValues?: string[][];
  getOk?: boolean;
  putOk?: boolean;
}): { fn: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (init?.method === "PUT") {
      return {
        ok: opts.putOk ?? true,
        status: (opts.putOk ?? true) ? 200 : 500,
        text: async () => "err-body",
      } as Response;
    }
    return {
      ok: opts.getOk ?? true,
      status: (opts.getOk ?? true) ? 200 : 500,
      json: async () => ({ values: opts.getValues }),
    } as Response;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

describe("extractNicknames", () => {
  it("TS-1.1: multi payload 닉네임 전원 추출 (캡처 순서 유지)", () => {
    const nicks = Array.from({ length: 32 }, (_, i) => `닉${i}`);
    expect(extractNicknames(multiPayload(nicks))).toEqual(nicks);
  });

  it("TS-1.3: data 레거시 payload 추출", () => {
    expect(extractNicknames(dataPayload(["A", "B", "C"]))).toEqual(["A", "B", "C"]);
  });

  it("BR-2: 빈/공백 닉네임은 제외(닉네임으로 안 셈)", () => {
    expect(extractNicknames(multiPayload(["닉A", "   ", "", "닉B"]))).toEqual(["닉A", "닉B"]);
  });

  it("TS-1.4: 미지원 type / null → 빈 배열", () => {
    expect(extractNicknames(null)).toEqual([]);
    expect(extractNicknames({ type: "need-login", capturedAt: "t" })).toEqual([]);
  });
});

describe("preWriteCheck (BR-1)", () => {
  it("빈 시트(values 없음) → true", async () => {
    const { fn } = makeFetch({ getValues: undefined });
    expect(await preWriteCheck("sid", "tok", fn)).toBe(true);
  });

  it("TS-5: whitespace-only 행 → true (비었다고 판정)", async () => {
    const { fn } = makeFetch({ getValues: [[" "], [""], ["  "]] });
    expect(await preWriteCheck("sid", "tok", fn)).toBe(true);
  });

  it("데이터 있는 시트 → false", async () => {
    const { fn } = makeFetch({ getValues: [["닉A"], ["닉B"]] });
    expect(await preWriteCheck("sid", "tok", fn)).toBe(false);
  });

  it("read 실패 → throw", async () => {
    const { fn } = makeFetch({ getOk: false });
    await expect(preWriteCheck("sid", "tok", fn)).rejects.toThrow(/PREWRITE_READ_FAILED/);
  });
});

describe("writeAutofill (BR-1 + BR-6)", () => {
  it("TS-3.1: 정상 — 빈 시트 RAW 쓰기 + range B2:B{1+N}", async () => {
    const { fn, calls } = makeFetch({ getValues: undefined });
    const result = await writeAutofill(["A", "B", "C"], "sid", "tok", fn);
    expect(result).toEqual({ ok: true, written: 3 });
    const put = calls.find((c) => c.init?.method === "PUT");
    expect(put).toBeDefined();
    expect(put!.url).toContain("valueInputOption=RAW");
    expect(decodeURIComponent(put!.url)).toContain("유니온 멤버!B2:B4");
    expect(JSON.parse(String(put!.init!.body))).toEqual({
      values: [["A"], ["B"], ["C"]],
    });
  });

  it("TS-3.2: BR-1 — race(시트 not empty) → 쓰기 차단, PUT 미호출", async () => {
    const { fn, calls } = makeFetch({ getValues: [["기존닉"]] });
    const result = await writeAutofill(["A", "B"], "sid", "tok", fn);
    expect(result).toEqual({ ok: false, reason: "not_empty" });
    expect(calls.some((c) => c.init?.method === "PUT")).toBe(false);
  });

  it("TS-3.3: BR-6 — 수식/특수문자 닉네임 RAW 리터럴 보존", async () => {
    const { fn, calls } = makeFetch({ getValues: undefined });
    await writeAutofill(["=1+1", "@everyone", "+SUM(A1)", "-1"], "sid", "tok", fn);
    const put = calls.find((c) => c.init?.method === "PUT")!;
    expect(put.url).toContain("valueInputOption=RAW");
    expect(JSON.parse(String(put.init!.body))).toEqual({
      values: [["=1+1"], ["@everyone"], ["+SUM(A1)"], ["-1"]],
    });
  });

  it("TS-3.4: BR-4 — N명(30) range B2:B31", async () => {
    const { fn, calls } = makeFetch({ getValues: undefined });
    const nicks = Array.from({ length: 30 }, (_, i) => `닉${i}`);
    await writeAutofill(nicks, "sid", "tok", fn);
    const put = calls.find((c) => c.init?.method === "PUT")!;
    expect(decodeURIComponent(put.url)).toContain("유니온 멤버!B2:B31");
  });

  it("BR-3 구조적 안전: 매핑 탭(_nra_member_mapping)을 절대 건드리지 않음", async () => {
    const { fn, calls } = makeFetch({ getValues: undefined });
    await writeAutofill(["A", "B"], "sid", "tok", fn);
    expect(calls.every((c) => !decodeURIComponent(c.url).includes("_nra_member_mapping"))).toBe(true);
    expect(calls.every((c) => decodeURIComponent(c.url).includes("유니온 멤버"))).toBe(true);
  });

  it("쓰기 0건 → throw (NO_MEMBERS)", async () => {
    const { fn } = makeFetch({ getValues: undefined });
    await expect(writeAutofill([], "sid", "tok", fn)).rejects.toThrow(/NO_MEMBERS/);
  });

  it("write HTTP 실패 → throw", async () => {
    const { fn } = makeFetch({ getValues: undefined, putOk: false });
    await expect(writeAutofill(["A"], "sid", "tok", fn)).rejects.toThrow(/WRITE_FAILED/);
  });
});
