// F-NRA-002-07 facade — fingerprint → backup → batchUpdate 3단계 + 진행 이벤트.

import type { BatchUpdatePlan } from "../dryrun/calculator";
import { verifyFingerprint } from "./fingerprint";
import { createBackupTab } from "./backup";
import { executeBatchUpdate } from "./batch-update";

export type WriteStage = "fingerprint" | "backup" | "batchUpdate";
export type WriteStatus = "running" | "done";

export interface WriteRaidDataOptions {
  fetchImpl?: typeof fetch;
  skipFingerprint?: boolean;
  allowedFingerprints?: readonly string[];
  rateLimitDelayMs?: number;
  /** 사전 계산된 syncroColumn (F-06이 이미 알면). */
  syncroColumn?: string;
  /** 진행 이벤트 dispatch 대상 — 테스트 시 mock target 전달 가능. */
  eventTarget?: EventTarget;
}

function dispatchProgress(
  target: EventTarget,
  stage: WriteStage,
  status: WriteStatus
): void {
  target.dispatchEvent(
    new CustomEvent("sheetsWriteProgress", { detail: { stage, status } })
  );
}

/**
 * 쓰기 전체 플로우 — fingerprint 검증 → 백업 탭 생성 → batchUpdate.
 * 각 단계 시작/완료 시 sheetsWriteProgress 이벤트, 전체 완료 시 sheetsWriteComplete.
 */
export async function writeRaidData(
  spreadsheetId: string,
  plan: BatchUpdatePlan,
  accessToken: string,
  options: WriteRaidDataOptions = {}
): Promise<{ backupTabName: string }> {
  const target = options.eventTarget ?? globalThis;

  dispatchProgress(target, "fingerprint", "running");
  await verifyFingerprint(spreadsheetId, accessToken, {
    skip: options.skipFingerprint ?? false,
    allowed: options.allowedFingerprints,
    fetchImpl: options.fetchImpl,
  });
  dispatchProgress(target, "fingerprint", "done");

  dispatchProgress(target, "backup", "running");
  const backupTabName = await createBackupTab(
    spreadsheetId,
    plan.raidNum,
    accessToken,
    options.fetchImpl
  );
  dispatchProgress(target, "backup", "done");

  dispatchProgress(target, "batchUpdate", "running");
  await executeBatchUpdate(spreadsheetId, plan, accessToken, {
    fetchImpl: options.fetchImpl,
    rateLimitDelayMs: options.rateLimitDelayMs,
    syncroColumn: options.syncroColumn ?? plan.syncroColumn,
  });
  dispatchProgress(target, "batchUpdate", "done");

  target.dispatchEvent(
    new CustomEvent("sheetsWriteComplete", {
      detail: { raidNum: plan.raidNum, backupTabName },
    })
  );
  return { backupTabName };
}

export { verifyFingerprint, computeFingerprint, ALLOWED_FINGERPRINTS } from "./fingerprint";
export { createBackupTab } from "./backup";
export { executeBatchUpdate } from "./batch-update";
export {
  findRaidColumn,
  ensureRaidColumn,
  columnNumberToLetter,
} from "./find-column";
export type { RaidColumnResolution, RaidColumnLayout } from "./find-column";
export { appendRaidResultRow } from "./raid-result";
export type { AppendRaidResultResult } from "./raid-result";
export { migrateToMemberId } from "./migrate-to-member-id";
export { applyMultiRoundWrite } from "./multi-round";
export type {
  MultiRoundWriteArgs,
  MultiRoundWriteResult,
} from "./multi-round";
export {
  guessNextRaidNum,
  guessFromMemberHeader,
  guessFromRaidStats,
  readExistingRaidNums,
  extractRaidNumSet,
} from "./guess-raid-num";
