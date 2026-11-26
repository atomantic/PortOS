/**
 * Zod schemas for the database and data-manager routes.
 *
 * Moved out of the retired catch-all validation.js (#16828); the route family that consumes these schemas imports this module directly.
 */

import { z } from 'zod';

// DELETE /api/data/:category — purge a category, or one entry inside it.
// `subPath` names a single top-level entry of the category directory; omitting
// it asks for the whole-directory wipe, which `purgeCategory` only honors for
// `purgeScope: 'category'` entries (#3327). `isTopLevelEntryName` in
// `fileUtils.js` is the authoritative gate — it runs in `purgeCategory`, which
// is the boundary a non-HTTP caller crosses too. The separator check is spelled
// out here rather than imported so this module keeps its narrow import surface
// (a partial mock of fileUtils in an unrelated suite would break schema
// construction at module load).
export const dataPurgeSchema = z.object({
  subPath: z.string().min(1).max(255)
    .refine(
      (v) => !v.includes('/') && !v.includes('\\') && v !== '.' && v !== '..',
      'subPath must name a single entry in the category'
    )
    .optional()
});

const DB_BACKENDS = ['docker', 'native'];

// POST /api/database/maintenance/preflight — advisory only; never accepts a cutover.
export const databaseMaintenancePreflightSchema = z.object({
  source: z.enum(DB_BACKENDS),
  target: z.enum(DB_BACKENDS)
}).strict().refine(value => value.source !== value.target, { message: 'Source and target must differ' });

// POST /api/database/maintenance/cutover — accepts the offline cutover (202).
export const databaseMaintenanceCutoverSchema = databaseMaintenancePreflightSchema;

// POST /api/database/maintenance/recover — same-operation recovery only.
export const databaseMaintenanceRecoverSchema = z.object({ id: z.string().uuid() }).strict();

// POST /api/database/{start,stop,destroy} — operate on a named backend.
export const databaseBackendSchema = z.object({
  backend: z.enum(DB_BACKENDS)
});

// POST /api/database/export — export from a specific backend, or (when omitted)
// the active backend.
export const databaseExportSchema = z.object({
  backend: z.enum(DB_BACKENDS).optional()
});

export const dataArchiveBodySchema = z.object({
  daysToKeep: z.preprocess((value) => (value == null ? undefined : value), z.coerce.number().finite().min(0).optional()),
});
