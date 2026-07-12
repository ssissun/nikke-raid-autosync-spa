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

// 수동 추가 행(member_id 미매핑)을 닉네임으로 payload 신규 멤버와 결합한 결과.
export interface ReconciledMember {
  member_id: string;
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
  /** none 모드에서 수동 추가 행을 닉네임으로 자동 결합(입양)한 목록 — 신규 오인식 방지 */
  reconciled: ReconciledMember[];
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

/**
 * none 모드 — 매핑 없는 시트 행(운영자가 수동 추가한 멤버)을 닉네임으로 payload 신규 멤버와 결합.
 * 확신 케이스(미매핑 행 1개 ↔ 신규 멤버 1명, 닉네임 1:1)만 colBMap 에 반영(입양) → 이후 staying 으로 흡수되어
 * 중복 신규 행 생성을 방지하고 member_id 를 그 행에 backfill 한다.
 * 닉네임 중복·모호(행 다수 또는 멤버 다수)는 결합하지 않고 ambiguous 로 보고(수동 확인 유도).
 * @returns reconciled(입양 성사), ambiguous(자동 결합 불가 닉네임)
 */
export function reconcileUnmappedByNickname(
  colBMap: Map<string, number>,
  colCNicknames: ReadonlyMap<number, string>,
  payloadMembers: readonly GuildMember[]
): { reconciled: ReconciledMember[]; ambiguous: string[] } {
  const claimedRows = new Set(colBMap.values());
  const mappedIds = new Set(colBMap.keys());

  // 미매핑 시트 행: nickname → [sheetRow...]
  const unmappedByNick = new Map<string, number[]>();
  for (const [sheetRow, nick] of colCNicknames.entries()) {
    if (claimedRows.has(sheetRow) || nick.length === 0) continue;
    const arr = unmappedByNick.get(nick) ?? [];
    arr.push(sheetRow);
    unmappedByNick.set(nick, arr);
  }
  if (unmappedByNick.size === 0) return { reconciled: [], ambiguous: [] };

  // payload 신규 멤버(member_id 미매핑): nickname → [member...]
  const joiningByNick = new Map<string, GuildMember[]>();
  for (const m of payloadMembers) {
    if (mappedIds.has(m.member_id)) continue;
    const arr = joiningByNick.get(m.nickname) ?? [];
    arr.push(m);
    joiningByNick.set(m.nickname, arr);
  }

  const reconciled: ReconciledMember[] = [];
  const ambiguous: string[] = [];
  for (const [nick, rows] of unmappedByNick.entries()) {
    const members = joiningByNick.get(nick) ?? [];
    if (members.length === 0) continue; // payload 신규에 없음 → 진짜 탈퇴/불일치(leaving 로직이 처리)
    if (rows.length === 1 && members.length === 1) {
      colBMap.set(members[0].member_id, rows[0]); // 입양 → buildSyncClassification 에서 staying
      reconciled.push({ member_id: members[0].member_id, nickname: nick, sheetRow: rows[0] });
    } else {
      ambiguous.push(nick); // 닉네임 중복(행 다수 또는 멤버 다수) → 자동 결합 불가
    }
  }
  return { reconciled, ambiguous };
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

  // none 모드: 수동 추가 행(미매핑)을 닉네임으로 payload 신규 멤버와 결합(입양) → 중복 신규 오인식 방지.
  // colBMap 을 mutate 하므로 buildSyncClassification 전에 수행 → 입양된 멤버는 staying 으로 흡수된다.
  let reconciled: ReconciledMember[] = [];
  if (mode === "none") {
    const rec = reconcileUnmappedByNickname(
      sheetRead.colBMap,
      sheetRead.colCNicknames,
      payloadMembers
    );
    reconciled = rec.reconciled;
    if (rec.ambiguous.length > 0) {
      alerts.push(
        `자동 매핑 불가(닉네임 중복/모호) ${rec.ambiguous.length}건: ${rec.ambiguous.join(", ")} — 수동 확인 필요`
      );
    }
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
    reconciled,
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
