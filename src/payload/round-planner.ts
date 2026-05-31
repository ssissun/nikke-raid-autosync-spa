// 누락 회차 판정 — payload 가용 회차 중 시트에 없는 것만 처리 대상으로 선별.

import type { RaidRoundData } from "../types";
import type { NormalizedMultiPayload } from "./normalize";

export interface RoundSelection {
  // 처리 대상: 시트에 없고 payload 에 데이터가 있는 회차 (오름차순)
  targetRounds: RaidRoundData[];
  // 시트에 이미 있어 skip 한 회차
  alreadyInSheet: string[];
  // 가용 목록엔 있으나 payload rounds 에 데이터가 없는 회차 (경고용)
  unavailableButRequested: string[];
}

/**
 * normalized.rounds 중 existing 에 없는 회차만 target. 오름차순.
 * availableRaidNums 중 rounds 에 데이터 없는 것은 unavailableButRequested.
 */
export function selectMissingRounds(
  normalized: NormalizedMultiPayload,
  existing: ReadonlySet<string>
): RoundSelection {
  const roundByNum = new Map<string, RaidRoundData>();
  for (const r of normalized.rounds) roundByNum.set(r.raidNum, r);

  const targetRounds: RaidRoundData[] = [];
  const alreadyInSheet: string[] = [];
  for (const r of normalized.rounds) {
    if (existing.has(r.raidNum)) alreadyInSheet.push(r.raidNum);
    else targetRounds.push(r);
  }
  targetRounds.sort((a, b) => Number(a.raidNum) - Number(b.raidNum));

  const unavailableButRequested: string[] = [];
  for (const rn of normalized.availableRaidNums) {
    if (!roundByNum.has(rn)) unavailableButRequested.push(rn);
  }

  return { targetRounds, alreadyInSheet, unavailableButRequested };
}
