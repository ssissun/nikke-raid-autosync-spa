import { describe, expect, it, vi } from "vitest";
import { computeFingerprint, verifyFingerprint } from "./fingerprint";

function mockBatchGetResponse(
  memberHeader: string[],
  raidStatsHeader: string[]
): Response {
  return new Response(
    JSON.stringify({
      spreadsheetId: "sid",
      valueRanges: [
        { range: "유니온 멤버!A1:Z1", values: [memberHeader] },
        { range: "레이드 통계!A1:P1", values: [raidStatsHeader] },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

describe("computeFingerprint (option B)", () => {
  it("동일 헤더 → 동일 hash (결정적)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockBatchGetResponse(["가입 순서", "member_id", "닉네임", "1차"], ["회차", "닉네임"]))
      .mockResolvedValueOnce(mockBatchGetResponse(["가입 순서", "member_id", "닉네임", "1차"], ["회차", "닉네임"]));

    const fp1 = await computeFingerprint("sid", "tok", fetchMock as unknown as typeof fetch);
    const fp2 = await computeFingerprint("sid", "tok", fetchMock as unknown as typeof fetch);
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("도구 추가 컬럼(member_id) 제외 — 마스터 원본만 hash", async () => {
    const withTool = mockBatchGetResponse(
      ["가입 순서", "member_id", "닉네임"],
      ["회차"]
    );
    const withoutTool = mockBatchGetResponse(["가입 순서", "닉네임"], ["회차"]);

    const fpWith = await computeFingerprint(
      "sid",
      "tok",
      vi.fn().mockResolvedValue(withTool) as unknown as typeof fetch
    );
    const fpWithout = await computeFingerprint(
      "sid",
      "tok",
      vi.fn().mockResolvedValue(withoutTool) as unknown as typeof fetch
    );
    expect(fpWith).toBe(fpWithout);
  });

  it("헤더 행 비어있음 → FINGERPRINT_READ_FAILED", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockBatchGetResponse([], []));
    await expect(
      computeFingerprint("sid", "tok", fetchMock as unknown as typeof fetch)
    ).rejects.toThrow(/FINGERPRINT_READ_FAILED/);
  });
});

describe("verifyFingerprint", () => {
  it("허용 목록에 없으면 FINGERPRINT_MISMATCH throw", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        mockBatchGetResponse(["가입 순서", "닉네임"], ["회차"])
      );
    await expect(
      verifyFingerprint("sid", "tok", {
        allowed: [],
        fetchImpl: fetchMock as unknown as typeof fetch,
      })
    ).rejects.toThrow(/FINGERPRINT_MISMATCH/);
  });

  it("skip=true 면 'SKIPPED' 반환 (네트워크 호출 없음)", async () => {
    const fetchMock = vi.fn();
    const result = await verifyFingerprint("sid", "tok", {
      skip: true,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(result).toBe("SKIPPED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("허용 목록에 있으면 hex 반환", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        mockBatchGetResponse(["가입 순서", "닉네임"], ["회차"])
      );
    const computed = await computeFingerprint(
      "sid",
      "tok",
      vi.fn().mockResolvedValueOnce(
        mockBatchGetResponse(["가입 순서", "닉네임"], ["회차"])
      ) as unknown as typeof fetch
    );
    const verified = await verifyFingerprint("sid", "tok", {
      allowed: [computed],
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(verified).toBe(computed);
  });
});
