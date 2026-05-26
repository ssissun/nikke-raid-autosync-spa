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
  it("정상 생성 — addSheet → batchGet → writeBackup 3 호출", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse()) // addSheet
      .mockResolvedValueOnce(batchGetResponse([["가입 순서"]], [["회차"]])) // batchGet
      .mockResolvedValueOnce(okResponse()); // writeBackup
    const name = await createBackupTab(
      "sid",
      "40",
      "tok",
      fetchMock as unknown as typeof fetch
    );
    expect(name).toBe("_backup_40");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const calls = fetchMock.mock.calls;
    // addSheet
    expect(calls[0][0]).toMatch(/:batchUpdate$/);
    // batchGet
    expect(calls[1][0]).toMatch(/values:batchGet/);
    // writeBackup PUT
    expect(calls[2][1]?.method).toBe("PUT");
  });

  it("중복 시 _backup_{회차}_2 fallback (4 호출)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(alreadyExistsResponse()) // addSheet primary
      .mockResolvedValueOnce(okResponse()) // addSheet fallback
      .mockResolvedValueOnce(batchGetResponse([], [])) // batchGet
      .mockResolvedValueOnce(okResponse()); // writeBackup
    const name = await createBackupTab(
      "sid",
      "40",
      "tok",
      fetchMock as unknown as typeof fetch
    );
    expect(name).toBe("_backup_40_2");
    expect(fetchMock).toHaveBeenCalledTimes(4);
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
