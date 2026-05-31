// F-NRA-002-06 BatchUpdatePlan 계산 — 순수 함수.
// SOT: ai_docs/nikke-raid-autosync/SHEET_SCHEMA.md §레이드 통계 / API_SPEC.md §4

import type { GuildMember, NikkeRaidPayload, ProcessedRaidRow } from "../types";
import type { SyncClassification } from "../matching/types";

export interface MemberSyncroUpdate {
  sheetRow: number;
  syncroLevel: number;
  column: string; // 회차 컬럼 letter (예: 'H')
}

export interface BatchUpdatePlan {
  raidNum: string;
  backupTabName: string; // _backup_{회차} | _backup_unknown
  raidStatsRange: string; // 레이드 통계!A{N}:P{N+rows-1}
  raidStatsRows: string[][]; // 16-col
  memberSyncroUpdates: MemberSyncroUpdate[];
  syncroColumn: string;
  unmatchedNames: string[]; // A-2 'unmatched' 대기 항목
  isConfirmable: boolean; // unmatched 있으면 false
}

const RAID_STATS_SHEET = "레이드 통계";

function computeBackupTabName(raidNum: string | null | undefined): string {
  if (raidNum === undefined || raidNum === null || raidNum.length === 0) {
    return "_backup_unknown";
  }
  return `_backup_${raidNum}`;
}

/**
 * ProcessedRaidRow[] → string[][] (Sheets 행). 헤드리스 — header row 없음.
 */
export function raidRowsToStrings(
  raid: readonly ProcessedRaidRow[]
): string[][] {
  return raid.map((row) =>
    row.map((cell) => (typeof cell === "number" ? String(cell) : cell))
  );
}

/**
 * payload.raid (ProcessedRaidRow[]) → string[][] (Sheets 행). 레거시 single 용 wrapper.
 */
export function calculateRaidStatsRows(
  payload: NikkeRaidPayload
): string[][] {
  if (payload.type !== "nikke-raid-data") return [];
  return raidRowsToStrings(payload.raid);
}

/**
 * payload.members → MemberSyncroUpdate[]. synchro_level === 0 또는 미매칭은 제외.
 */
export function calculateMemberSyncroUpdates(
  classification: SyncClassification,
  members: readonly GuildMember[],
  syncroColumn: string,
  roundSyncroLevels?: Record<string, number>
): MemberSyncroUpdate[] {
  const memberById = new Map<string, GuildMember>();
  for (const m of members) memberById.set(m.member_id, m);

  // 회차 당시 레벨 우선, 없으면 현재 synchro_level fallback.
  const levelFor = (memberId: string): number => {
    const round = roundSyncroLevels?.[memberId];
    if (round !== undefined && round > 0) return round;
    return memberById.get(memberId)?.synchro_level ?? 0;
  };

  const updates: MemberSyncroUpdate[] = [];
  for (const s of classification.staying) {
    const m = memberById.get(s.member_id);
    if (m === undefined) continue;
    const lv = levelFor(s.member_id);
    if (lv <= 0) continue;
    updates.push({
      sheetRow: s.sheetRow,
      syncroLevel: lv,
      column: syncroColumn,
    });
  }
  // backfill 마이그레이션의 경우 classification.staying이 비어 있을 수 있고
  // payload.members 전체가 sheet 1..N에 가입 순서대로 자동 매핑됨.
  // 이 경우 dryrun에서 payload 순서 그대로 syncro 입력.
  if (updates.length === 0 && classification.staying.length === 0) {
    members.forEach((m, idx) => {
      const lv = levelFor(m.member_id);
      if (lv <= 0) return;
      updates.push({
        sheetRow: idx + 2, // header=row1, 데이터 row2부터
        syncroLevel: lv,
        column: syncroColumn,
      });
    });
  }
  return updates;
}

/**
 * F-NRA-002-06 메인 진입. unmatched(A-2) 항목은 미리보기 경고에 표시, 확인 버튼은 비활성화.
 */
export function prepareBatchUpdate(
  classification: SyncClassification,
  alerts: readonly string[],
  payload: NikkeRaidPayload,
  lastRaidRow: number,
  syncroColumn: string
): BatchUpdatePlan {
  const raidNum =
    payload.type === "nikke-raid-data" ? payload.raidNum : undefined;
  const members =
    payload.type === "nikke-raid-data" ? payload.members : [];

  const raidStatsRows = calculateRaidStatsRows(payload);
  const memberSyncroUpdates = calculateMemberSyncroUpdates(
    classification,
    members,
    syncroColumn
  );

  // A-2 unmatched 집계 — F-NRA-002-05 alerts에 'unmatched' 표시된 항목 추출
  const unmatchedNames: string[] = [];
  for (const a of alerts) {
    if (a.includes("매칭 실패") || a.toLowerCase().includes("unmatched")) {
      unmatchedNames.push(a);
    }
  }

  const raidStatsRange =
    raidStatsRows.length > 0
      ? `${RAID_STATS_SHEET}!A${lastRaidRow + 1}:P${lastRaidRow + raidStatsRows.length}`
      : "";

  return {
    raidNum: raidNum ?? "unknown",
    backupTabName: computeBackupTabName(raidNum),
    raidStatsRange,
    raidStatsRows,
    memberSyncroUpdates,
    syncroColumn,
    unmatchedNames,
    isConfirmable: unmatchedNames.length === 0,
  };
}

export interface PrepareRoundArgs {
  classification: SyncClassification;
  alerts: readonly string[];
  raidNum: string;
  raidRows: readonly ProcessedRaidRow[]; // 이 회차 rows (index0 라벨 정규화 완료)
  roundSyncroLevels: Record<string, number>;
  members: readonly GuildMember[];
  lastRaidRow: number; // 누적 — 이전 회차 행 수 반영
  syncroColumn: string;
}

/**
 * 회차 1개 분량 → BatchUpdatePlan. 다회차 오케스트레이터가 회차별로 호출.
 * raidRows 는 호출 측에서 index0 라벨을 `${raidNum}차` 로 정규화한 상태여야 함.
 */
export function prepareRoundBatchUpdate(args: PrepareRoundArgs): BatchUpdatePlan {
  const raidStatsRows = raidRowsToStrings(args.raidRows);
  const memberSyncroUpdates = calculateMemberSyncroUpdates(
    args.classification,
    args.members,
    args.syncroColumn,
    args.roundSyncroLevels
  );

  const unmatchedNames: string[] = [];
  for (const a of args.alerts) {
    if (a.includes("매칭 실패") || a.toLowerCase().includes("unmatched")) {
      unmatchedNames.push(a);
    }
  }

  const raidStatsRange =
    raidStatsRows.length > 0
      ? `${RAID_STATS_SHEET}!A${args.lastRaidRow + 1}:P${args.lastRaidRow + raidStatsRows.length}`
      : "";

  return {
    raidNum: args.raidNum,
    backupTabName: computeBackupTabName(args.raidNum),
    raidStatsRange,
    raidStatsRows,
    memberSyncroUpdates,
    syncroColumn: args.syncroColumn,
    unmatchedNames,
    isConfirmable: unmatchedNames.length === 0,
  };
}
