// F-NRA-002-07 values.batchUpdate — 두 영역(레이드 통계 + 유니온 멤버 싱크로) 동시.
// 429 Rate Limit 시 60s 후 1회 재시도.

import type { BatchUpdatePlan } from "../dryrun/calculator";
import { findRaidColumn } from "./find-column";

const UNION_MEMBER_SHEET = "유니온 멤버";

interface ValueRange {
  range: string;
  values: string[][];
}

interface BatchUpdateBody {
  valueInputOption: "USER_ENTERED";
  data: ValueRange[];
}

export interface ExecuteBatchUpdateOptions {
  fetchImpl?: typeof fetch;
  /** 429 후 대기 시간 (ms). 테스트 시 fake timer로 단축. */
  rateLimitDelayMs?: number;
  /** test injection: syncroColumn 우회. 미지정 시 findRaidColumn 호출. */
  syncroColumn?: string;
}

export async function executeBatchUpdate(
  spreadsheetId: string,
  plan: BatchUpdatePlan,
  accessToken: string,
  options: ExecuteBatchUpdateOptions = {}
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const rateLimitDelay = options.rateLimitDelayMs ?? 60_000;

  if (
    plan.raidStatsRows.length === 0 &&
    plan.memberSyncroUpdates.length === 0
  ) {
    throw new Error("EMPTY_PLAN: 레이드 통계 행 + 멤버 syncro 모두 없음");
  }

  const syncroColumn =
    options.syncroColumn ??
    (await findRaidColumn(spreadsheetId, plan.raidNum, accessToken, fetchImpl));
  if (syncroColumn === null) {
    throw new Error(`COLUMN_NOT_FOUND: ${plan.raidNum}차 열 없음`);
  }

  const data: ValueRange[] = [];
  if (plan.raidStatsRows.length > 0 && plan.raidStatsRange.length > 0) {
    data.push({
      range: plan.raidStatsRange,
      values: plan.raidStatsRows,
    });
  }

  if (plan.memberSyncroUpdates.length > 0) {
    const sorted = [...plan.memberSyncroUpdates].sort(
      (a, b) => a.sheetRow - b.sheetRow
    );
    const startRow = sorted[0].sheetRow;
    const endRow = sorted[sorted.length - 1].sheetRow;
    const values: string[][] = [];
    for (let r = startRow; r <= endRow; r++) {
      const found = sorted.find((u) => u.sheetRow === r);
      values.push([found !== undefined ? String(found.syncroLevel) : ""]);
    }
    data.push({
      range: `${UNION_MEMBER_SHEET}!${syncroColumn}${startRow}:${syncroColumn}${endRow}`,
      values,
    });
  }

  const body: BatchUpdateBody = {
    valueInputOption: "USER_ENTERED",
    data,
  };

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`;
  const doRequest = (): Promise<Response> =>
    fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

  let res = await doRequest();
  if (res.status === 429) {
    await new Promise((resolve) => setTimeout(resolve, rateLimitDelay));
    res = await doRequest();
    if (res.status === 429) {
      throw new Error("RATE_LIMIT: 60s 재시도 후에도 429");
    }
  }
  if (!res.ok) {
    throw new Error(`BATCH_UPDATE_FAILED: HTTP ${res.status}`);
  }
}
