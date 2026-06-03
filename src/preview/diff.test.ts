import { describe, it, expect } from "vitest";
import { MARKER, renderDiffMember, renderNicknameChange } from "./diff";

describe("renderDiffMember", () => {
  it("TS-1: 탈퇴 멤버 행번호 병기 + del 마커", () => {
    const html = renderDiffMember({ nickname: "탈퇴자1", sheetRow: 32 }, "del");
    expect(html).toContain("diff-del");
    expect(html).toContain(MARKER.del);
    expect(html).toContain("(행 32)");
    expect(html).toContain("탈퇴자1");
  });

  it("TS-2: 중복 닉네임도 행번호로 구분 (EC-1)", () => {
    const a = renderDiffMember({ nickname: "탈퇴자1", sheetRow: 32 }, "del");
    const b = renderDiffMember({ nickname: "탈퇴자1", sheetRow: 33 }, "del");
    expect(a).toContain("(행 32)");
    expect(b).toContain("(행 33)");
    expect(a).not.toEqual(b);
  });

  it("TS-3: 신규 멤버(sheetRow 없음)는 add 마커만, 행번호 생략 (EC-2)", () => {
    const html = renderDiffMember({ nickname: "신규닉" }, "add");
    expect(html).toContain("diff-add");
    expect(html).toContain(MARKER.add);
    expect(html).toContain("신규닉");
    expect(html).not.toContain("(행 ");
  });

  it("TS-5: XSS — escapeHtml 유지 (EC-4)", () => {
    const html = renderDiffMember({ nickname: "<b>x</b>", sheetRow: 5 }, "del");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
  });

  it("EC-5: sheetRow 0 도 표시 (undefined 만 생략)", () => {
    const html = renderDiffMember({ nickname: "A", sheetRow: 0 }, "del");
    expect(html).toContain("(행 0)");
  });

  it("마커 3종이 서로 다른 클래스/기호로 구분 (AC-2)", () => {
    const add = renderDiffMember({ nickname: "A", sheetRow: 1 }, "add");
    const del = renderDiffMember({ nickname: "A", sheetRow: 1 }, "del");
    expect(add).toContain("diff-add");
    expect(del).toContain("diff-del");
    expect(add).not.toEqual(del);
    expect(new Set([MARKER.add, MARKER.del, MARKER.mod]).size).toBe(3);
  });
});

describe("renderNicknameChange", () => {
  it("TS-6: 변경 마커 ~ + old (행 N) → new", () => {
    const html = renderNicknameChange({ old: "구닉", new: "새닉", sheetRow: 5 });
    expect(html).toContain("diff-mod");
    expect(html).toContain(MARKER.mod);
    expect(html).toContain("구닉");
    expect(html).toContain("(행 5)");
    expect(html).toContain("→");
    expect(html).toContain("새닉");
  });

  it("변경 sheetRow 없으면 행번호 생략", () => {
    const html = renderNicknameChange({ old: "구닉", new: "새닉" });
    expect(html).not.toContain("(행 ");
    expect(html).toContain("구닉");
    expect(html).toContain("새닉");
  });

  it("변경 XSS — old/new 모두 이스케이프", () => {
    const html = renderNicknameChange({ old: "<a>", new: "<b>", sheetRow: 2 });
    expect(html).toContain("&lt;a&gt;");
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<a>");
  });
});
