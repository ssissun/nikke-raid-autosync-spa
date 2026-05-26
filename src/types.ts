// 공통 TypeScript 타입 — SOT: ai_docs/nikke-raid-autosync/{ARCHITECTURE,API_SPEC,SHEET_SCHEMA}.md

// ─────────────────────────────────────────────────────────
// postMessage payload (유저스크립트 → SPA)
// SOT: API_SPEC.md §2 / ARCHITECTURE.md §3.1
// ─────────────────────────────────────────────────────────

export interface GuildMember {
  member_id: string; // uint64 as string, 불변 매칭 키 (16-20자리)
  nickname: string;
  synchro_level: number; // ⭐ 시트 Col D+에 기록
  commander_level: number; // 사령관 레벨 (raw API: `level`)
  icon_id: string;
}

// 16-col raid row (헤드리스 — header row 미포함, F-NRA-001 C01 정정 후)
export type ProcessedRaidRow = [
  string, // 0: raidLabel (예: "40차")
  string, // 1: nickname
  string, // 2: bossName (ko)
  number, // 3: step
  string, // 4: unit1 name
  number, // 5: unit1 break
  string, // 6: unit2 name
  number, // 7: unit2 break
  string, // 8: unit3 name
  number, // 9: unit3 break
  string, // 10: unit4 name
  number, // 11: unit4 break
  string, // 12: unit5 name
  number, // 13: unit5 break
  string, // 14: totalDamage (bigint as string)
  "O" | "" // 15: finalHit (마지막 타격)
];

export type NikkeRaidPayload =
  | {
      type: "nikke-raid-data";
      raidNum: string;
      capturedAt: string;
      raid: ProcessedRaidRow[];
      members: GuildMember[];
      meta: { guildId: string; areaId: string };
    }
  | { type: "need-login"; capturedAt: string }
  | { type: "no-data"; capturedAt: string; reason: string }
  | {
      type: "error";
      capturedAt: string;
      error: { code: number; msg: string };
    };

// ─────────────────────────────────────────────────────────
// F-NRA-002-02 OAuth (GIS + drive.file)
// SOT: ARCHITECTURE.md §5 / CONSTRAINTS.md §3
// ─────────────────────────────────────────────────────────

export interface AuthState {
  isAuthenticated: boolean;
  accessToken: string | null;
  expiresAt: number | null; // epoch ms
  email: string | null;
}

export type AuthStateChangeReason = "login" | "logout" | "expired" | "error";

export interface AuthStateChangeEventDetail {
  reason: AuthStateChangeReason;
  state: AuthState;
}
