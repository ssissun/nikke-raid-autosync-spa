import { afterEach, describe, expect, it, vi } from "vitest";
import { handleMessage } from "./handler";
import { isProgressMessage } from "./validator";

const ALLOWED_ORIGIN = "https://www.blablalink.com";

function progressMsg(over: Record<string, unknown> = {}): unknown {
  return {
    type: "nra-progress",
    captured: 1,
    total: 2,
    statusText: "회차 데이터 수집 중... (3개)",
    scriptVersion: "2.5.0",
    ...over,
  };
}

describe("isProgressMessage", () => {
  it("TS-1: 정상 진행 메시지 → true", () => {
    expect(isProgressMessage(progressMsg())).toBe(true);
  });

  it("TS-5: captured 타입 오류 → false", () => {
    expect(isProgressMessage(progressMsg({ captured: "x" }))).toBe(false);
  });

  it("total !== 2 → false (분모 고정)", () => {
    expect(isProgressMessage(progressMsg({ total: 4 }))).toBe(false);
  });

  it("null / 비객체 → false", () => {
    expect(isProgressMessage(null)).toBe(false);
    expect(isProgressMessage("nra-progress")).toBe(false);
  });
});

describe("handleMessage — 진행 가로채기", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("TS-2: 진행 메시지 → nraProgressUpdated dispatch, payload 경로 미진입", () => {
    let progressDetail: { captured: number; total: number } | null = null;
    let payloadFired = false;
    const onProgress = (e: Event): void => {
      progressDetail = (e as CustomEvent).detail;
    };
    const onPayload = (): void => {
      payloadFired = true;
    };
    window.addEventListener("nraProgressUpdated", onProgress);
    window.addEventListener("payloadReceived", onPayload);
    try {
      handleMessage(
        new MessageEvent("message", {
          origin: ALLOWED_ORIGIN,
          data: progressMsg({ captured: 2 }),
        })
      );
    } finally {
      window.removeEventListener("nraProgressUpdated", onProgress);
      window.removeEventListener("payloadReceived", onPayload);
    }
    expect(progressDetail).toMatchObject({ captured: 2, total: 2 });
    expect(payloadFired).toBe(false);
  });

  it("TS-3: 정상 payload(nikke-raid-multi) → payloadReceived, 진행 이벤트 미발생 (회귀)", () => {
    let payloadFired = false;
    let progressFired = false;
    const onPayload = (): void => {
      payloadFired = true;
    };
    const onProgress = (): void => {
      progressFired = true;
    };
    window.addEventListener("payloadReceived", onPayload);
    window.addEventListener("nraProgressUpdated", onProgress);
    try {
      handleMessage(
        new MessageEvent("message", {
          origin: ALLOWED_ORIGIN,
          data: {
            type: "nikke-raid-multi",
            capturedAt: "2026-06-03T00:00:00+09:00",
            availableRaidNums: ["40"],
            members: [],
            rounds: [{ raidNum: "40", raid: [], memberSyncroLevels: {} }],
            meta: { guildId: "g", areaId: "a" },
          },
        })
      );
    } finally {
      window.removeEventListener("payloadReceived", onPayload);
      window.removeEventListener("nraProgressUpdated", onProgress);
    }
    expect(payloadFired).toBe(true);
    expect(progressFired).toBe(false);
  });

  it("TS-4: 비허용 origin → 진행 이벤트 차단", () => {
    let progressFired = false;
    const onProgress = (): void => {
      progressFired = true;
    };
    window.addEventListener("nraProgressUpdated", onProgress);
    try {
      handleMessage(
        new MessageEvent("message", {
          origin: "https://evil.com",
          data: progressMsg(),
        })
      );
    } finally {
      window.removeEventListener("nraProgressUpdated", onProgress);
    }
    expect(progressFired).toBe(false);
  });
});
