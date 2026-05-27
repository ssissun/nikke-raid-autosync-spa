// Pre-migration → Post-migration 자동 마이그레이션.
// Col B 위치에 숨김 컬럼 1개 신규 삽입 + 헤더 "member_id" + 데이터 row 에 member_id 값 입력.
// 단일 spreadsheets.batchUpdate atomic 요청 — 부분 실패 회피.
//
// fingerprint 영향: fingerprint.ts 의 TOOL_OWNED_COLUMNS = {"member_id"} 가 hash 계산에서 자동 제외하므로,
// 마이그레이션 후에도 ALLOWED_FINGERPRINTS 매칭 그대로 유지됨.

const UNION_MEMBER_SHEET = "유니온 멤버";

interface SheetProperties {
  sheetId: number;
  title?: string;
}

interface SpreadsheetGetResponse {
  sheets?: Array<{ properties?: SheetProperties }>;
}

async function getUnionMemberSheetId(
  spreadsheetId: string,
  accessToken: string,
  fetchImpl: typeof fetch
): Promise<number> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets(properties(sheetId,title))`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`MIGRATE_INFO_FAILED: HTTP ${res.status}`);
  }
  const body = (await res.json()) as SpreadsheetGetResponse;
  const found = (body.sheets ?? []).find(
    (s) => s.properties?.title === UNION_MEMBER_SHEET
  );
  if (found?.properties?.sheetId === undefined) {
    throw new Error(`MIGRATE_INFO_FAILED: '${UNION_MEMBER_SHEET}' 탭 부재`);
  }
  return found.properties.sheetId;
}

/**
 * pre-migration → post-migration 마이그레이션.
 *
 * @param memberIdByRow  sheetRow(1-indexed, header=row1) → member_id.
 *                       매칭 안 된 row 는 누락 가능 — auto-sync 가 leaving 처리.
 *
 * 동작:
 *   1) 유니온 멤버 sheetId 조회
 *   2) atomic batchUpdate — 3 requests:
 *      a. insertDimension: Col B 위치(startIndex=1) 신규 컬럼 1개 (회차 컬럼들이 한 칸씩 우측으로 밀림)
 *      b. updateCells: B1 = "member_id", 데이터 row 의 B 셀에 member_id 값
 *      c. updateDimensionProperties: 새 Col B 를 hiddenByUser=true (시트 화면에서 숨김)
 */
export async function migrateToMemberId(
  spreadsheetId: string,
  accessToken: string,
  memberIdByRow: ReadonlyMap<number, string>,
  fetchImpl: typeof fetch = fetch
): Promise<{ filledRows: number }> {
  const sheetId = await getUnionMemberSheetId(spreadsheetId, accessToken, fetchImpl);

  // 데이터 row 의 member_id 값 행렬 구성 (row2~row33, max 32명)
  const MAX_DATA_ROWS = 32; // 유니온 멤버 정원
  const dataRows: Array<{ values: Array<{ userEnteredValue?: { stringValue: string } }> }> = [];
  let filledRows = 0;
  for (let i = 0; i < MAX_DATA_ROWS; i++) {
    const sheetRow = i + 2; // row1=header, data row2..33
    const memberId = memberIdByRow.get(sheetRow);
    if (memberId !== undefined && memberId.length > 0) {
      dataRows.push({
        values: [{ userEnteredValue: { stringValue: memberId } }],
      });
      filledRows++;
    } else {
      // 매칭 실패 row — 빈 셀 (auto-sync 가 leaving 처리)
      dataRows.push({ values: [{ userEnteredValue: { stringValue: "" } }] });
    }
  }

  const requests = [
    // a. Col B 위치에 신규 컬럼 1개 삽입 (회차 컬럼들 한 칸씩 우측 shift)
    {
      insertDimension: {
        range: {
          sheetId,
          dimension: "COLUMNS",
          startIndex: 1,
          endIndex: 2,
        },
        inheritFromBefore: false,
      },
    },
    // b. 헤더 "member_id" + 데이터 row 의 member_id 값
    {
      updateCells: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: 1 + MAX_DATA_ROWS,
          startColumnIndex: 1,
          endColumnIndex: 2,
        },
        rows: [
          {
            values: [{ userEnteredValue: { stringValue: "member_id" } }],
          },
          ...dataRows,
        ],
        fields: "userEnteredValue",
      },
    },
    // c. 새 Col B 숨김 (사용자 시트 화면에서 안 보임)
    {
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: "COLUMNS",
          startIndex: 1,
          endIndex: 2,
        },
        properties: { hiddenByUser: true },
        fields: "hiddenByUser",
      },
    },
  ];

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `MIGRATE_FAILED: HTTP ${res.status} ${errText.slice(0, 200)}`
    );
  }

  return { filledRows };
}
