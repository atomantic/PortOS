/**
 * Zod schemas for the database, data-manager and port-allocation routes.
 *
 * Moved out of the retired catch-all validation.js (#16828); the route family that consumes these schemas imports this module directly.
 */

import { z } from 'zod';

// POST /api/ports/allocate — reserve N free ports. `count` accepts a number or
// a numeric string (the UI may send either) and defaults to 1 when absent,
// matching the prior `parseInt(count) || 1` behavior — but non-numeric garbage
// now 400s instead of silently collapsing to 1. The preprocess only forwards
// number|string so `z.coerce` can't quietly turn a boolean (`true → 1`) or an
// array (`[5] → 5`) into a valid count.
export const portsAllocateSchema = z.object({
  count: z.preprocess(
    (v) => {
      if (v === undefined) return 1;
      return (typeof v === 'number' || typeof v === 'string') ? v : NaN;
    },
    z.coerce.number().int().min(1).max(10)
  )
});

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

// POST /api/database/switch — switch active backend, optionally migrating data.
export const databaseSwitchSchema = z.object({
  target: z.enum(DB_BACKENDS),
  migrate: z.boolean().optional()
});

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
