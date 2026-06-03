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

// 회차 1개 분량 데이터 (다회차 payload 의 구성 단위)
export interface RaidRoundData {
  raidNum: string; // "40" (숫자 문자열, 라벨 아님)
  raid: ProcessedRaidRow[]; // 이 회차 row (index 0 라벨 = `${raidNum}차`)
  // 레이드 당시 싱크로 레벨 — member_id → 그 회차 squad 최고 니케 lv (userscript 계산).
  // 미참여/탈퇴 멤버는 없음 → SPA 가 fallback(현재 synchro).
  memberSyncroLevels: Record<string, number>;
  // 전체 참가자(닉네임 기준) 그 회차 squad 최고 lv — 탈퇴자 레벨 기록용 (userscript v2.4.3+).
  // 구버전 userscript payload 에는 없을 수 있음(optional).
  levelsByNickname?: Record<string, number>;
}

export type NikkeRaidPayload =
  | {
      type: "nikke-raid-data"; // 레거시 단일 (하위호환)
      raidNum?: string | null; // GetUnionRaidLevelInfo 미캡처 시 null/undefined
      capturedAt: string;
      raid: ProcessedRaidRow[];
      members: GuildMember[];
      meta: { guildId: string; areaId: string };
    }
  | {
      type: "nikke-raid-multi"; // 다회차 (v2.4.0+)
      capturedAt: string;
      availableRaidNums: string[]; // 실제 데이터 있는 fetch 성공 회차 (오름차순)
      rounds: RaidRoundData[];
      members: GuildMember[]; // 현재 멤버 (auto-sync / 매칭 기준)
      meta: { guildId: string; areaId: string };
    }
  | { type: "need-login"; capturedAt: string }
  | { type: "no-data"; capturedAt: string; reason: string }
  | {
      type: "error";
      capturedAt: string;
      error: { code: number; msg: string };
    };

// 수집 진행 미러링 메시지 (유저스크립트 → SPA).
// NikkeRaidPayload union과 분리 — 진행은 캡처 중 다회 발생, 데이터 payload는 완료 시 1회.
export interface NraProgressMessage {
  type: "nra-progress";
  captured: number; // 현재 캡처 수 (0~2)
  total: 2; // 핵심 캡처 분모 (raid + members)
  statusText: string; // 회차 등 부가 상태
  scriptVersion: string;
}

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
