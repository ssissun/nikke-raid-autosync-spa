import { describe, expect, it, vi } from "vitest";
import { writeRaidData } from "./index";
import type { BatchUpdatePlan } from "../dryrun/calculator";

function buildPlan(): BatchUpdatePlan {
  return {
    raidNum: "5",
    backupTabName: "_backup_5",
    raidStatsRange: "레이드 통계!A2:P2",
    raidStatsRows: [
      [
        "5차",
        "닉",
        "보스",
        "1",
        "u1",
        "0",
        "u2",
        "0",
        "u3",
        "0",
        "u4",
        "0",
        "u5",
        "0",
        "100",
        "",
      ],
    ],
    memberSyncroUpdates: [],
    syncroColumn: "H",
    unmatchedNames: [],
    isConfirmable: true,
  };
}

describe("writeRaidData facade", () => {
  it("성공 시 sheetsWriteComplete 이벤트 발생 + 3단계 progress", async () => {
    const target = new EventTarget();
    const events: string[] = [];
    target.addEventListener("sheetsWriteProgress", (e) => {
      const detail = (e as CustomEvent).detail as { stage: string; status: string };
      events.push(`${detail.stage}:${detail.status}`);
    });
    let completed = false;
    let completeDetail: { raidNum: string; backupTabName: string } | null = null;
    target.addEventListener("sheetsWriteComplete", (e) => {
      completed = true;
      completeDetail = (e as CustomEvent).detail as {
        raidNum: string;
        backupTabName: string;
      };
    });

    // fetch mock: backup 3단계 (addSheet + batchGet + writePUT) + batchUpdate OK
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 200 })) // backup addSheet
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            spreadsheetId: "sid",
            valueRanges: [
              { range: "유니온 멤버!A1:Z40", values: [["가입 순서"]] },
              { range: "레이드 통계!A1:P2000", values: [["회차"]] },
            ],
          }),
          { status: 200 }
        )
      ) // backup batchGet
      .mockResolvedValueOnce(new Response("{}", { status: 200 })) // backup writePUT
      .mockResolvedValueOnce(new Response("{}", { status: 200 })); // batchUpdate

    const result = await writeRaidData("sid", buildPlan(), "tok", {
      fetchImpl: fetchMock as unknown as typeof fetch,
      skipFingerprint: true,
      syncroColumn: "H",
      eventTarget: target,
    });

    expect(result.backupTabName).toBe("_backup_5");
    expect(completed).toBe(true);
    expect(completeDetail).not.toBeNull();
    expect(completeDetail!.raidNum).toBe("5");
    expect(events).toEqual([
      "fingerprint:running",
      "fingerprint:done",
      "backup:running",
      "backup:done",
      "batchUpdate:running",
      "batchUpdate:done",
    ]);
  });
});
