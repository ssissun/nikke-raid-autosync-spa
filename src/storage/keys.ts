// localStorage 키 상수 — `nikke_spa_*` prefix로 cross-site 충돌 회피.

export const STORAGE_KEYS = {
  SHEET_ID: "nikke_spa_sheet_id",
  SHEET_NAME: "nikke_spa_sheet_name",
  MEMBER_MAPPING: "nikke_spa_member_mapping",
} as const;

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];
