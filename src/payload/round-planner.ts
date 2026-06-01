// 탭별 누락 회차 판정 — 레이드 통계 / 유니온 멤버 각각 따로 보고 필요한 데이터를 채운다.

import type { RaidRoundData } from "../types";
import type { NormalizedMultiPayload } from "./normalize";

export interface RoundTarget {
  round: RaidRoundData;
  missingStats: boolean; // 레이드 통계에 회차 행 없음 → 행 추가
  missingMember: boolean; // 유니온 멤버에 회차 컬럼 없음 → 싱크로 컬럼 추가
}

export interface RoundSelection {
  // 처리 대상: 적어도 한 탭에 누락 + payload 에 데이터 존재 (오름차순)
  targetRounds: RoundTarget[];
  // 두 탭 모두 이미 존재 → skip
  alreadyComplete: string[];
  // 가용 목록엔 있으나 payload rounds 에 데이터가 없는 회차 (경고용)
  unavailableButRequested: string[];
}

/**
 * 탭별 판정 — 레이드 통계(statsRounds) / 유니온 멤버(memberRounds) 각각과 비교.
 * 한쪽에만 누락된 회차도 target 으로 잡아 해당 탭만 채운다 (멱등 — 이미 있는 탭은 안 건드림).
 */
export function selectMissingRounds(
  normalized: NormalizedMultiPayload,
  statsRounds: ReadonlySet<string>,
  memberRounds: ReadonlySet<string>
): RoundSelection {
  const roundByNum = new Map<string, RaidRoundData>();
  for (const r of normalized.rounds) roundByNum.set(r.raidNum, r);

  const targetRounds: RoundTarget[] = [];
  const alreadyComplete: string[] = [];
  for (const r of normalized.rounds) {
    const missingStats = !statsRounds.has(r.raidNum);
    const missingMember = !memberRounds.has(r.raidNum);
    if (missingStats || missingMember) {
      targetRounds.push({ round: r, missingStats, missingMember });
    } else {
      alreadyComplete.push(r.raidNum);
    }
  }
  targetRounds.sort(
    (a, b) => Number(a.round.raidNum) - Number(b.round.raidNum)
  );

  const unavailableButRequested: string[] = [];
  for (const rn of normalized.availableRaidNums) {
    if (!roundByNum.has(rn)) unavailableButRequested.push(rn);
  }

  return { targetRounds, alreadyComplete, unavailableButRequested };
}
