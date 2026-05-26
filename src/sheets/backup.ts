// F-NRA-002-07 백업 탭 생성 — `_backup_{회차}` (중복 시 `_2` fallback).

interface SheetsErrorBody {
  error?: { code?: number; status?: string; message?: string };
}

async function attemptAddSheet(
  spreadsheetId: string,
  title: string,
  accessToken: string,
  fetchImpl: typeof fetch
): Promise<void> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requests: [{ addSheet: { properties: { title } } }],
    }),
  });
  if (res.ok) return;

  const errBody = (await res.json().catch(() => ({}))) as SheetsErrorBody;
  const msg = errBody.error?.message ?? "";
  if (
    res.status === 400 &&
    (msg.includes("already exists") || msg.toLowerCase().includes("duplicate"))
  ) {
    throw new Error("ALREADY_EXISTS");
  }
  throw new Error(`BACKUP_TAB_FAILED: HTTP ${res.status} ${msg}`);
}

export async function createBackupTab(
  spreadsheetId: string,
  raidNum: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const primary = `_backup_${raidNum}`;
  try {
    await attemptAddSheet(spreadsheetId, primary, accessToken, fetchImpl);
    return primary;
  } catch (e) {
    if (e instanceof Error && e.message === "ALREADY_EXISTS") {
      const fallback = `${primary}_2`;
      await attemptAddSheet(spreadsheetId, fallback, accessToken, fetchImpl);
      return fallback;
    }
    throw e;
  }
}
