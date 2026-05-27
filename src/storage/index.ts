// 영속화 모듈 — localStorage 우선, 접근 실패 시 메모리 Map fallback.
// member_mapping은 ARCHITECTURE.md §1 (2026-05-22) 갱신 이후 시트 Col B가 SOT — 본 모듈은 캐시 역할.

import { STORAGE_KEYS, type StorageKey } from "./keys";

const sessionFallback = new Map<string, string>();

function safeGet(key: StorageKey): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return sessionFallback.get(key) ?? null;
  }
}

function safeSet(key: StorageKey, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    sessionFallback.set(key, value);
  }
}

function safeRemove(key: StorageKey): void {
  try {
    localStorage.removeItem(key);
  } catch {
    sessionFallback.delete(key);
  }
}

export function getSheetId(): string | null {
  return safeGet(STORAGE_KEYS.SHEET_ID);
}

export function getSheetName(): string | null {
  return safeGet(STORAGE_KEYS.SHEET_NAME);
}

export function saveSheetSelection(id: string, name: string): void {
  safeSet(STORAGE_KEYS.SHEET_ID, id);
  safeSet(STORAGE_KEYS.SHEET_NAME, name);
}

export function getMemberMapping(): Record<string, string> {
  const raw = safeGet(STORAGE_KEYS.MEMBER_MAPPING);
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
    console.warn("[NRA-SPA] member_mapping 손상 형식 — 빈 객체 반환");
    safeRemove(STORAGE_KEYS.MEMBER_MAPPING);
    return {};
  } catch {
    console.warn("[NRA-SPA] member_mapping JSON 손상 — 키 삭제 후 빈 객체 반환");
    safeRemove(STORAGE_KEYS.MEMBER_MAPPING);
    return {};
  }
}

export function saveMemberMapping(mapping: Record<string, string>): void {
  safeSet(STORAGE_KEYS.MEMBER_MAPPING, JSON.stringify(mapping));
}

export function clearStorage(): void {
  // 4 키 명시 — sheet_id, sheet_name, member_mapping, user_fingerprints
  try {
    localStorage.removeItem(STORAGE_KEYS.SHEET_ID);
    localStorage.removeItem(STORAGE_KEYS.SHEET_NAME);
    localStorage.removeItem(STORAGE_KEYS.MEMBER_MAPPING);
    localStorage.removeItem(STORAGE_KEYS.USER_FINGERPRINTS);
  } catch {
    // localStorage 접근 실패 — Map fallback 정리
  }
  sessionFallback.delete(STORAGE_KEYS.SHEET_ID);
  sessionFallback.delete(STORAGE_KEYS.SHEET_NAME);
  sessionFallback.delete(STORAGE_KEYS.MEMBER_MAPPING);
  sessionFallback.delete(STORAGE_KEYS.USER_FINGERPRINTS);
}

/**
 * 사용자가 옵트인으로 신뢰한 시트의 fingerprint hash 목록.
 * 코드 hardcoded BUILT_IN 과 합쳐 verifyFingerprint 의 allowed 로 사용.
 * 신뢰 다이얼로그에서 사용자 명시 동의 시에만 push.
 */
export function getUserFingerprints(): string[] {
  const raw = safeGet(STORAGE_KEYS.USER_FINGERPRINTS);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      safeRemove(STORAGE_KEYS.USER_FINGERPRINTS);
      return [];
    }
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    safeRemove(STORAGE_KEYS.USER_FINGERPRINTS);
    return [];
  }
}

export function addUserFingerprint(hash: string): void {
  const current = getUserFingerprints();
  if (current.includes(hash)) return;
  const updated = [...current, hash];
  safeSet(STORAGE_KEYS.USER_FINGERPRINTS, JSON.stringify(updated));
}
