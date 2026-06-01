import { describe, it, expect } from "vitest";
import { normalizePayload } from "./normalize";
import { selectMissingRounds } from "./round-planner";
import { prepareRoundBatchUpdate } from "../dryrun/calculator";
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
  it("두 탭 모두 없는 회차만 target (오름차순)", () => {
    const n = {
      ...base,
      availableRaidNums: ["38", "39", "40"],
      rounds: [
        { raidNum: "40", raid: [], memberSyncroLevels: {} },
        { raidNum: "39", raid: [], memberSyncroLevels: {} },
        { raidNum: "38", raid: [], memberSyncroLevels: {} },
      ],
    };
    // 38 은 두 탭 모두 존재 → skip
    const sel = selectMissingRounds(n, new Set(["38"]), new Set(["38"]));
    expect(sel.targetRounds.map((t) => t.round.raidNum)).toEqual(["39", "40"]);
    expect(sel.alreadyComplete).toEqual(["38"]);
  });
  it("한쪽 탭만 누락 — 해당 탭 플래그만 true", () => {
    const n = {
      ...base,
      availableRaidNums: ["40"],
      rounds: [{ raidNum: "40", raid: [], memberSyncroLevels: {} }],
    };
    // 레이드 통계엔 40 있음, 유니온 멤버엔 없음 → missingMember 만 true
    const sel = selectMissingRounds(n, new Set(["40"]), new Set());
    expect(sel.targetRounds).toHaveLength(1);
    expect(sel.targetRounds[0].missingStats).toBe(false);
    expect(sel.targetRounds[0].missingMember).toBe(true);
    expect(sel.alreadyComplete).toEqual([]);
  });
  it("가용하나 데이터 없는 회차는 unavailableButRequested", () => {
    const n = {
      ...base,
      availableRaidNums: ["38", "39", "40"],
      rounds: [{ raidNum: "40", raid: [], memberSyncroLevels: {} }],
    };
    const sel = selectMissingRounds(n, new Set(), new Set());
    expect(sel.targetRounds.map((t) => t.round.raidNum)).toEqual(["40"]);
    expect(sel.targetRounds[0].missingStats).toBe(true);
    expect(sel.targetRounds[0].missingMember).toBe(true);
    expect(sel.unavailableButRequested.sort()).toEqual(["38", "39"]);
  });
  it("두 탭 모두 있으면 target 0 (alreadyComplete)", () => {
    const n = {
      ...base,
      availableRaidNums: ["40"],
      rounds: [{ raidNum: "40", raid: [], memberSyncroLevels: {} }],
    };
    const sel = selectMissingRounds(n, new Set(["40"]), new Set(["40"]));
    expect(sel.targetRounds).toHaveLength(0);
    expect(sel.alreadyComplete).toEqual(["40"]);
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

  it("includeStats=false → 통계 행 0 (멱등, 멤버만 채움)", () => {
    const plan = prepareRoundBatchUpdate({
      classification,
      alerts: [],
      raidNum: "40",
      raidRows: [row("40차", "A", "boss")],
      roundSyncroLevels: {},
      members,
      lastRaidRow: 100,
      syncroColumn: "H",
      includeStats: false,
      includeMember: true,
    });
    expect(plan.raidStatsRows).toHaveLength(0);
    expect(plan.raidStatsRange).toBe("");
    expect(plan.memberSyncroUpdates.length).toBeGreaterThan(0);
  });

  it("includeMember=false → 멤버 0 (통계만 추가)", () => {
    const plan = prepareRoundBatchUpdate({
      classification,
      alerts: [],
      raidNum: "40",
      raidRows: [row("40차", "A", "boss")],
      roundSyncroLevels: {},
      members,
      lastRaidRow: 100,
      syncroColumn: "H",
      includeStats: true,
      includeMember: false,
    });
    expect(plan.memberSyncroUpdates).toHaveLength(0);
    expect(plan.raidStatsRows).toHaveLength(1);
  });
});
