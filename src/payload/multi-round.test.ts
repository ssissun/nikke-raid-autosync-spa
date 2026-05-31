import { describe, it, expect, vi } from "vitest";
import { normalizePayload } from "./normalize";
import { selectMissingRounds } from "./round-planner";
import { prepareRoundBatchUpdate } from "../dryrun/calculator";
import { applyMultiRoundWrite } from "../sheets/multi-round";
import { computeFingerprint } from "../sheets/fingerprint";
import type {
  GuildMember,
  NikkeRaidPayload,
  ProcessedRaidRow,
} from "../types";
import type { SyncClassification } from "../matching/types";

const member = (id: string, nick: string, sync: number): GuildMember => ({
  member_id: id,
  nickname: nick,
  synchro_level: sync,
  commander_level: 700,
  icon_id: "x",
});

const row = (label: string, nick: string, boss: string): ProcessedRaidRow => [
  label, nick, boss, 5, "a", 0, "b", 0, "c", 0, "d", 0, "e", 0, "100", "O",
];

describe("normalizePayload", () => {
  it("multi 는 정렬하여 통과시킨다", () => {
    const p: NikkeRaidPayload = {
      type: "nikke-raid-multi",
      capturedAt: "t",
      availableRaidNums: ["40", "38", "39"],
      rounds: [
        { raidNum: "40", raid: [row("40차", "A", "boss")], memberSyncroLevels: { m1: 537 } },
        { raidNum: "38", raid: [row("38차", "A", "boss")], memberSyncroLevels: { m1: 520 } },
      ],
      members: [member("m1", "A", 540)],
      meta: { guildId: "g", areaId: "83" },
    };
    const n = normalizePayload(p);
    expect(n).not.toBeNull();
    expect(n!.availableRaidNums).toEqual(["38", "39", "40"]);
    expect(n!.rounds.map((r) => r.raidNum)).toEqual(["38", "40"]);
  });

  it("legacy single → 1-round multi 승격 (현재 synchro 사용)", () => {
    const p: NikkeRaidPayload = {
      type: "nikke-raid-data",
      raidNum: "40",
      capturedAt: "t",
      raid: [row("40차", "A", "boss"), row("40차", "B", "boss")],
      members: [member("m1", "A", 540), member("m2", "B", 0)],
      meta: { guildId: "g", areaId: "83" },
    };
    const n = normalizePayload(p)!;
    expect(n.rounds).toHaveLength(1);
    expect(n.rounds[0].raidNum).toBe("40");
    expect(n.rounds[0].raid).toHaveLength(2);
    // synchro 0 은 제외
    expect(n.rounds[0].memberSyncroLevels).toEqual({ m1: 540 });
  });

  it("single raidNum 부재 시 index0 라벨로 group-by", () => {
    const p: NikkeRaidPayload = {
      type: "nikke-raid-data",
      raidNum: null,
      capturedAt: "t",
      raid: [row("38차", "A", "boss"), row("39차", "A", "boss"), row("39차", "B", "boss")],
      members: [member("m1", "A", 540)],
      meta: { guildId: "g", areaId: "83" },
    };
    const n = normalizePayload(p)!;
    expect(n.rounds.map((r) => r.raidNum)).toEqual(["38", "39"]);
    expect(n.rounds[1].raid).toHaveLength(2);
  });

  it("비-raid payload 는 null", () => {
    expect(normalizePayload({ type: "need-login", capturedAt: "t" })).toBeNull();
  });
});

describe("selectMissingRounds", () => {
  const base = {
    capturedAt: "t",
    members: [member("m1", "A", 540)],
    meta: { guildId: "g", areaId: "83" },
  };
  it("시트에 없는 회차만 target (오름차순)", () => {
    const n = {
      ...base,
      availableRaidNums: ["38", "39", "40"],
      rounds: [
        { raidNum: "40", raid: [], memberSyncroLevels: {} },
        { raidNum: "39", raid: [], memberSyncroLevels: {} },
        { raidNum: "38", raid: [], memberSyncroLevels: {} },
      ],
    };
    const sel = selectMissingRounds(n, new Set(["38"]));
    expect(sel.targetRounds.map((r) => r.raidNum)).toEqual(["39", "40"]);
    expect(sel.alreadyInSheet).toEqual(["38"]);
  });
  it("가용하나 데이터 없는 회차는 unavailableButRequested", () => {
    const n = {
      ...base,
      availableRaidNums: ["38", "39", "40"],
      rounds: [{ raidNum: "40", raid: [], memberSyncroLevels: {} }],
    };
    const sel = selectMissingRounds(n, new Set());
    expect(sel.targetRounds.map((r) => r.raidNum)).toEqual(["40"]);
    expect(sel.unavailableButRequested.sort()).toEqual(["38", "39"]);
  });
  it("전부 시트에 있으면 target 0", () => {
    const n = {
      ...base,
      availableRaidNums: ["40"],
      rounds: [{ raidNum: "40", raid: [], memberSyncroLevels: {} }],
    };
    const sel = selectMissingRounds(n, new Set(["40"]));
    expect(sel.targetRounds).toHaveLength(0);
    expect(sel.alreadyInSheet).toEqual(["40"]);
  });
});

