// auth 공개 API — F-03 picker, F-07 sheets 모듈이 import하는 진입점.

import { getAuthState, clearAuthState } from "./state";
import { initGIS, requestToken, revokeToken, getInitializedClientId } from "./gis";

export function isAuthenticated(): boolean {
  const s = getAuthState();
  if (!s.isAuthenticated) return false;
  if (typeof s.expiresAt !== "number") return false;
  return s.expiresAt > Date.now();
}

export function getAccessToken(): string | null {
  if (!isAuthenticated()) return null;
  return getAuthState().accessToken;
}

export function getTokenExpiry(): number | null {
  return getAuthState().expiresAt;
}

export function getEmail(): string | null {
  return getAuthState().email;
}

export function login(clientId?: string): void {
  if (clientId !== undefined && clientId !== getInitializedClientId()) {
    initGIS(clientId);
  }
  if (getInitializedClientId() === null) {
    throw new Error("clientId를 login() 첫 호출 시 전달해주세요");
  }
  requestToken(isAuthenticated() ? "" : "consent");
}

export async function logout(): Promise<void> {
  const token = getAccessToken();
  if (token !== null) {
    await revokeToken(token);
  } else {
    clearAuthState("logout");
  }
}

export { initGIS };

export type { AuthState, AuthStateChangeReason } from "../types";
