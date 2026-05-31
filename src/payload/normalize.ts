// payload 정규화 — single(레거시) / multi 를 단일 NormalizedMultiPayload 로 통일.
// 이후 SPA 흐름은 항상 다회차 정규형 1가지만 다룬다.

import type {
  GuildMember,
  NikkeRaidPayload,
  ProcessedRaidRow,
  RaidRoundData,
} from "../types";

export interface NormalizedMultiPayload {
  capturedAt: string;
  availableRaidNums: string[]; // 데이터 있는 회차 (오름차순)
  rounds: RaidRoundData[];
  members: GuildMember[];
  meta: { guildId: string; areaId: string };
}

// "40차" → "40", "40" → "40". 숫자만 추출.
function labelToRaidNum(label: string): string | null {
  const m = String(label ?? "").match(/(\d+)/);
  return m ? m[1] : null;
}

// 현재 멤버의 synchro_level 로 memberSyncroLevels 구성 (single fallback 용).
function currentSyncroLevels(members: readonly GuildMember[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of members) {
    if (m.synchro_level > 0) out[m.member_id] = m.synchro_level;
  }
  return out;
}

/**
 * 레거시 single payload → 다회차 정규형.
 * raid rows 를 index 0 회차 라벨로 group-by (payload.raidNum 우선).
 * memberSyncroLevels 는 현재 synchro_level (과거 데이터 없음).
 */
function normalizeSingle(
  p: Extract<NikkeRaidPayload, { type: "nikke-raid-data" }>
): NormalizedMultiPayload {
  const syncro = currentSyncroLevels(p.members);
  const byRound = new Map<string, ProcessedRaidRow[]>();

  for (const row of p.raid) {
    // payload.raidNum 이 있으면 그것으로 통일, 없으면 row[0] 라벨에서 추출
    const rn =
      p.raidNum != null && p.raidNum.length > 0
        ? labelToRaidNum(p.raidNum)
        : labelToRaidNum(row[0]);
    if (rn === null) continue;
    if (!byRound.has(rn)) byRound.set(rn, []);
    byRound.get(rn)!.push(row);
  }

  const rounds: RaidRoundData[] = [...byRound.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([raidNum, raid]) => ({ raidNum, raid, memberSyncroLevels: syncro }));

  return {
    capturedAt: p.capturedAt,
    availableRaidNums: rounds.map((r) => r.raidNum),
    rounds,
    members: p.members,
    meta: p.meta,
  };
}

/**
 * payload → NormalizedMultiPayload. raid 계열이 아니면 null.
 */
export function normalizePayload(
  p: NikkeRaidPayload
): NormalizedMultiPayload | null {
  if (p.type === "nikke-raid-multi") {
    const rounds = [...p.rounds].sort(
      (a, b) => Number(a.raidNum) - Number(b.raidNum)
    );
    return {
      capturedAt: p.capturedAt,
      availableRaidNums:
        p.availableRaidNums.length > 0
          ? [...p.availableRaidNums].sort((a, b) => Number(a) - Number(b))
          : rounds.map((r) => r.raidNum),
      rounds,
      members: p.members,
      meta: p.meta,
    };
  }
  if (p.type === "nikke-raid-data") {
    return normalizeSingle(p);
  }
  return null;
}
