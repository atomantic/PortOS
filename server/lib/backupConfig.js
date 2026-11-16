/**
 * Backup schedule defaults — the SINGLE declaring module (#6632).
 *
 * The backup settings slice is stored sparsely: a user who only ever typed a
 * destination has no `enabled` and no `cronExpression` on disk. Before this
 * module the scheduler and the Settings screen each invented their own answer
 * for those omissions (server: enabled + midnight; client: disabled + 02:00),
 * so a destination-only install ran nightly backups while the screen claimed
 * they were off — and saving any unrelated backup preference wrote the
 * screen's invented values back, cancelling the schedule.
 *
 * The server's interpretation is the compatible one and is preserved here:
 * omitted `enabled` means ENABLED, a missing/blank cron means midnight, and no
 * destination still means nothing is scheduled. This is read-time resolution
 * only — nothing on disk changes, and a sparse stored shape stays valid.
 *
 * Pure and dependency-free so both the scheduler and the settings route can
 * use it without dragging a service graph into leaf suites.
 */

/** Cron expression used when the stored backup settings omit one. */
export const DEFAULT_BACKUP_CRON = '0 0 * * *';

/**
 * Per-source completed-snapshot retention bounds and the default a NEW
 * install ships with. Unlike `enabled`/`cronExpression`, an install that
 * predates this setting does NOT get this default at read time — see
 * `resolveRetentionCount` below for why the distinction matters and how it is
 * made without a migration.
 */
export const DEFAULT_RETENTION_COUNT = 30;
export const MIN_RETENTION_COUNT = 1;
export const MAX_RETENTION_COUNT = 365;

/**
 * Resolve the effective per-source snapshot retention count.
 *
 * `retentionCount` absent or explicitly `null` both mean UNLIMITED — no
 * pruning. That single interpretation is what makes "new installs default to
 * 30, existing installs keep everything until the operator chooses" work
 * without a migration or an install-age flag: `data.reference/settings.json`
 * ships `backup.retentionCount: 30` on disk, and `setup-data.js` only copies
 * that file into an install that has NO `data/settings.json` yet (a brand
 * new install). Every install that already had a settings file — including
 * one that has never touched Backup settings — keeps reading `undefined`
 * here, which resolves to unlimited, exactly matching the acceptance
 * criterion that an upgrade must never start silently deleting an existing
 * archive.
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
 * Resolve the effective backup schedule from a (possibly sparse) settings slice.
 * @param {object} [backup] - the `settings.backup` slice, or undefined
 * @returns {{ destPath: string|null, enabled: boolean, cronExpression: string, scheduled: boolean, retentionCount: number|null }}
 *   `enabled` is the user's intent (an absent value means enabled);
 *   `scheduled` is whether a cron should actually be registered, which
 *   additionally requires a destination; `retentionCount` is `null` for
 *   unlimited (see `resolveRetentionCount`).
 */
export function resolveBackupConfig(backup) {
  const destPath = backup?.destPath || null;
  const enabled = backup?.enabled !== false;
  const cronExpression = backup?.cronExpression || DEFAULT_BACKUP_CRON;
  const retentionCount = resolveRetentionCount(backup);
  return { destPath, enabled, cronExpression, scheduled: enabled && Boolean(destPath), retentionCount };
}
