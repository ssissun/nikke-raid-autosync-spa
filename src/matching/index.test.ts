import { describe, it, expect, vi, afterEach } from "vitest";
import { startClassificationFlow, clearSyncClassification } from "./index";
import type { GuildMember } from "../types";

function gm(member_id: string, nickname: string): GuildMember {
  return { member_id, nickname, synchro_level: 300, commander_level: 200, icon_id: "1" };
}

// readColBMap(유니온 멤버 A1:C33) + readMemberIdTab(sheets list + 매핑 탭 A1:B33) 를 global fetch 로 stub.
function stubFetch(opts: { unionRows: string[][]; tabRows: string[][] | null }) {
  const fetchImpl = vi.fn(async (url: string) => {
    const u = decodeURIComponent(String(url));
    if (u.includes("fields=sheets(properties(sheetId,title))")) {
      const sheets: Array<{ properties: { sheetId: number; title: string } }> = [
        { properties: { sheetId: 1, title: "유니온 멤버" } },
      ];
      if (opts.tabRows !== null) {
        sheets.push({ properties: { sheetId: 9, title: "_nra_member_mapping" } });
      }
      return new Response(JSON.stringify({ sheets }), { status: 200 });
    }
    if (u.includes("유니온 멤버!A1:C33")) {
      return new Response(JSON.stringify({ values: opts.unionRows }), { status: 200 });
    }
    if (u.includes("_nra_member_mapping!A1:B33")) {
      return new Response(JSON.stringify({ values: opts.tabRows ?? [] }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchImpl);
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearSyncClassification();
});

const HEADER = ["가입 순서", "닉네임", "OO차"];

describe("startClassificationFlow — mode none 탈퇴/신규 surface", () => {
  it("매핑 탭 존재(mode none): classification 의 탈퇴/신규를 unmatched* 로 노출", async () => {
    // A 유지, 탈퇴자1(=신동탄 개명+가짜id, 탭 닉도 탈퇴자1 → 해석됨), 탈퇴자2(=유농, 탭 닉 '유농' 그대로 → 미해석)
    stubFetch({
      unionRows: [HEADER, ["1", "A", ""], ["2", "탈퇴자1", ""], ["3", "탈퇴자2", ""]],
      tabRows: [["닉네임", "member_id"], ["A", "ida"], ["탈퇴자1", "idfake1"], ["유농", "idfake2"]],
    });
    const payload = [gm("ida", "A"), gm("idreal1", "신동탄"), gm("idreal2", "유농")];
    const r = await startClassificationFlow("tok", "sheet", payload);

    expect(r.mode).toBe("none");
    // 탈퇴 2명: 탈퇴자1(해석된 leaving) + 탈퇴자2(미해석 행 → 닉네임도 payload 에 없음)
    const leavingNicks = r.unmatchedSheetNicknames.map((u) => u.nickname).sort();
    expect(leavingNicks).toEqual(["탈퇴자1", "탈퇴자2"]);
    // 신규 2명: 신동탄, 유농 (payload member_id 가 colBMap 에 없음)
    const joiningNicks = r.unmatchedPayloadMembers.map((m) => m.nickname).sort();
    expect(joiningNicks).toEqual(["신동탄", "유농"]);
    expect(r.isComplete).toBe(false);
  });

  it("정상 멤버(변동 없음): unmatched* 0건", async () => {
    stubFetch({
      unionRows: [HEADER, ["1", "A", ""], ["2", "B", ""]],
      tabRows: [["닉네임", "member_id"], ["A", "ida"], ["B", "idb"]],
    });
    const payload = [gm("ida", "A"), gm("idb", "B")];
    const r = await startClassificationFlow("tok", "sheet", payload);
    expect(r.mode).toBe("none");
    expect(r.unmatchedSheetNicknames).toHaveLength(0);
    expect(r.unmatchedPayloadMembers).toHaveLength(0);
    expect(r.classification.staying).toHaveLength(2);
  });

  it("탭 부재(첫 실행, backfill): 닉네임 매칭으로 탈퇴/신규", async () => {
    stubFetch({
      unionRows: [HEADER, ["1", "A", ""], ["2", "OLD", ""]],
      tabRows: null, // 매핑 탭 없음 → backfill
    });
    const payload = [gm("ida", "A"), gm("idnew", "NEW")];
    const r = await startClassificationFlow("tok", "sheet", payload);
    expect(r.mode).toBe("backfill");
    expect(r.unmatchedSheetNicknames.map((u) => u.nickname)).toEqual(["OLD"]);
    expect(r.unmatchedPayloadMembers.map((m) => m.nickname)).toEqual(["NEW"]);
  });
});
