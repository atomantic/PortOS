/**
 * Zod schemas for backup configuration, snapshot download and restore routes.
 *
 * Moved out of the retired catch-all validation.js (#16828); the route family that consumes these schemas imports this module directly.
 */

import { z } from 'zod';
import { DEFAULT_BACKUP_CRON, MIN_RETENTION_COUNT, MAX_RETENTION_COUNT } from './backupConfig.js';
import { EXCLUDE_PATTERN_MAX_LENGTH, isSafeExcludePattern, isSafeSubdirFilter, isSafeSnapshotSource } from './sharedSchemas.js';

// Used by both the settings PUT route (.partial() for incremental updates) and
// any direct backup-config endpoint. destPath is nullable: the UI persists an
// empty string when the field is cleared, and the route handler treats empty/
// missing destPath as "not configured" rather than rejecting the save.
// The enabled/cron defaults here are the SAME interpretation `backupConfig.js`
// declares (omitted enabled = enabled, blank cron = midnight) and are sourced
// from it, so the boundary schema can never drift from the module the scheduler
// and the settings GET both resolve through (#6632).
export const backupConfigSchema = z.object({
  destPath: z.string().nullable().optional(),
  cronExpression: z.string().optional().default(DEFAULT_BACKUP_CRON),
  enabled: z.boolean().optional().default(true),
  // rsync filter patterns, bounded and kept inside the data root. `..` (any
  // segment) and NUL are rejected rather than sanitized, so a hand-edited
  // settings.json can't hand rsync a pattern that walks upward or smuggles a
  // separator. Anchoring itself happens at READ time in
  // `computeEffectiveExcludes` — the stored value stays what the user typed —
  // but the length bound is measured on the ANCHORED form, so this accepts
  // exactly what that normalizer will keep. The outer .max() is a cheap ceiling
  // on a pathological payload; isSafeExcludePattern owns the real rule.
  excludePaths: z.array(
    z.string().trim().min(1).max(EXCLUDE_PATTERN_MAX_LENGTH + 1)
      .refine(isSafeExcludePattern, { message: `Exclude pattern must be at most ${EXCLUDE_PATTERN_MAX_LENGTH} characters once anchored, and may not contain ".." or a NUL byte` })
  ).optional().default([]),
  disabledDefaultExcludes: z.array(z.string()).optional().default([]),
  // Per-source completed-snapshot retention. `null` (and an omitted field, via
  // `resolveRetentionCount`) both mean unlimited — see backupConfig.js for why
  // an existing install must never see this default itself. `.nullable()`
  // rather than `emptyToUndefined`: the UI's explicit "Unlimited" choice IS a
  // value worth persisting distinctly from "never touched this setting".
  retentionCount: z.number().int().min(MIN_RETENTION_COUNT).max(MAX_RETENTION_COUNT).nullable().optional()
});

export const subdirFilterSchema = z.string()
  .refine(isSafeSubdirFilter, 'subdirFilter must be a relative path with no wildcard, ".." , or leading "/" segments');

const snapshotSourceSchema = z.string()
  .refine(isSafeSnapshotSource, 'source must be "@legacy" or a single machine-name segment');

export const snapshotDownloadQuerySchema = z.object({
  source: snapshotSourceSchema.optional(),
}).strict();

export const restoreRequestSchema = z.object({
  snapshotId: z.string().min(1),
  source: snapshotSourceSchema.optional(),
  subdirFilter: subdirFilterSchema.optional().nullable(),
  dryRun: z.boolean().optional().default(true),
  // Install a snapshot's different federation identity over this machine's (#12596).
  adoptIdentity: z.boolean().optional().default(false)
});

export const restoreDbRequestSchema = z.object({
  snapshotId: z.string().min(1),
  source: snapshotSourceSchema.optional(),
  dryRun: z.boolean().optional().default(true)
});

// Resume a committed snapshot database restore awaiting recovery (#9725). The
// id must name the pending operation; recovery never replays the dump.
export const restoreDbRecoverRequestSchema = z.object({
  id: z.string().uuid(),
}).strict();
