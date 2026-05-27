import { describe, expect, it, vi } from "vitest";
import { buildBackupValues, createBackupTab } from "./backup";

function okResponse(): Response {
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}

function alreadyExistsResponse(): Response {
  return new Response(
    JSON.stringify({
      error: { code: 400, message: "Sheet 'foo' already exists." },
    }),
    { status: 400 }
  );
}

function batchGetResponse(
  memberRows: string[][],
  statsRows: string[][]
): Response {
  return new Response(
    JSON.stringify({
      spreadsheetId: "sid",
      valueRanges: [
        { range: "유니온 멤버!A1:Z40", values: memberRows },
        { range: "레이드 통계!A1:P2000", values: statsRows },
      ],
    }),
    { status: 200 }
  );
}

// pruneOldBackupTabs 가 호출하는 sheets list — 최신 backup 1개만 (정리 대상 없음)
function listSheetsResponse(backupTabs: string[]): Response {
  const sheets = [
    { properties: { sheetId: 1, title: "유니온 멤버" } },
    { properties: { sheetId: 2, title: "레이드 통계" } },
    ...backupTabs.map((t, i) => ({
      properties: { sheetId: 100 + i, title: t },
    })),
  ];
  return new Response(JSON.stringify({ sheets }), { status: 200 });
}

describe("buildBackupValues", () => {
  it("16 컬럼 너비로 padding + 두 영역 라벨링", () => {
    const lines = buildBackupValues(
      "40",
      [["A", "B"], ["C", "D"]],
      [["E", "F"]]
    );
    // 헤더 + blank + "유니온 멤버" 라벨 + 2행 + blank + "레이드 통계" 라벨 + 1행 = 8 lines
    expect(lines.length).toBe(8);
    expect(lines[0][0]).toMatch(/^40차 backup - \d{4}-\d{2}-\d{2}/);
    expect(lines[2][0]).toBe("=== 유니온 멤버 ===");
    expect(lines[3]).toEqual([
      "A",
      "B",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
    ]);
    expect(lines[6][0]).toBe("=== 레이드 통계 ===");
  });
});

describe("createBackupTab — 4단계 (addSheet + batchGet + writeBackup)", () => {
  it("정상 생성 — addSheet → batchGet → writeBackup → pruneList 4 호출 (3개 이하 → 정리 skip)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse()) // addSheet
      .mockResolvedValueOnce(batchGetResponse([["가입 순서"]], [["회차"]])) // batchGet
      .mockResolvedValueOnce(okResponse()) // writeBackup
      .mockResolvedValueOnce(listSheetsResponse(["_backup_40"])); // pruneList — 1개만, 정리 대상 없음
    const name = await createBackupTab(
      "sid",
      "40",
      "tok",
      fetchMock as unknown as typeof fetch
    );
    expect(name).toBe("_backup_40");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const calls = fetchMock.mock.calls;
    expect(calls[0][0]).toMatch(/:batchUpdate$/);
    expect(calls[1][0]).toMatch(/values:batchGet/);
    expect(calls[2][1]?.method).toBe("PUT");
  });

  it("4개째 백업 생성 시 가장 오래된 백업 1개 삭제", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse()) // addSheet
      .mockResolvedValueOnce(batchGetResponse([], [])) // batchGet
      .mockResolvedValueOnce(okResponse()) // writeBackup
      .mockResolvedValueOnce(
        listSheetsResponse(["_backup_38", "_backup_39", "_backup_40", "_backup_41"])
      ) // pruneList — 4개, 38번 삭제 대상
      .mockResolvedValueOnce(okResponse()); // deleteSheet
    const result = await createBackupTab(
      "sid",
      "41",
      "tok",
      fetchMock as unknown as typeof fetch
    );
    expect(result).toBe("_backup_41");
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const deleteCall = fetchMock.mock.calls[4];
    const deleteBody = JSON.parse(deleteCall[1].body as string);
    expect(deleteBody.requests).toHaveLength(1);
    expect(deleteBody.requests[0].deleteSheet.sheetId).toBe(100); // _backup_38 (회차 가장 작음)
  });

  it("중복 시 _backup_{회차}_2 fallback (5 호출 — addSheet 1+1, batchGet, writeBackup, pruneList)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(alreadyExistsResponse()) // addSheet primary
      .mockResolvedValueOnce(okResponse()) // addSheet fallback
      .mockResolvedValueOnce(batchGetResponse([], [])) // batchGet
      .mockResolvedValueOnce(okResponse()) // writeBackup
      .mockResolvedValueOnce(listSheetsResponse(["_backup_40_2"])); // pruneList
    const name = await createBackupTab(
      "sid",
      "40",
      "tok",
      fetchMock as unknown as typeof fetch
    );
    expect(name).toBe("_backup_40_2");
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("_2도 ALREADY_EXISTS → throw, batchGet 호출 안 됨", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(alreadyExistsResponse())
      .mockResolvedValueOnce(alreadyExistsResponse());
    await expect(
      createBackupTab("sid", "40", "tok", fetchMock as unknown as typeof fetch)
    ).rejects.toThrow(/ALREADY_EXISTS/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("403 등 다른 오류 → BACKUP_TAB_FAILED throw", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 403 }));
    await expect(
      createBackupTab("sid", "40", "tok", fetchMock as unknown as typeof fetch)
    ).rejects.toThrow(/BACKUP_TAB_FAILED/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("batchGet 실패 → BACKUP_FETCH_FAILED throw", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse()) // addSheet 성공
      .mockResolvedValueOnce(new Response("{}", { status: 500 })); // batchGet 실패
    await expect(
      createBackupTab("sid", "40", "tok", fetchMock as unknown as typeof fetch)
    ).rejects.toThrow(/BACKUP_FETCH_FAILED/);
  });
});
