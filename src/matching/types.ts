// F-NRA-002-05 매칭 타입 — 2026-05-22 갱신: `_nra_member_mapping` 탭 폐기 → 유니온 멤버 Col B 통합
// SOT: ai_docs/nikke-raid-autosync/SHEET_SCHEMA.md §2 / API_SPEC.md §2.1

// 유니온 멤버 시트 한 행 (Col A/B/C)
export interface ColBRow {
  joined_order: number; // Col A, 1-based
  member_id: string; // Col B (hidden), 불변 키 — 공백이면 마이그레이션 미완료
  nickname: string; // Col C, 표시용
  sheetRow: number; // joined_order + 1 (header=row1)
}

// Legacy 별명 — F-NRA-002-05 AC-T01-5 호환 (2026-05-21 이전 `MappingRow` 명칭)
export type MappingRow = ColBRow;

// 분류 결과
export interface SyncClassification {
  staying: Array<{
    member_id: string;
    sheetRow: number;
    nickname: string;
    payloadNickname: string;
  }>;
  leaving: Array<{
    member_id: string;
    sheetRow: number;
    nickname: string;
  }>;
  joining: Array<{
    member_id: string;
    nickname: string;
    synchro_level: number;
  }>;
}

// 닉네임 변경 감지 결과 (staying 행만 대상)
export interface NicknameChange {
  member_id: string;
  sheetRow: number;
  old: string;
  new: string;
}

// Col B 비어있을 때 마이그레이션 모드
export type SyncMode = "normal" | "first-run-backfill" | "empty-sheet";
