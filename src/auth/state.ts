// AuthState — 메모리 + sessionStorage 보관. localStorage는 비보관 (CONSTRAINTS §3).
// 새로고침 생존 + 탭 종료 시 자동 소멸.

import type { AuthState, AuthStateChangeReason } from "../types";

const SESSION_KEY = "nikke_spa_auth_session";

let current: AuthState = {
  isAuthenticated: false,
  accessToken: null,
  expiresAt: null,
  email: null,
};

let expiryTimer: ReturnType<typeof setTimeout> | null = null;

function restoreFromSession(): void {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (raw === null) return;
    const parsed = JSON.parse(raw) as AuthState;
    if (
      parsed.isAuthenticated &&
      typeof parsed.expiresAt === "number" &&
      parsed.expiresAt > Date.now()
    ) {
      current = parsed;
    } else {
      sessionStorage.removeItem(SESSION_KEY);
    }
  } catch {
    // 손상된 sessionStorage 데이터 — 무시 후 초기화
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      // sessionStorage 자체 접근 실패는 무시
    }
  }
}

function persistToSession(): void {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(current));
  } catch {
    // private/locked storage 환경 — 메모리만 사용
  }
}

function dispatchAuthEvent(reason: AuthStateChangeReason): void {
  window.dispatchEvent(
    new CustomEvent("authStateChange", {
      detail: { reason, state: { ...current } },
    })
  );
}

export function getAuthState(): AuthState {
  return { ...current };
}

export function setAuthState(next: AuthState, reason: AuthStateChangeReason): void {
  current = { ...next };
  persistToSession();

  if (expiryTimer !== null) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }

  if (
    current.isAuthenticated &&
    typeof current.expiresAt === "number" &&
    current.expiresAt > Date.now()
  ) {
    const delay = Math.max(0, current.expiresAt - Date.now() - 60_000);
    expiryTimer = setTimeout(() => {
      clearAuthState("expired");
    }, delay);
  }

  dispatchAuthEvent(reason);
}

export function clearAuthState(reason: AuthStateChangeReason = "logout"): void {
  current = {
    isAuthenticated: false,
    accessToken: null,
    expiresAt: null,
    email: null,
  };
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // 접근 실패 무시
  }
  if (expiryTimer !== null) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }
  dispatchAuthEvent(reason);
}

restoreFromSession();
