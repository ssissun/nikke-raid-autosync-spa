// F-NRA-002-06 공개 API — F-04 payload + F-05 classification → F-06 dry-run → F-07 호출 트리거.

import type { NikkeRaidPayload } from "../types";
import type { SyncClassification } from "../matching/types";
import {
  prepareBatchUpdate,
  type BatchUpdatePlan,
} from "./calculator";

let lastPlan: BatchUpdatePlan | null = null;

export interface PrepareDryRunArgs {
  payload: NikkeRaidPayload;
  classification: SyncClassification;
  alerts: readonly string[];
  lastRaidRow: number;
  syncroColumn: string;
}

export function prepareDryRun(args: PrepareDryRunArgs): BatchUpdatePlan {
  const plan = prepareBatchUpdate(
    args.classification,
    args.alerts,
    args.payload,
    args.lastRaidRow,
    args.syncroColumn
  );
  lastPlan = plan;
  return plan;
}

export function getBatchUpdatePlan(): BatchUpdatePlan | null {
  return lastPlan;
}

export function clearBatchUpdatePlan(): void {
  lastPlan = null;
}

export type ConfirmWriteHandler = (plan: BatchUpdatePlan) => Promise<void> | void;

/**
 * 사용자 확인 후 호출. F-NRA-002-07.writeRaidData에 위임.
 * 실제 writer를 인자로 받아 dryrun 모듈과 sheets 모듈을 디커플링.
 */
export async function confirmWrite(
  plan: BatchUpdatePlan,
  writer: ConfirmWriteHandler
): Promise<void> {
  if (!plan.isConfirmable) {
    throw new Error(
      `미리보기 확인 불가 — unmatched ${plan.unmatchedNames.length}건 대기`
    );
  }
  await writer(plan);
}

export {
  prepareBatchUpdate,
  calculateRaidStatsRows,
  calculateMemberSyncroUpdates,
} from "./calculator";
export { renderDryRunPreview, renderProgressUI } from "./ui";
export type {
  BatchUpdatePlan,
  MemberSyncroUpdate,
} from "./calculator";
export type { ProgressStage } from "./ui";
