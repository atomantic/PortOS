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
 * Resolve the effective backup schedule from a (possibly sparse) settings slice.
 * @param {object} [backup] - the `settings.backup` slice, or undefined
 * @returns {{ destPath: string|null, enabled: boolean, cronExpression: string, scheduled: boolean }}
 *   `enabled` is the user's intent (an absent value means enabled);
 *   `scheduled` is whether a cron should actually be registered, which
 *   additionally requires a destination.
 */
export function resolveBackupConfig(backup) {
  const destPath = backup?.destPath || null;
  const enabled = backup?.enabled !== false;
  const cronExpression = backup?.cronExpression || DEFAULT_BACKUP_CRON;
  return { destPath, enabled, cronExpression, scheduled: enabled && Boolean(destPath) };
}
