import { describe, expect, it, vi } from "vitest";
import { executeBatchUpdate } from "./batch-update";
import type { BatchUpdatePlan } from "../dryrun/calculator";

function buildPlan(): BatchUpdatePlan {
  return {
    raidNum: "5",
    backupTabName: "_backup_5",
    raidStatsRange: "레이드 통계!A100:P101",
    raidStatsRows: [
      [
        "5차",
        "닉",
        "보스",
        "1",
        "유닛1",
        "0",
        "유닛2",
        "0",
        "유닛3",
        "0",
        "유닛4",
        "0",
        "유닛5",
        "0",
        "12345",
        "",
      ],
    ],
    memberSyncroUpdates: [
      { sheetRow: 2, syncroLevel: 420, column: "H" },
      { sheetRow: 3, syncroLevel: 415, column: "H" },
    ],
    syncroColumn: "H",
    unmatchedNames: [],
    isConfirmable: true,
  };
}

describe("executeBatchUpdate", () => {
  it("정상 — 1회 fetch + 200 응답", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await executeBatchUpdate("sid", buildPlan(), "tok", {
      fetchImpl: fetchMock as unknown as typeof fetch,
      syncroColumn: "H",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // body 검증 — 두 영역 ValueRange
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.valueInputOption).toBe("USER_ENTERED");
    expect(body.data).toHaveLength(2);
    expect(body.data[0].range).toBe("레이드 통계!A100:P101");
    expect(body.data[1].range).toBe("유니온 멤버!H2:H3");
  });

  it("429 → 재시도 후 성공 (rateLimitDelayMs=0 으로 즉시)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 429 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await executeBatchUpdate("sid", buildPlan(), "tok", {
      fetchImpl: fetchMock as unknown as typeof fetch,
      rateLimitDelayMs: 0,
      syncroColumn: "H",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("429 재시도 후에도 429 → RATE_LIMIT throw", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 429 }))
      .mockResolvedValueOnce(new Response("{}", { status: 429 }));
    await expect(
      executeBatchUpdate("sid", buildPlan(), "tok", {
        fetchImpl: fetchMock as unknown as typeof fetch,
        rateLimitDelayMs: 0,
        syncroColumn: "H",
      })
    ).rejects.toThrow(/RATE_LIMIT/);
  });

  it("raidStatsRows + memberSyncroUpdates 둘 다 빈 → EMPTY_PLAN throw", async () => {
    const plan = {
      ...buildPlan(),
      raidStatsRows: [],
      memberSyncroUpdates: [],
    };
    await expect(
      executeBatchUpdate("sid", plan, "tok", {
        fetchImpl: vi.fn() as unknown as typeof fetch,
        syncroColumn: "H",
      })
    ).rejects.toThrow(/EMPTY_PLAN/);
  });
});
