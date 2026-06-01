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

describe("buildBackupValues", () => {
  it("16 컬럼 너비로 padding + 두 영역 라벨링", () => {
    const lines = buildBackupValues("40", [["A", "B"], ["C", "D"]], [["E", "F"]]);
    // 헤더 + blank + "유니온 멤버" 라벨 + 2행 + blank + "레이드 통계" 라벨 + 1행 = 8 lines
    expect(lines.length).toBe(8);
    expect(lines[0][0]).toMatch(/^40차 backup - \d{4}-\d{2}-\d{2}/);
    expect(lines[2][0]).toBe("=== 유니온 멤버 ===");
    expect(lines[3]).toEqual(["A", "B", "", "", "", "", "", "", "", "", "", "", "", "", "", ""]);
    expect(lines[6][0]).toBe("=== 레이드 통계 ===");
  });
});

describe("createBackupTab — locale 무관 이름 충돌 회피", () => {
  it("충돌 없으면 _backup_{N}", async () => {
    const { fetchImpl, addedTitles } = makeFetch([]);
    const name = await createBackupTab("sid", "40", "tok", fetchImpl);
    expect(name).toBe("_backup_40");
    expect(addedTitles).toEqual(["_backup_40"]);
  });

  it("_backup_40 이미 존재 → _backup_40_2 (에러 메시지 파싱 의존 안 함)", async () => {
    const { fetchImpl, addedTitles } = makeFetch(["_backup_40"]);
    const name = await createBackupTab("sid", "40", "tok", fetchImpl);
    expect(name).toBe("_backup_40_2");
    expect(addedTitles).toEqual(["_backup_40_2"]);
  });

  it("_backup_40, _backup_40_2 둘 다 존재 → _backup_40_3", async () => {
    const { fetchImpl, addedTitles } = makeFetch(["_backup_40", "_backup_40_2"]);
    const name = await createBackupTab("sid", "40", "tok", fetchImpl);
    expect(name).toBe("_backup_40_3");
    expect(addedTitles).toEqual(["_backup_40_3"]);
  });
});

describe("createBackupTab — 데이터 복사 + prune", () => {
  it("4개째 백업 생성 시 가장 오래된 회차(_backup_38) 삭제", async () => {
    const { fetchImpl, addedTitles, deletedIds } = makeFetch([
      "_backup_38",
      "_backup_39",
      "_backup_40",
    ]);
    const name = await createBackupTab("sid", "41", "tok", fetchImpl);
    expect(name).toBe("_backup_41");
    expect(addedTitles).toEqual(["_backup_41"]);
    // _backup_38 (sheetId 100, 회차 가장 작음) 삭제
    expect(deletedIds).toEqual([100]);
  });

  it("addSheet 비-400 오류(403) → 재시도 없이 즉시 BACKUP_TAB_FAILED, batchGet 미호출", async () => {
    const { fetchImpl, addedTitles } = makeFetch([], {
      addFailStatus: 403,
      addFailCount: 1,
    });
    await expect(createBackupTab("sid", "40", "tok", fetchImpl)).rejects.toThrow(
      /BACKUP_TAB_FAILED/
    );
    expect(addedTitles).toEqual([]);
  });

  it("사전 조회 후에도 400 충돌(race) → 이름 늘려 재시도 후 성공", async () => {
    // 목록엔 없던 _backup_40 이 addSheet 시점에 400 → _backup_40_2 로 재시도 성공 (locale 무관)
    const { fetchImpl, addedTitles } = makeFetch([], {
      addFailStatus: 400,
      addFailCount: 1,
    });
    const name = await createBackupTab("sid", "40", "tok", fetchImpl);
    expect(name).toBe("_backup_40_2");
    expect(addedTitles).toEqual(["_backup_40_2"]);
  });

  it("batchGet 실패 → BACKUP_FETCH_FAILED", async () => {
    const { fetchImpl } = makeFetch([], { batchGetFail: true });
    await expect(createBackupTab("sid", "40", "tok", fetchImpl)).rejects.toThrow(
      /BACKUP_FETCH_FAILED/
    );
  });
});
