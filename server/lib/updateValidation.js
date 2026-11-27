/**
 * Zod schemas for PortOS update actions and installed software queries.
 */

import { z } from 'zod';

export const ignoreUpdateSchema = z.object({
  version: z.string().min(1, 'version is required')
});

// `acknowledgeBusy`: the owner proceeds although PortOS is busy (the guard
// warns with what is running; it does not lock the owner out).
export const acknowledgeBusySchema = z.object({ acknowledgeBusy: z.boolean().optional() });

export const nodeUpdateSchema = acknowledgeBusySchema.extend({
  version: z.string().regex(/^v\d+\.\d+\.\d+$/, 'version must look like v26.12.1')
});

export const softwareQuerySchema = z.object({ fresh: z.enum(['0', '1']).optional() });

export const syncForkSchema = z.object({
  branch: z.string().min(1).max(255).regex(/^[A-Za-z0-9._/-]+$/, 'branch contains invalid characters').optional()
});

export const executeUpdateSchema = z.object({
  acknowledgeInterruption: z.boolean().optional(),
  acknowledgeFork: z.boolean().optional(),
  acknowledgePersistentMindImageBackup: z.boolean().optional(),
  // Reconcile a half-updated install (issue #1779): run update.sh to pull +
  // install + build + restart even when there's no NEWER GitHub release — the
  // user did a bare `git pull` and just needs the rest of the update steps.
  reconcile: z.boolean().optional()
});
