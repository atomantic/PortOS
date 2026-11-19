/**
 * Zod schemas for the app/GSD document update routes and the legacy export route.
 *
 * Moved out of the retired catch-all validation.js (#16828); the route family that consumes these schemas imports this module directly.
 */

import { z } from 'zod';

/**
 * Body schema for PUT /api/apps/:id/documents/*docPath and
 * PUT /api/cos/gsd/projects/:appId/documents/:docName.
 * Both routes accept a content string plus an optional commit message.
 */
export const documentUpdateSchema = z.object({
  content: z.string().max(500000),
  commitMessage: z.string().max(200).optional()
});

// Legacy Export (issue #901) — portable identity bundle. `sections` optionally
// narrows the bundle to a subset of domains; omitted/empty means "all present
// sections". The enum is kept in sync with `legacyExport.js#getSectionKeys()`
// (asserted in legacyExport's tests) — a validation module must not import from
// services (cycle), so the keys are inlined here.
export const LEGACY_EXPORT_SECTIONS = ['identity', 'autobiography', 'brain', 'goals', 'decisions', 'health'];
export const legacyExportSchema = z.object({
  sections: z.array(z.enum(LEGACY_EXPORT_SECTIONS)).optional(),
  // Phase 2: render a `legacy-portrait.pdf` from the section Markdown. Default
  // false — the Markdown/JSON bundle is the primary artifact.
  includePdf: z.boolean().optional()
});
