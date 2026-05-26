// Col B (member_id) + Col C (nickname) 갱신 요청 생성.
// 실제 Sheets API 호출은 F-NRA-002-07 위임 — 본 모듈은 ColBUpdate[] 생성만.

import { detectNicknameChanges } from "../matching/algorithm";
import type { SyncClassification } from "../matching/types";
import type { ColBUpdate } from "./types";

/**
 * leaving 행 → Col B 클리어 (memberId='')
 * joining 행 → Col B에 member_id 채움 (sheetRow는 append 후 위치, F-07에서 계산)
 * staying 닉네임 변경 → Col C에 새 닉네임
 *
 * @param classification F-05 산출물
 * @param appendStartRow joining 행이 추가될 시트 시작 행 (F-07에서 lastRow+1)
 */
export function buildColBUpdates(
  classification: SyncClassification,
  appendStartRow: number
): ColBUpdate[] {
  const updates: ColBUpdate[] = [];

  // leaving — Col B 클리어 (행 자체는 deleteRange로 사라지지만, 안전성을 위해 명시 클리어 후 삭제)
  for (const l of classification.leaving) {
    updates.push({
      type: "setMemberId",
      sheetRow: l.sheetRow,
      memberId: "",
    });
  }

  // joining — Col B에 member_id (sheetRow는 appendStartRow부터)
  classification.joining.forEach((j, idx) => {
    updates.push({
      type: "setMemberId",
      sheetRow: appendStartRow + idx,
      memberId: j.member_id,
    });
  });

  // staying 닉네임 변경 → Col C
  const changes = detectNicknameChanges(classification);
  for (const c of changes) {
    updates.push({
      type: "setNickname",
      sheetRow: c.sheetRow,
      nickname: c.new,
    });
  }

  return updates;
}
