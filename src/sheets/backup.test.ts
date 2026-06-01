import { describe, expect, it, vi } from "vitest";
import { buildBackupValues, createBackupTab } from "./backup";

// stateful URL-aware fetch mock — createBackupTab 의 실제 호출 흐름을 반영:
//   listAllSheets(GET ?fields, 이름 결정) → addSheet(POST :batchUpdate)
//   → batchGet(GET values:batchGet) → writeBackup(PUT values/)
//   → pruneOldBackupTabs(GET ?fields, 필요 시 deleteSheet POST :batchUpdate)
// addSheet 가 sheets 목록에 즉시 반영되어 prune 단계의 두 번째 ?fields 가 정확.
function makeFetch(
  initialBackups: string[],
  opts: { addFailStatus?: number; addFailCount?: number; batchGetFail?: boolean } = {}
) {
  const sheets: Array<{ properties: { sheetId: number; title: string } }> = [
    { properties: { sheetId: 1, title: "유니온 멤버" } },
    { properties: { sheetId: 2, title: "레이드 통계" } },
    ...initialBackups.map((t, i) => ({
      properties: { sheetId: 100 + i, title: t },
    })),
  ];
  let nextId = 200;
  let addCallCount = 0;
  const addedTitles: string[] = [];
  const deletedIds: number[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const u = decodeURIComponent(String(url));
    if (u.includes("fields=sheets(properties(sheetId,title))")) {
      return new Response(JSON.stringify({ sheets }), { status: 200 });
    }
    if (u.endsWith(":batchUpdate") && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      const req = body.requests?.[0];
      if (req?.addSheet) {
        addCallCount++;
        // 첫 addFailCount 회 호출은 지정 status 로 실패 (ko 메시지로 — 파싱 의존 안 함 검증)
        if (opts.addFailStatus && addCallCount <= (opts.addFailCount ?? 0)) {
          return new Response(
            JSON.stringify({ error: { message: "이미 있습니다" } }),
            { status: opts.addFailStatus }
          );
        }
        const title = req.addSheet.properties.title;
        addedTitles.push(title);
        sheets.push({ properties: { sheetId: nextId++, title } });
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (req?.deleteSheet) {
        for (const r of body.requests) deletedIds.push(r.deleteSheet.sheetId);
        return new Response(JSON.stringify({}), { status: 200 });
      }
    }
    if (u.includes("/values:batchGet")) {
      if (opts.batchGetFail) return new Response("{}", { status: 500 });
      return new Response(
        JSON.stringify({ valueRanges: [{ values: [["a"]] }, { values: [["b"]] }] }),
        { status: 200 }
      );
    }
    if (u.includes("/values/") && init?.method === "PUT") {
      return new Response(JSON.stringify({}), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });
  return {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    addedTitles,
    deletedIds,
  };
}

// 신규 백업탭 이름 패턴: _backup_YYYYMMDD-HHmmss
const TS = /^_backup_\d{8}-\d{6}$/;

describe("buildBackupValues", () => {
  it("16 컬럼 너비로 padding + 라벨 헤더 + 두 영역 라벨링", () => {
    const lines = buildBackupValues("백업 - 2026-06-01 15:30:45", [["A", "B"], ["C", "D"]], [["E", "F"]]);
    // 헤더 + blank + "유니온 멤버" 라벨 + 2행 + blank + "레이드 통계" 라벨 + 1행 = 8 lines
    expect(lines.length).toBe(8);
    expect(lines[0][0]).toBe("백업 - 2026-06-01 15:30:45");
    expect(lines[2][0]).toBe("=== 유니온 멤버 ===");
    expect(lines[3]).toEqual(["A", "B", "", "", "", "", "", "", "", "", "", "", "", "", "", ""]);
    expect(lines[6][0]).toBe("=== 레이드 통계 ===");
  });
});

describe("createBackupTab — 회차 무관 시각 기반 이름", () => {
  it("회차와 무관하게 _backup_{시각} 생성", async () => {
    const { fetchImpl, addedTitles } = makeFetch([]);
    const name = await createBackupTab("sid", "tok", fetchImpl);
    expect(name).toMatch(TS);
    expect(addedTitles).toHaveLength(1);
    expect(addedTitles[0]).toMatch(TS);
  });

  it("같은 초 충돌(400) → 이름 뒤 _2 붙여 재시도 후 성공", async () => {
    const { fetchImpl, addedTitles } = makeFetch([], {
      addFailStatus: 400,
      addFailCount: 1,
    });
    const name = await createBackupTab("sid", "tok", fetchImpl);
    expect(name).toMatch(/^_backup_\d{8}-\d{6}_2$/);
    expect(addedTitles).toEqual([name]);
  });

  it("addSheet 비-400 오류(403) → 재시도 없이 즉시 BACKUP_TAB_FAILED, 추가 안 함", async () => {
    const { fetchImpl, addedTitles } = makeFetch([], {
      addFailStatus: 403,
      addFailCount: 1,
    });
    await expect(createBackupTab("sid", "tok", fetchImpl)).rejects.toThrow(
      /BACKUP_TAB_FAILED/
    );
    expect(addedTitles).toEqual([]);
  });

  it("batchGet 실패 → BACKUP_FETCH_FAILED", async () => {
    const { fetchImpl } = makeFetch([], { batchGetFail: true });
    await expect(createBackupTab("sid", "tok", fetchImpl)).rejects.toThrow(
      /BACKUP_FETCH_FAILED/
    );
  });
});

describe("createBackupTab — 최근 3개 유지 (생성 시각 기준 FIFO)", () => {
  it("백업 3개 상태에서 새로 만들면 가장 오래된 1개 삭제", async () => {
    // 기존 3개(아주 오래된 시각) + 새 백업(now=최신) → 가장 오래된 것(sheetId 100) 삭제
    const { fetchImpl, deletedIds } = makeFetch([
      "_backup_20000101-000001", // sheetId 100 — 가장 오래됨
      "_backup_20000101-000002", // 101
      "_backup_20000101-000003", // 102
    ]);
    await createBackupTab("sid", "tok", fetchImpl);
    expect(deletedIds).toEqual([100]);
  });

  it("구버전 회차 기반 탭(_backup_{회차})은 가장 오래됨으로 취급 → 먼저 삭제", async () => {
    const { fetchImpl, deletedIds } = makeFetch([
      "_backup_38", // 100
      "_backup_39", // 101
      "_backup_40", // 102
    ]);
    await createBackupTab("sid", "tok", fetchImpl);
    // 신규 시각 탭이 가장 최신 → 구버전 중 회차 가장 작은 _backup_38(100) 삭제
    expect(deletedIds).toEqual([100]);
  });
});
