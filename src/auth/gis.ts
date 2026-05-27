// GIS (Google Identity Services) tokenClient — drive.file + userinfo.email scope.
// 둘 다 non-sensitive — OAuth verification 면제.

import { clearAuthState, setAuthState } from "./state";

const SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

async function fetchUserEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { email?: string };
    return typeof data.email === "string" ? data.email : null;
  } catch {
    return null;
  }
}

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            callback: (resp: GoogleTokenResponse) => void;
            error_callback?: (err: GoogleTokenError) => void;
          }) => GoogleTokenClient;
          revoke: (token: string, callback: () => void) => void;
        };
      };
    };
  }
}

interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  scope: string;
  token_type: "Bearer";
  error?: string;
}

interface GoogleTokenError {
  type: string;
  message?: string;
}

interface GoogleTokenClient {
  requestAccessToken: (overrides?: { prompt?: "" | "consent" | "select_account" }) => void;
}

let tokenClient: GoogleTokenClient | null = null;
let currentClientId: string | null = null;

function isGisLoaded(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.google !== "undefined" &&
    typeof window.google.accounts?.oauth2?.initTokenClient === "function"
  );
}

export function initGIS(clientId: string): void {
  if (!isGisLoaded()) {
    throw new Error("GIS SDK not loaded — index.html script 태그 확인 필요");
  }
  if (clientId.length === 0) {
    throw new Error("clientId 비어있음 — config.ts GOOGLE_CLIENT_ID 확인");
  }

  tokenClient = window.google!.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPES,
    callback: (resp) => {
      if (resp.error !== undefined || resp.access_token === undefined) {
        clearAuthState("error");
        return;
      }
      const expiresAt = Date.now() + resp.expires_in * 1000;
      // 우선 token 만 저장 (UI 즉시 응답) → userinfo 비동기 fetch 후 email 갱신
      setAuthState(
        {
          isAuthenticated: true,
          accessToken: resp.access_token,
          expiresAt,
          email: null,
        },
        "login"
      );
      void fetchUserEmail(resp.access_token).then((email) => {
        if (email !== null) {
          setAuthState(
            {
              isAuthenticated: true,
              accessToken: resp.access_token,
              expiresAt,
              email,
            },
            "login"
          );
        }
      });
    },
    error_callback: (err) => {
      console.warn("[NRA-SPA] GIS error_callback", err);
      clearAuthState("error");
    },
  });
  currentClientId = clientId;
}

export function requestToken(prompt: "" | "consent" | "select_account" = ""): void {
  if (tokenClient === null) {
    throw new Error("initGIS()를 먼저 호출해주세요");
  }
  tokenClient.requestAccessToken({ prompt });
}

export function revokeToken(accessToken: string): Promise<void> {
  return new Promise((resolve) => {
    if (!isGisLoaded()) {
      clearAuthState("logout");
      resolve();
      return;
    }
    window.google!.accounts.oauth2.revoke(accessToken, () => {
      clearAuthState("logout");
      resolve();
    });
  });
}

export function getInitializedClientId(): string | null {
  return currentClientId;
}
