/**
 * Backup schedule defaults, shared by scheduler and Settings: omitted `enabled` means ENABLED,
 * blank cron means midnight, no destination means nothing scheduled (read-time only).
 */

export const DEFAULT_BACKUP_CRON = '0 0 * * *';

// Retention bounds and the default a NEW install ships with (not applied at read time; see below).
export const DEFAULT_RETENTION_COUNT = 30;
export const MIN_RETENTION_COUNT = 1;
export const MAX_RETENTION_COUNT = 365;

/**
 * Absent or `null` `retentionCount` means UNLIMITED, so new installs get 30 from the seeded
 * `data.reference/settings.json` while upgrades never start silently deleting an archive.
 * @param {object} [backup] - the `settings.backup` slice, or undefined
 * @returns {number|null} snapshots to keep per source, or `null` for unlimited
 */
export function resolveRetentionCount(backup) {
  const raw = backup?.retentionCount;
  if (raw === null || raw === undefined) return null;
  if (!Number.isInteger(raw) || raw < MIN_RETENTION_COUNT || raw > MAX_RETENTION_COUNT) return null;
  return raw;
}

/**
 * Resolve the effective schedule from a (possibly sparse) `settings.backup` slice.
 * `enabled` is intent; `scheduled` also requires a destination.
 * @param {object} [backup] - the `settings.backup` slice, or undefined
 * @returns {{ destPath: string|null, enabled: boolean, cronExpression: string, scheduled: boolean, retentionCount: number|null }}
 */
export function resolveBackupConfig(backup) {
  const destPath = backup?.destPath || null;
  const enabled = backup?.enabled !== false;
  const cronExpression = backup?.cronExpression || DEFAULT_BACKUP_CRON;
  const retentionCount = resolveRetentionCount(backup);
  return { destPath, enabled, cronExpression, scheduled: enabled && Boolean(destPath), retentionCount };
}
