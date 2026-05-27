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

// 모든 탭이 grid 충분한 상태 mock (rowCount/columnCount 큼)
function gridSufficientResponse(): Response {
  return new Response(
    JSON.stringify({
      sheets: [
        {
          properties: {
            sheetId: 1,
            title: "레이드 통계",
            gridProperties: { rowCount: 1000, columnCount: 16 },
          },
        },
        {
          properties: {
            sheetId: 2,
            title: "유니온 멤버",
            gridProperties: { rowCount: 33, columnCount: 26 },
          },
        },
      ],
    }),
    { status: 200 }
  );
}

describe("executeBatchUpdate", () => {
  it("정상 — grid 확장 2번(레이드 통계+유니온 멤버) + batchUpdate 1", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(gridSufficientResponse()) // 레이드 통계 grid info
      .mockResolvedValueOnce(gridSufficientResponse()) // 유니온 멤버 grid info
      .mockResolvedValueOnce(new Response("{}", { status: 200 })); // batchUpdate
    await executeBatchUpdate("sid", buildPlan(), "tok", {
      fetchImpl: fetchMock as unknown as typeof fetch,
      syncroColumn: "H",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const buBody = JSON.parse(String(fetchMock.mock.calls[2][1].body));
    expect(buBody.valueInputOption).toBe("USER_ENTERED");
    expect(buBody.data).toHaveLength(2);
    expect(buBody.data[0].range).toBe("레이드 통계!A100:P101");
    expect(buBody.data[1].range).toBe("유니온 멤버!H2:H3");
  });

  it("429 → 재시도 후 성공 (grid 확장 2 + batchUpdate 2)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(gridSufficientResponse())
      .mockResolvedValueOnce(gridSufficientResponse())
      .mockResolvedValueOnce(new Response("{}", { status: 429 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await executeBatchUpdate("sid", buildPlan(), "tok", {
      fetchImpl: fetchMock as unknown as typeof fetch,
      rateLimitDelayMs: 0,
      syncroColumn: "H",
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("429 재시도 후에도 429 → RATE_LIMIT throw", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(gridSufficientResponse())
      .mockResolvedValueOnce(gridSufficientResponse())
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
