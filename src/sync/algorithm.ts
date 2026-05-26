// F-NRA-002-08 set 비교 + SyncPlan 생성. 순수 함수.
// 실제 Sheets API 호출은 F-NRA-002-07에 위임.

import type { GuildMember } from "../types";
import {
  buildSyncClassification as buildSyncClassificationCore,
} from "../matching/algorithm";
import type { SyncClassification } from "../matching/types";
import {
  type AppendRowRequest,
  type DeleteRowRequest,
  type ReNumberRequest,
  type SyncAlert,
  type SyncPlan,
  SyncError,
} from "./types";

const MAX_MEMBERS = 32;

// T-01: F-05 buildSyncClassification 재사용 (모듈 간 단일 SOT)
export const buildSyncClassification = buildSyncClassificationCore;

export function isFirstRun(allColBEmpty: boolean): boolean {
  return allColBEmpty;
}

export function isSyncError(x: unknown): x is SyncError {
  return x instanceof SyncError;
}

/**
 * 정상 sync — staying 유지 + leaving 행 삭제 + Col A 재번호 + joining 추가.
 * @param classification F-05 산출물
 * @param totalSheetRows 유니온 멤버 시트 현재 행 수 (Col B 기준)
 */
export function buildSyncPlan(
  classification: SyncClassification,
  totalSheetRows: number
): SyncPlan {
  const beforeCount = totalSheetRows;
  const leavingCount = classification.leaving.length;
  const joiningCount = classification.joining.length;
  const afterCount = beforeCount - leavingCount + joiningCount;

  if (afterCount > MAX_MEMBERS) {
    throw new SyncError(
      "OVER_CAPACITY",
      `유니온 멤버 32명 초과 (after=${afterCount}, leaving=${leavingCount}, joining=${joiningCount})`
    );
  }

  // leaving 행: 큰 sheetRow부터 역순 삭제 (compaction 안전)
  const sortedLeaving = [...classification.leaving].sort(
    (a, b) => b.sheetRow - a.sheetRow
  );
  const deleteRequests: DeleteRowRequest[] = sortedLeaving.map((row) => ({
    sheetRow: row.sheetRow,
  }));

  // 삭제 후 남은 staying 행 + 새 joining 행에 Col A 재번호 부여
  const remainingStaying = [...classification.staying]
    .sort((a, b) => a.sheetRow - b.sheetRow)
    .map((s, idx) => ({ ...s, newOrder: idx + 1 }));

  const reNumberRequests: ReNumberRequest[] = remainingStaying
    .map((s) => ({
      sheetRow: s.sheetRow,
      newOrder: s.newOrder,
    }))
    // sheetRow ≠ newOrder + 1 인 경우만 갱신 (header=row1 → sheetRow == newOrder+1)
    .filter((r) => r.sheetRow !== r.newOrder + 1);

  const stayingCount = remainingStaying.length;
  const appendRequests: AppendRowRequest[] = classification.joining.map(
    (j, idx) => ({
      joined_order: stayingCount + idx + 1,
      member_id: j.member_id,
      nickname: j.nickname,
    })
  );

  const alerts: SyncAlert[] = [];
  if (joiningCount >= 2) {
    alerts.push({
      severity: "warning",
      code: "sort_needed",
      message: `신규 가입 ${joiningCount}명 — 가입 순서 정렬 검토 필요`,
    });
  }

  return {
    deleteRequests,
    reNumberRequests,
    appendRequests,
    alerts,
    beforeCount,
    afterCount,
    isFirstRun: false,
  };
}

/**
 * 첫 회차 — Col B 전체 공백 → payload 전원 신규 추가.
 */
export function buildFirstRunPlan(payloadMembers: readonly GuildMember[]): SyncPlan {
  const afterCount = payloadMembers.length;
  if (afterCount > MAX_MEMBERS) {
    throw new SyncError(
      "OVER_CAPACITY",
      `payload ${afterCount}명 — 32명 초과`
    );
  }

  const appendRequests: AppendRowRequest[] = payloadMembers.map((m, idx) => ({
    joined_order: idx + 1,
    member_id: m.member_id,
    nickname: m.nickname,
  }));

  const alerts: SyncAlert[] = [];
  if (afterCount >= 2) {
    alerts.push({
      severity: "warning",
      code: "sort_needed",
      message: `첫 회차 ${afterCount}명 — 가입 순서를 운영자가 정렬해주세요`,
    });
  }

  return {
    deleteRequests: [],
    reNumberRequests: [],
    appendRequests,
    alerts,
    beforeCount: 0,
    afterCount,
    isFirstRun: true,
  };
}
