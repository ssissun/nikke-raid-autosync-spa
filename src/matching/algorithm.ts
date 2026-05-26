// member_id 우선 매칭 알고리즘 — 순수 함수.
// staying/leaving/joining 3분류 + 닉네임 변경 감지.

import type { GuildMember } from "../types";
import type { NicknameChange, SyncClassification } from "./types";

/**
 * member_id Set 비교로 staying/leaving/joining 분류.
 * @param colBMap     {member_id → sheetRow} (유니온 멤버 Col B 읽기 결과)
 * @param colCNicknames {sheetRow → nickname} (Col C 읽기 결과)
 * @param payloadMembers ShiftyPad GetGuildMembers 응답 변환
 */
export function buildSyncClassification(
  colBMap: Map<string, number>,
  colCNicknames: Map<number, string>,
  payloadMembers: readonly GuildMember[]
): SyncClassification {
  const payloadById = new Map<string, GuildMember>();
  for (const m of payloadMembers) {
    payloadById.set(m.member_id, m);
  }

  const staying: SyncClassification["staying"] = [];
  const leaving: SyncClassification["leaving"] = [];
  const joining: SyncClassification["joining"] = [];

  // 시트(Col B) 기준 순회 → staying / leaving 분류
  for (const [memberId, sheetRow] of colBMap.entries()) {
    const sheetNickname = colCNicknames.get(sheetRow) ?? "";
    const payloadMember = payloadById.get(memberId);
    if (payloadMember !== undefined) {
      staying.push({
        member_id: memberId,
        sheetRow,
        nickname: sheetNickname,
        payloadNickname: payloadMember.nickname,
      });
    } else {
      leaving.push({
        member_id: memberId,
        sheetRow,
        nickname: sheetNickname,
      });
    }
  }

  // payload 기준 순회 → joining 분류 (Col B에 없는 member_id)
  for (const m of payloadMembers) {
    if (!colBMap.has(m.member_id)) {
      joining.push({
        member_id: m.member_id,
        nickname: m.nickname,
        synchro_level: m.synchro_level,
      });
    }
  }

  return { staying, leaving, joining };
}

/**
 * staying 행에서 nickname !== payloadNickname인 항목만 추출.
 */
export function detectNicknameChanges(
  classification: SyncClassification
): NicknameChange[] {
  const changes: NicknameChange[] = [];
  for (const s of classification.staying) {
    if (s.nickname !== s.payloadNickname && s.payloadNickname.length > 0) {
      changes.push({
        member_id: s.member_id,
        sheetRow: s.sheetRow,
        old: s.nickname,
        new: s.payloadNickname,
      });
    }
  }
  return changes;
}

/**
 * 분류 결과가 자동 처리 가능한 상태인지 (joining 2명+ 시 수동 정렬 필요).
 */
export function isSyncClassificationComplete(
  classification: SyncClassification
): boolean {
  return classification.joining.length <= 1;
}
