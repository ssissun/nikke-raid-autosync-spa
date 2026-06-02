import { describe, it, expect } from "vitest";
import { featureVersion, isUserscriptOutdated } from "./version";

describe("featureVersion", () => {
  it("앞 3 세그먼트만 반환", () => {
    expect(featureVersion("2.4.6")).toBe("2.4.6");
    expect(featureVersion("2.4.6.1")).toBe("2.4.6");
    expect(featureVersion("2.4.6.12")).toBe("2.4.6");
  });
});

describe("isUserscriptOutdated", () => {
  const EXPECTED = "2.4.6";

  it("data-build(.N) 차이는 최신으로 간주 → false (플로터 미발생)", () => {
    expect(isUserscriptOutdated("2.4.6", EXPECTED)).toBe(false);
    expect(isUserscriptOutdated("2.4.6.1", EXPECTED)).toBe(false);
    expect(isUserscriptOutdated("2.4.6.99", EXPECTED)).toBe(false);
  });

  it("feature 버전이 다르면 true (업그레이드 권장)", () => {
    expect(isUserscriptOutdated("2.4.5", EXPECTED)).toBe(true);
    expect(isUserscriptOutdated("2.4.5.3", EXPECTED)).toBe(true);
    expect(isUserscriptOutdated("2.3.0", EXPECTED)).toBe(true);
  });

  it("버전 미보고(null) → true", () => {
    expect(isUserscriptOutdated(null, EXPECTED)).toBe(true);
  });
});
