import { describe, expect, it, vi } from "vitest";
import { createBackupTab } from "./backup";

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

describe("createBackupTab", () => {
  it("정상 생성 — _backup_{회차} 반환", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okResponse());
    const name = await createBackupTab(
      "sid",
      "5",
      "tok",
      fetchMock as unknown as typeof fetch
    );
    expect(name).toBe("_backup_5");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("중복 시 _backup_{회차}_2 fallback", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(alreadyExistsResponse())
      .mockResolvedValueOnce(okResponse());
    const name = await createBackupTab(
      "sid",
      "5",
      "tok",
      fetchMock as unknown as typeof fetch
    );
    expect(name).toBe("_backup_5_2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("_2도 실패 → 에러 throw", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(alreadyExistsResponse())
      .mockResolvedValueOnce(alreadyExistsResponse());
    await expect(
      createBackupTab("sid", "5", "tok", fetchMock as unknown as typeof fetch)
    ).rejects.toThrow(/ALREADY_EXISTS/);
  });

  it("403 등 다른 오류 → BACKUP_TAB_FAILED throw", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 403 }));
    await expect(
      createBackupTab("sid", "5", "tok", fetchMock as unknown as typeof fetch)
    ).rejects.toThrow(/BACKUP_TAB_FAILED/);
  });
});
