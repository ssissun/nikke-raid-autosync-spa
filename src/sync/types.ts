// F-NRA-002-08 sync 타입 — 행 조작 요청 객체 (실제 API 호출은 F-07 위임).

export interface DeleteRowRequest {
  sheetRow: number; // 1-based 시트 행 (header=1)
}

export interface ReNumberRequest {
  sheetRow: number;
  newOrder: number; // Col A에 채울 값 (1~)
}

export interface AppendRowRequest {
  joined_order: number; // Col A
  member_id: string; // Col B (hidden)
  nickname: string; // Col C
}

export type SyncAlertSeverity = "info" | "warning" | "error";

export interface SyncAlert {
  severity: SyncAlertSeverity;
  code: string; // sort_needed | over_capacity | unmatched | ...
  message: string;
}

export interface SyncPlan {
  deleteRequests: DeleteRowRequest[];
  reNumberRequests: ReNumberRequest[];
  appendRequests: AppendRowRequest[];
  alerts: SyncAlert[];
  beforeCount: number;
  afterCount: number;
  isFirstRun: boolean;
}

export type ColBUpdateType = "setMemberId" | "setNickname";

export interface ColBUpdate {
  type: ColBUpdateType;
  sheetRow: number;
  memberId?: string;
  nickname?: string;
}

export interface SyncResult {
  plan: SyncPlan;
  colBUpdates: ColBUpdate[];
  alerts: SyncAlert[];
}

export class SyncError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "SyncError";
  }
}
