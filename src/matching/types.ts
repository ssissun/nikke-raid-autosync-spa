// F-NRA-002-05 매칭 타입.
// member_id 저장 위치: 유니온 멤버 원본 레이아웃 유지를 위해 별도 `_nra_member_mapping` 탭(행 1:1 정렬).
// (유니온 멤버 Col B 삽입 방식은 마스터 Apps Script/수식 호환성을 깨뜨려 폐기 — 구버그 시트는 역마이그레이션.)
// SOT: ai_docs/nikke-raid-autosync/SHEET_SCHEMA.md §2 / API_SPEC.md §2.1

// 유니온 멤버 한 멤버 (가입순서/닉네임은 원본 시트, member_id 는 매핑 탭에서 결합)
export interface ColBRow {
  joined_order: number; // 유니온 멤버 Col A, 1-based
  member_id: string; // _nra_member_mapping 탭, 불변 키 — 공백이면 매핑 미설정
  nickname: string; // 유니온 멤버 Col B, 표시용
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
