// F-NRA-002-08 공개 API — F-06 dry-run / F-07 batchUpdate에서 호출.

import type { GuildMember } from "../types";
import type { SyncClassification } from "../matching/types";
import {
  buildSyncPlan as buildSyncPlanCore,
  buildFirstRunPlan,
  isFirstRun,
  isSyncError,
} from "./algorithm";
import { buildColBUpdates } from "./col-b-update";
import { type SyncResult, SyncError } from "./types";

let lastResult: SyncResult | null = null;

/**
 * F-NRA-002-05 매칭 결과 + 시트 행 수 → SyncResult (plan + colBUpdates + alerts).
 * allColBEmpty=true 면 firstRun 분기.
 */
export function buildSyncPlan(
  classification: SyncClassification,
  totalSheetRows: number,
  allColBEmpty: boolean,
  payloadMembers: readonly GuildMember[]
): SyncResult {
  const plan = isFirstRun(allColBEmpty)
    ? buildFirstRunPlan(payloadMembers)
    : buildSyncPlanCore(classification, totalSheetRows);

  // firstRun: appendStartRow는 row 2 (header=row1 다음부터)
  // 정상 sync: stayingRows compaction 후 다음 행부터 append
  const appendStartRow = plan.isFirstRun
    ? 2
    : 2 + (totalSheetRows - plan.deleteRequests.length);

  const colBUpdates = buildColBUpdates(classification, appendStartRow);

  const result: SyncResult = {
    plan,
    colBUpdates,
    alerts: plan.alerts,
  };
  lastResult = result;
  return result;
}

export function getSyncResult(): SyncResult | null {
  return lastResult;
}

export function clearSyncResult(): void {
  lastResult = null;
}

export { isSyncError, SyncError };
export type {
  AppendRowRequest,
  ColBUpdate,
  DeleteRowRequest,
  ReNumberRequest,
  SyncAlert,
  SyncPlan,
  SyncResult,
} from "./types";
