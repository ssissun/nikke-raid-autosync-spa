// F-NRA-002-06 미리보기 UI — DOM 직접 렌더 (vanilla TS, framework 0).

import type { BatchUpdatePlan } from "./calculator";

const RAID_HEADER_PREVIEW = [
  "회차",
  "닉네임",
  "보스",
  "단계",
  "딜량",
];

export type ProgressStage = "fingerprint" | "backup" | "batchUpdate";

export interface RenderDryRunPreviewArgs {
  container: HTMLElement;
  plan: BatchUpdatePlan;
  onConfirm: () => void;
  onCancel: () => void;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderDryRunPreview(args: RenderDryRunPreviewArgs): void {
  const { container, plan, onConfirm, onCancel } = args;

  const previewRows = plan.raidStatsRows.slice(0, 50); // 너무 많으면 컷
  const previewHeader = RAID_HEADER_PREVIEW.map(escapeHtml).join("</th><th>");

  const rowsHtml = previewRows
    .map((row) => {
      const cells = [row[0], row[1], row[2], row[3], row[14]]; // 회차/닉/보스/단계/딜량
      return `<tr>${cells.map((c) => `<td>${escapeHtml(c ?? "")}</td>`).join("")}</tr>`;
    })
    .join("");

  const unmatchedWarning =
    plan.unmatchedNames.length > 0
      ? `<div class="warning" role="alert">
           매칭 실패 ${plan.unmatchedNames.length}건 (A-2 대기) — 시트 닉네임을 정정한 뒤 [추가] 재시도하세요.
           <ul>${plan.unmatchedNames.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>
         </div>`
      : "";

  container.innerHTML = `
    <section class="dry-run-preview">
      <h2>변경 미리보기 (${escapeHtml(plan.raidNum)}차)</h2>
      <p>백업 탭: <code>${escapeHtml(plan.backupTabName)}</code> — 쓰기 직전 자동 생성됩니다.</p>
      <p>레이드 통계 ${plan.raidStatsRows.length}행 · 멤버 싱크로 ${plan.memberSyncroUpdates.length}건 (회차 컬럼 <code>${escapeHtml(plan.syncroColumn)}</code>)</p>
      ${unmatchedWarning}
      <table class="raid-stats-preview">
        <thead><tr><th>${previewHeader}</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <div class="actions">
        <button type="button" data-action="confirm-write" ${plan.isConfirmable ? "" : "disabled"}>확인 후 기록</button>
        <button type="button" data-action="cancel-write">취소</button>
      </div>
    </section>
  `;

  const confirmBtn = container.querySelector<HTMLButtonElement>(
    '[data-action="confirm-write"]'
  );
  const cancelBtn = container.querySelector<HTMLButtonElement>(
    '[data-action="cancel-write"]'
  );
  confirmBtn?.addEventListener("click", () => {
    if (plan.isConfirmable) onConfirm();
  });
  cancelBtn?.addEventListener("click", onCancel);
}

const PROGRESS_LABELS: Record<ProgressStage, string> = {
  fingerprint: "1/3 시트 헤더 검증 (fingerprint)",
  backup: "2/3 백업 탭 생성",
  batchUpdate: "3/3 레이드 + 멤버 동시 쓰기",
};

export function renderProgressUI(
  container: HTMLElement,
  stage: ProgressStage | "done"
): void {
  if (stage === "done") {
    container.innerHTML = '<p class="progress done">완료</p>';
    return;
  }
  container.innerHTML = `
    <ol class="progress-steps">
      ${(["fingerprint", "backup", "batchUpdate"] as ProgressStage[])
        .map(
          (s) =>
            `<li class="${s === stage ? "active" : ""}">${escapeHtml(PROGRESS_LABELS[s])}</li>`
        )
        .join("")}
    </ol>
  `;
}
