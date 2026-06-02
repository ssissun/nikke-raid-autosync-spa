// 유저스크립트 버전 비교 — feature 버전(X.Y.Z)만 비교하여 data-build(X.Y.Z.N) 갱신은 무시한다.
// CI 가 NIKKE 목록을 자동 갱신할 때 4번째 세그먼트(.N)만 올리므로, 그 경우엔 업그레이드 권장을 띄우지 않는다.

/** "2.4.6.3" → "2.4.6" (앞 3 세그먼트 = feature 버전). */
export function featureVersion(v: string): string {
  return v.split(".").slice(0, 3).join(".");
}

/**
 * 설치된 유저스크립트가 권장 feature 버전과 다르면 true (업그레이드 권장).
 * - detected=null(구버전, 버전 미보고) → true
 * - data-build 세그먼트(.N) 차이는 무시 → CI 자동 갱신은 권장 알림을 발생시키지 않음
 */
export function isUserscriptOutdated(detected: string | null, expected: string): boolean {
  if (detected === null) return true;
  return featureVersion(detected) !== expected;
}
