import { describe, it, expect, vi } from "vitest";
import { applyMemberSync } from "./auto-sync";
import type { GuildMember } from "../types";

function gm(member_id: string, nickname: string): GuildMember {
  return { member_id, nickname, synchro_level: 300, commander_level: 200, icon_id: "1" };
}

// 유니온 멤버 read(A1:AZ33) → unionRows, write(PUT) 캡처하는 mock.
function makeFetch(unionRows: string[][]) {
  let written: string[][] | null = null;
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const u = decodeURIComponent(String(url));
    const method = init?.method ?? "GET";
    if (u.includes("유니온 멤버!A1:AZ33") && method === "GET") {
      return new Response(JSON.stringify({ values: unionRows }), { status: 200 });
    }
    if (u.includes("유니온 멤버!A1:") && method === "PUT") {
      written = JSON.parse(String(init!.body)).values;
      return new Response(JSON.stringify({}), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, getWritten: () => written };
}

const HEADER = ["가입 순서", "닉네임", "35차"];

describe("applyMemberSync (원본 레이아웃 + member_id 병렬 shift)", () => {
  it("leaving 1건 — 아래 행이 위로 shift, member_id 동행", async () => {
    const rows = [HEADER, ["1", "A", "500"], ["2", "B", "510"], ["3", "C", "520"]];
    const { fetchImpl, getWritten } = makeFetch(rows);
    const r = await applyMemberSync(
      "s", "t",
      [{ nickname: "B", sheetRow: 3 }], [],
      { fetchImpl, initialMemberIdByRow: new Map([[2, "ida"], [3, "idb"], [4, "idc"]]) }
    );
    // B(idb) 제거, C 가 row3 으로 올라옴
    expect(r.finalMemberIdByRow.get(2)).toBe("ida");
    expect(r.finalMemberIdByRow.get(3)).toBe("idc");
    expect(r.finalMemberIdByRow.has(4)).toBe(false);
    const w = getWritten()!;
    expect(w[1][1]).toBe("A"); // row2 닉네임 (Col B)
    expect(w[2][1]).toBe("C"); // row3 닉네임 (shift)
    expect(w[1][0]).toBe("1"); // Col A normalize
    expect(w[2][0]).toBe("2");
  });

  it("member_id 가 닉네임과 같은 행에 정렬 유지 (데이터 무결성 핵심)", async () => {
    const rows = [HEADER, ["1", "A", "500"], ["2", "B", "510"], ["3", "C", "520"]];
    const { fetchImpl, getWritten } = makeFetch(rows);
    const r = await applyMemberSync(
      "s", "t",
      [{ nickname: "B", sheetRow: 3 }], [],
      { fetchImpl, initialMemberIdByRow: new Map([[2, "ida"], [3, "idb"], [4, "idc"]]) }
    );
    const w = getWritten()!;
    // row3 = 닉네임 C ↔ member_id idc (둘 다 한 칸 위로 동행)
    expect(w[2][1]).toBe("C");
    expect(r.finalMemberIdByRow.get(3)).toBe("idc");
  });

  it("leaving + joining — 빈 슬롯에 신규 채움 + member_id 기록", async () => {
    const rows = [HEADER, ["1", "A", "500"], ["2", "B", "510"], ["3", "C", "520"]];
    const { fetchImpl } = makeFetch(rows);
    const r = await applyMemberSync(
      "s", "t",
      [{ nickname: "B", sheetRow: 3 }], [gm("idd", "D")],
      { fetchImpl, initialMemberIdByRow: new Map([[2, "ida"], [3, "idb"], [4, "idc"]]) }
    );
    expect(r.finalMemberIdByRow.get(2)).toBe("ida");
    expect(r.finalMemberIdByRow.get(3)).toBe("idc");
    expect(r.finalMemberIdByRow.get(4)).toBe("idd"); // 신규 D → 빈 슬롯(row4)
    expect(r.addedRows[0]).toEqual({ sheetRow: 4, nickname: "D", member_id: "idd" });
  });

  it("leaving 2건 — 큰 idx 우선 처리로 정확히 제거", async () => {
    const rows = [
      HEADER, ["1", "A", "5"], ["2", "B", "5"], ["3", "C", "5"], ["4", "D", "5"],
    ];
    const { fetchImpl } = makeFetch(rows);
    const r = await applyMemberSync(
      "s", "t",
      [{ nickname: "A", sheetRow: 2 }, { nickname: "C", sheetRow: 4 }], [],
      {
        fetchImpl,
        initialMemberIdByRow: new Map([[2, "ida"], [3, "idb"], [4, "idc"], [5, "idd"]]),
      }
    );
    // A, C 제거 → B, D 잔류 (row2, row3)
    expect(r.finalMemberIdByRow.get(2)).toBe("idb");
    expect(r.finalMemberIdByRow.get(3)).toBe("idd");
    expect([...r.finalMemberIdByRow.values()]).not.toContain("ida");
    expect([...r.finalMemberIdByRow.values()]).not.toContain("idc");
  });

  it("joining 정원(32) 초과 → throw", async () => {
    const full = [HEADER];
    for (let i = 1; i <= 32; i++) full.push([String(i), `N${i}`, "5"]);
    const { fetchImpl } = makeFetch(full);
    await expect(
      applyMemberSync("s", "t", [], [gm("idx", "X")], { fetchImpl })
    ).rejects.toThrow(/AUTO_SYNC_LIMIT_EXCEEDED/);
  });
});
