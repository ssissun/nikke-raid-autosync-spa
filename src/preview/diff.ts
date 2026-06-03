// 동기화 프리뷰의 멤버 변동 diff 렌더 — 행번호 병기 + 추가/삭제/변경 시각 마커.
// 색상만이 아니라 기호(+/−/~)를 병행하여 색맹 환경에서도 구분 가능하게 한다.
// sheetRow 미보유(시트 행 미할당, 신규 멤버)는 행번호를 생략한다.
import { escapeHtml } from "../util/html";

export interface PreviewMember {
  nickname: string;
  sheetRow?: number; // 탈퇴/변경 멤버는 시트 행 보유, 신규(payload-only) 멤버는 undefined
}

export type DiffKind = "add" | "del" | "mod";

export const MARKER: Record<DiffKind, string> = { add: "+", del: "−", mod: "~" };

// 추가/삭제 멤버 1명을 마커 + 행번호 병기로 렌더.
export function renderDiffMember(m: PreviewMember, kind: DiffKind): string {
  const row = m.sheetRow !== undefined ? ` (행 ${m.sheetRow})` : "";
  return `<span class="diff-member diff-${kind}">${MARKER[kind]} ${escapeHtml(m.nickname)}${row}</span>`;
}

export interface PreviewNicknameChange {
  old: string;
  new: string;
  sheetRow?: number;
}

// 닉네임 변경 1건을 `~ 구닉 (행 N) → 새닉` 형태로 렌더 (행번호는 구닉 기준).
export function renderNicknameChange(c: PreviewNicknameChange): string {
  const row = c.sheetRow !== undefined ? ` (행 ${c.sheetRow})` : "";
  return `<span class="diff-member diff-mod">${MARKER.mod} ${escapeHtml(c.old)}${row} → ${escapeHtml(c.new)}</span>`;
}
