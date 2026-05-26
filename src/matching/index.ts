// 통합 매칭 흐름 — readColBMap → migration mode → buildSyncClassification.

import type { GuildMember } from "../types";
import {
  buildSyncClassification,
  detectNicknameChanges,
  isSyncClassificationComplete,
} from "./algorithm";
import { readColBMap, type ReadColBMapResult } from "./col-b-reader";
import { detectMigrationMode, type MigrationMode } from "./migration";
import type { NicknameChange, SyncClassification } from "./types";

export const MIGRATION_BLOCKED = "MIGRATION_BLOCKED";

export class SyncError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "SyncError";
  }
}

export interface ClassificationResult {
  classification: SyncClassification;
  mode: MigrationMode;
  nicknameChanges: NicknameChange[];
  alerts: string[]; // A-2 매칭 실패 안내
  isComplete: boolean;
}

let lastResult: ClassificationResult | null = null;

function backfillColBMapFromNicknames(
  colBMap: Map<string, number>,
  colCNicknames: Map<number, string>,
  payloadMembers: readonly GuildMember[]
): string[] {
  // sheetRow → nickname 역인덱스 (nickname → sheetRow)
  const nicknameToRow = new Map<string, number>();
  for (const [sheetRow, nickname] of colCNicknames.entries()) {
    nicknameToRow.set(nickname, sheetRow);
  }

  const unmatchedSheetNicknames = new Set(nicknameToRow.keys());
  const unmatchedPayloadNicknames: string[] = [];

  for (const member of payloadMembers) {
    const sheetRow = nicknameToRow.get(member.nickname);
    if (sheetRow !== undefined) {
      colBMap.set(member.member_id, sheetRow);
      unmatchedSheetNicknames.delete(member.nickname);
    } else {
      unmatchedPayloadNicknames.push(member.nickname);
    }
  }

  const alerts: string[] = [];
  if (unmatchedSheetNicknames.size > 0) {
    alerts.push(
      `시트 닉네임 매칭 실패 ${unmatchedSheetNicknames.size}명: ${[...unmatchedSheetNicknames].join(", ")}`
    );
  }
  if (unmatchedPayloadNicknames.length > 0) {
    alerts.push(
      `payload 닉네임 매칭 실패 ${unmatchedPayloadNicknames.length}명: ${unmatchedPayloadNicknames.join(", ")}`
    );
  }
  return alerts;
}

export async function startClassificationFlow(
  accessToken: string,
  sheetId: string,
  payloadMembers: readonly GuildMember[]
): Promise<ClassificationResult> {
  const sheetRead: ReadColBMapResult = await readColBMap(accessToken, sheetId);
  const mode = detectMigrationMode(sheetRead.allColBEmpty, sheetRead.colCNicknames);

  if (mode === "block") {
    throw new SyncError(
      MIGRATION_BLOCKED,
      "유니온 멤버 시트에 가입 순서대로 닉네임을 먼저 입력해주세요"
    );
  }

  const alerts: string[] = [];
  if (mode === "backfill") {
    const backfillAlerts = backfillColBMapFromNicknames(
      sheetRead.colBMap,
      sheetRead.colCNicknames,
      payloadMembers
    );
    alerts.push(...backfillAlerts);
  }

  const classification = buildSyncClassification(
    sheetRead.colBMap,
    sheetRead.colCNicknames,
    payloadMembers
  );
  const nicknameChanges = detectNicknameChanges(classification);
  const isComplete = isSyncClassificationComplete(classification);

  const result: ClassificationResult = {
    classification,
    mode,
    nicknameChanges,
    alerts,
    isComplete,
  };
  lastResult = result;
  return result;
}

export function getSyncClassification(): ClassificationResult | null {
  return lastResult;
}

export function clearSyncClassification(): void {
  lastResult = null;
}

export type { SyncClassification, NicknameChange } from "./types";
