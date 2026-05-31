// 다회차 쓰기 오케스트레이터 — fingerprint 1회 + backup 1회(통합) + executeBatchUpdate N회.
// 회차 컬럼은 호출 측(main.ts)이 ensureRaidColumn 순차 await 로 확보한 plan[] 을 받는다.
// 단일 회차 writeRaidData facade 와 달리 backup 중복 생성을 방지(회차당 backup X → 통합 1회).

import type { BatchUpdatePlan } from "../dryrun/calculator";
import { verifyFingerprint } from "./fingerprint";
import { createBackupTab } from "./backup";
import { executeBatchUpdate } from "./batch-update";

export interface MultiRoundWriteArgs {
  spreadsheetId: string;
  accessToken: string;
  plans: BatchUpdatePlan[]; // 회차별 (오름차순, raidStatsRange 누적 offset 반영됨)
  backupRaidNum: string; // 통합 백업 라벨 = max 회차 숫자 (prune 정규식 호환)
  allowedFingerprints?: readonly string[];
  fetchImpl?: typeof fetch;
  eventTarget?: EventTarget;
}

export interface MultiRoundWriteResult {
  backupTabName: string;
  writtenRaidNums: string[];
}

function dispatchProgress(
  target: EventTarget,
  stage: string,
  status: string
): void {
  target.dispatchEvent(
    new CustomEvent("sheetsWriteProgress", { detail: { stage, status } })
  );
}

/**
 * fingerprint(1) → backup(1, 통합) → executeBatchUpdate(회차별 N).
 * 부분 실패 시 writtenRaidNums 로 어디까지 성공했는지 반환 (완전 atomic 불가).
 */
export async function applyMultiRoundWrite(
  args: MultiRoundWriteArgs
): Promise<MultiRoundWriteResult> {
  const target = args.eventTarget ?? globalThis;
  const fetchImpl = args.fetchImpl ?? fetch;

  if (args.plans.length === 0) {
    throw new Error("MULTI_ROUND_EMPTY: 처리할 회차 plan 없음");
  }

  // 1) fingerprint 1회
  dispatchProgress(target, "fingerprint", "running");
  await verifyFingerprint(args.spreadsheetId, args.accessToken, {
    skip: false,
    allowed: args.allowedFingerprints,
    fetchImpl,
  });
  dispatchProgress(target, "fingerprint", "done");

  // 2) backup 1회 (통합, 라벨=max 회차)
  dispatchProgress(target, "backup", "running");
  const backupTabName = await createBackupTab(
    args.spreadsheetId,
    args.backupRaidNum,
    args.accessToken,
    fetchImpl
  );
  dispatchProgress(target, "backup", "done");

  // 3) executeBatchUpdate 회차별 순차
  const writtenRaidNums: string[] = [];
  for (const plan of args.plans) {
    dispatchProgress(target, `batchUpdate:${plan.raidNum}`, "running");
    await executeBatchUpdate(args.spreadsheetId, plan, args.accessToken, {
      fetchImpl,
      syncroColumn: plan.syncroColumn,
    });
    writtenRaidNums.push(plan.raidNum);
    dispatchProgress(target, `batchUpdate:${plan.raidNum}`, "done");
  }

  target.dispatchEvent(
    new CustomEvent("sheetsWriteComplete", {
      detail: { raidNum: args.backupRaidNum, backupTabName },
    })
  );
  return { backupTabName, writtenRaidNums };
}
