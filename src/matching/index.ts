// 통합 매칭 흐름 — readColBMap → migration mode → buildSyncClassification.

import type { GuildMember } from "../types";
import {
  buildSyncClassification,
  detectNicknameChanges,
  isSyncClassificationComplete,
} from "./algorithm";
import { readColBMap, type ReadColBMapResult } from "./col-b-reader";
import { detectMigrationMode, type MigrationMode } from "./migration";
import { readMemberIdTab, resolveColBMap } from "../sheets/member-id-tab";
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

export interface UnmatchedSheetNickname {
  nickname: string;
  sheetRow: number;
}

export interface ClassificationResult {
  classification: SyncClassification;
  mode: MigrationMode;
  nicknameChanges: NicknameChange[];
  alerts: string[]; // A-2 매칭 실패 안내
  isComplete: boolean;
  /** backfill 모드에서 시트 닉네임 매칭 실패 목록 (탈퇴 후보) */
  unmatchedSheetNicknames: UnmatchedSheetNickname[];
  /** backfill 모드에서 payload 닉네임 매칭 실패 목록 (신규 가입 후보) */
  unmatchedPayloadMembers: GuildMember[];
}

let lastResult: ClassificationResult | null = null;

interface BackfillResult {
  alerts: string[];
  unmatchedSheetNicknames: UnmatchedSheetNickname[];
  unmatchedPayloadMembers: GuildMember[];
}

function backfillColBMapFromNicknames(
  colBMap: Map<string, number>,
  colCNicknames: Map<number, string>,
  payloadMembers: readonly GuildMember[]
): BackfillResult {
  // sheetRow → nickname 역인덱스 (nickname → sheetRow)
  const nicknameToRow = new Map<string, number>();
  for (const [sheetRow, nickname] of colCNicknames.entries()) {
    nicknameToRow.set(nickname, sheetRow);
  }

  const unmatchedSheetNames = new Set(nicknameToRow.keys());
  const unmatchedPayloadMembers: GuildMember[] = [];

  for (const member of payloadMembers) {
    const sheetRow = nicknameToRow.get(member.nickname);
    if (sheetRow !== undefined) {
      colBMap.set(member.member_id, sheetRow);
      unmatchedSheetNames.delete(member.nickname);
    } else {
      unmatchedPayloadMembers.push(member);
    }
  }

  const unmatchedSheetNicknames: UnmatchedSheetNickname[] = [];
  for (const nickname of unmatchedSheetNames) {
    const sheetRow = nicknameToRow.get(nickname);
    if (sheetRow !== undefined) {
      unmatchedSheetNicknames.push({ nickname, sheetRow });
    }
  }

  const alerts: string[] = [];
  if (unmatchedSheetNicknames.length > 0) {
    alerts.push(
      `시트 닉네임 매칭 실패 ${unmatchedSheetNicknames.length}명: ${unmatchedSheetNicknames.map((u) => u.nickname).join(", ")}`
    );
  }
  if (unmatchedPayloadMembers.length > 0) {
    alerts.push(
      `payload 닉네임 매칭 실패 ${unmatchedPayloadMembers.length}명: ${unmatchedPayloadMembers.map((m) => m.nickname).join(", ")}`
    );
  }
  return { alerts, unmatchedSheetNicknames, unmatchedPayloadMembers };
}

export async function startClassificationFlow(
  accessToken: string,
  sheetId: string,
  payloadMembers: readonly GuildMember[]
): Promise<ClassificationResult> {
  const sheetRead: ReadColBMapResult = await readColBMap(accessToken, sheetId);

  // 원본 레이아웃(pre-migration)이면 member_id 를 _nra_member_mapping 탭에서 읽어 colBMap 채움.
  // post-migration(구버그 — Col B 에 member_id) 시트는 Col B 에서 직접 읽음 (apply 단계서 역마이그레이션).
  let allColBEmpty = sheetRead.allColBEmpty;
  if (sheetRead.layout === "pre-migration") {
    const tab = await readMemberIdTab(sheetId, accessToken);
    // 행 정렬 우선 + 닉네임 검증/복구 (탭 닉네임 == 시트 닉네임이면 행 신뢰, 틀어지면 닉네임 복구)
    const resolved = resolveColBMap(tab.byRow, sheetRead.colCNicknames);
    for (const [memberId, row] of resolved.entries()) {
      sheetRead.colBMap.set(memberId, row);
    }
    allColBEmpty = sheetRead.colBMap.size === 0;
  }

  const mode = detectMigrationMode(allColBEmpty, sheetRead.colCNicknames);

  if (mode === "block") {
    throw new SyncError(
      MIGRATION_BLOCKED,
      "유니온 멤버 시트에 가입 순서대로 닉네임을 먼저 입력해주세요"
    );
  }

  const alerts: string[] = [];
  let unmatchedSheetNicknames: UnmatchedSheetNickname[] = [];
  let unmatchedPayloadMembers: GuildMember[] = [];
  if (mode === "backfill") {
    const backfillResult = backfillColBMapFromNicknames(
      sheetRead.colBMap,
      sheetRead.colCNicknames,
      payloadMembers
    );
    alerts.push(...backfillResult.alerts);
    unmatchedSheetNicknames = backfillResult.unmatchedSheetNicknames;
    unmatchedPayloadMembers = backfillResult.unmatchedPayloadMembers;
  }

  const classification = buildSyncClassification(
    sheetRead.colBMap,
    sheetRead.colCNicknames,
    payloadMembers
  );

  // mode "none"(매핑 탭 기반): 탈퇴/신규는 classification(member_id 기준)에 담김 →
  // apply(applyMemberSync)가 실제로 쓰는 unmatched* 로 surface해야 적용됨.
  //  - 탈퇴: member_id 기반 leaving + colBMap 으로 해석 안 된 시트 행 중 닉네임도 payload 에 없는 행
  //          (수동 편집·행 드리프트로 member_id 도 닉네임도 매칭 안 되는 잔존 행 → 탈퇴 처리)
  //  - 신규: payload member_id 가 colBMap 에 없는 멤버
  if (mode === "none") {
    const claimedRows = new Set(sheetRead.colBMap.values());
    const payloadNicks = new Set(payloadMembers.map((m) => m.nickname));
    const leaving = classification.leaving.map((l) => ({
      nickname: l.nickname,
      sheetRow: l.sheetRow,
    }));
    for (const [sheetRow, nickname] of sheetRead.colCNicknames.entries()) {
      if (!claimedRows.has(sheetRow) && !payloadNicks.has(nickname)) {
        leaving.push({ nickname, sheetRow });
      }
    }
    unmatchedSheetNicknames = leaving;
    const joiningIds = new Set(classification.joining.map((j) => j.member_id));
    unmatchedPayloadMembers = payloadMembers.filter((m) => joiningIds.has(m.member_id));
  }

  const nicknameChanges = detectNicknameChanges(classification);
  const baseComplete = isSyncClassificationComplete(classification);
  // backfill 모드에서 unmatched 가 있으면 isComplete=false (auto-sync 필요)
  const isComplete =
    baseComplete &&
    unmatchedSheetNicknames.length === 0 &&
    unmatchedPayloadMembers.length === 0;

  const result: ClassificationResult = {
    classification,
    mode,
    nicknameChanges,
    alerts,
    isComplete,
    unmatchedSheetNicknames,
    unmatchedPayloadMembers,
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
