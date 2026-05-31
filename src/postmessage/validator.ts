// F-NRA-002-04 origin + payload validator — Wave A 의존 (실 유저스크립트는 blablalink.com 서브도메인에서 송신).
// SOT: ai_docs/nikke-raid-autosync/API_SPEC.md §2 / CONSTRAINTS.md §2.

import type { NikkeRaidPayload } from "../types";

// blablalink.com의 직접 서브도메인만 허용 (예: tools.blablalink.com, www.blablalink.com). 다단계 서브도메인 차단.
export const ALLOWED_ORIGIN_PATTERN = /^https:\/\/[^.]+\.blablalink\.com$/;

export function isAllowedOrigin(origin: string): boolean {
  return ALLOWED_ORIGIN_PATTERN.test(origin);
}

function isStringField(obj: Record<string, unknown>, key: string): boolean {
  return typeof obj[key] === "string";
}

export function validateNikkeRaidPayload(data: unknown): data is NikkeRaidPayload {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (!isStringField(obj, "type")) return false;
  if (!isStringField(obj, "capturedAt")) return false;

  switch (obj.type) {
    case "nikke-raid-data":
      // raidNum은 ARCHITECTURE §3.1에서 optional. 유저스크립트가
      // GetUnionRaidLevelInfo를 capture 못 한 경우 null이 들어올 수 있음.
      return (
        Array.isArray(obj.raid) &&
        Array.isArray(obj.members) &&
        (obj.raidNum === undefined ||
          obj.raidNum === null ||
          isStringField(obj, "raidNum"))
      );
    case "nikke-raid-multi":
      // v2.4.0+ 다회차. rounds 각 항목 얕은 검증.
      return (
        Array.isArray(obj.members) &&
        Array.isArray(obj.availableRaidNums) &&
        Array.isArray(obj.rounds) &&
        (obj.rounds as unknown[]).every((r) => {
          if (typeof r !== "object" || r === null) return false;
          const rr = r as Record<string, unknown>;
          return (
            typeof rr.raidNum === "string" &&
            Array.isArray(rr.raid) &&
            typeof rr.memberSyncroLevels === "object" &&
            rr.memberSyncroLevels !== null
          );
        })
      );
    case "need-login":
      return true;
    case "no-data":
      return isStringField(obj, "reason");
    case "error":
      return typeof obj.error === "object" && obj.error !== null;
    default:
      return false;
  }
}
