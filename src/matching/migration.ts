// 마이그레이션 모드 판단 — Col B 공백 시 backfill 또는 block 분기.

export type MigrationMode = 'block' | 'backfill' | 'none';

export function detectMigrationMode(
  allColBEmpty: boolean,
  colCNicknames: Map<number, string>
): MigrationMode {
  if (!allColBEmpty) return 'none';
  if (colCNicknames.size === 0) return 'block';
  return 'backfill';
}