describe("prepareRoundBatchUpdate — 회차 당시 레벨 우선", () => {
  const classification: SyncClassification = {
    staying: [
      { member_id: "m1", sheetRow: 2, nickname: "A", payloadNickname: "A" },
      { member_id: "m2", sheetRow: 3, nickname: "B", payloadNickname: "B" },
    ],
    leaving: [],
    joining: [],
  };
  const members = [member("m1", "A", 540), member("m2", "B", 600)];

  it("roundSyncroLevels 가 현재 synchro 보다 우선", () => {
    const plan = prepareRoundBatchUpdate({
      classification,
      alerts: [],
      raidNum: "40",
      raidRows: [row("40차", "A", "boss")],
      roundSyncroLevels: { m1: 515 }, // m1 은 회차 당시 515, m2 는 미제공
      members,
      lastRaidRow: 100,
      syncroColumn: "H",
    });
    const byRow = new Map(plan.memberSyncroUpdates.map((u) => [u.sheetRow, u.syncroLevel]));
    expect(byRow.get(2)).toBe(515); // 회차 당시
    expect(byRow.get(3)).toBe(600); // fallback 현재
    expect(plan.raidStatsRange).toBe("레이드 통계!A101:P101");
    expect(plan.raidNum).toBe("40");
  });

  it("lastRaidRow 누적 offset 반영", () => {
    const plan = prepareRoundBatchUpdate({
      classification,
      alerts: [],
      raidNum: "41",
      raidRows: [row("41차", "A", "b"), row("41차", "B", "b")],
      roundSyncroLevels: {},
      members,
      lastRaidRow: 200,
      syncroColumn: "I",
    });
    expect(plan.raidStatsRange).toBe("레이드 통계!A201:P202");
  });
});

describe("applyMultiRoundWrite", () => {
  it("fingerprint 1회 + backup 1회 + executeBatchUpdate N회 (mock)", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("values:batchGet")) {
        // fingerprint computeFingerprint — 두 헤더 행
        calls.push("fingerprint-read");
        return new Response(
          JSON.stringify({
            spreadsheetId: "s",
            valueRanges: [
              { range: "유니온 멤버!A1:Z1", values: [["가입 순서", "닉네임", "OO차"]] },
              { range: "레이드 통계!A1:P1", values: [["회차"]] },
            ],
          }),
          { status: 200 }
        );
      }
      if (u.endsWith(":batchUpdate") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        if (body.requests) {
          calls.push("addSheet-backup");
          return new Response(JSON.stringify({ replies: [{ addSheet: { properties: { title: "_backup_40", sheetId: 9 } } }] }), { status: 200 });
        }
      }
      if (u.includes("values:batchGet?ranges")) {
        calls.push("backup-read");
        return new Response(JSON.stringify({ valueRanges: [] }), { status: 200 });
      }
      if (u.includes("/values/") || u.includes("values:batchUpdate")) {
        calls.push("values");
        return new Response(JSON.stringify({}), { status: 200 });
      }
      // grid info etc
      calls.push("other:" + u.slice(0, 40));
      return new Response(JSON.stringify({ sheets: [{ properties: { sheetId: 1, title: "유니온 멤버", gridProperties: { rowCount: 1000, columnCount: 30 } } }, { properties: { sheetId: 2, title: "레이드 통계", gridProperties: { rowCount: 5000, columnCount: 16 } } }] }), { status: 200 });
    });

    const mkPlan = (raidNum: string, startRow: number) => ({
      raidNum,
      backupTabName: `_backup_${raidNum}`,
      raidStatsRange: `레이드 통계!A${startRow}:P${startRow}`,
      raidStatsRows: [["x"]],
      memberSyncroUpdates: [{ sheetRow: 2, syncroLevel: 500, column: "H" }],
      syncroColumn: "H",
      unmatchedNames: [],
      isConfirmable: true,
    });

    // mock 헤더로 실제 계산되는 해시를 allowed 로 전달 (배선 검증 목적, 특정 해시값 아님)
    const computed = await computeFingerprint("s", "tok", fetchImpl as unknown as typeof fetch);

    const result = await applyMultiRoundWrite({
      spreadsheetId: "s",
      accessToken: "tok",
      plans: [mkPlan("39", 101), mkPlan("40", 102)],
      backupRaidNum: "40",
      allowedFingerprints: [computed],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      eventTarget: new EventTarget(),
    });

    expect(result.writtenRaidNums).toEqual(["39", "40"]);
    expect(result.backupTabName).toBe("_backup_40");
    // backup addSheet 정확히 1회
    expect(calls.filter((c) => c === "addSheet-backup")).toHaveLength(1);
  });
});
