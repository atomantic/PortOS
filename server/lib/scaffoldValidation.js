/**
 * Zod schemas for the app scaffold routes.
 *
 * Moved out of the retired catch-all validation.js (#16828); the route family that consumes these schemas imports this module directly.
 */

import { z } from 'zod';
import { emptyToUndefined, emptyToNull } from './zodCompat.js';
import { nonEmptyString } from './sharedSchemas.js';

// Known scaffold templates — the single source of truth for the enum the
// scaffold route accepts. An unknown template MUST be rejected before any
// filesystem write or subprocess spawn (issue #2390), so the route can no
// longer create a target directory for a template it can't actually build.
const SCAFFOLD_TEMPLATES = [
  'portos-stack',
  'vite-express',
  'vite-react',
  'express-api',
  'ios-native',
  'xcode-multiplatform'
];

// Ports may arrive absent (auto-allocated by the route) or as an explicit
// number. Tolerate the UI '' sentinel as "not provided"; anything else must be
// a valid TCP port so an out-of-range value is rejected deterministically.
const scaffoldPortSchema = z.preprocess(
  emptyToUndefined,
  z.number().int().min(1).max(65535).nullable().optional()
);

// GET /api/scaffold/directories. `includeFiles` is a query flag, so it arrives
// as the string 'true' rather than a boolean. The path is not trimmed: a
// directory name may legitimately begin or end with whitespace.
export const scaffoldDirectoriesQuerySchema = z.object({
  path: z.string().min(1).max(4096).optional(),
  includeFiles: z.enum(['true', 'false']).optional(),
});

// Full request schema for POST /api/scaffold. Validated before the route
// touches the filesystem — template enum, port range, and a name that yields a
// usable directory slug are all enforced up front.
export const scaffoldSchema = z.object({
  name: z.string().trim().min(1).max(100)
    // The route sanitizes name → [a-z0-9-]; a name with no alphanumerics
    // slugifies to an all-dash/empty dirName. Reject it here rather than
    // creating a garbage directory.
    .refine(v => /[a-z0-9]/i.test(v), {
      message: 'name must contain at least one letter or number'
    }),
  template: z.enum(SCAFFOLD_TEMPLATES),
  parentDir: z.string().trim().min(1),
  uiPort: scaffoldPortSchema,
  apiPort: scaffoldPortSchema,
  createGitHubRepo: z.boolean().optional().default(false),
  githubOrg: z.preprocess(emptyToNull, z.string().min(1).nullable().optional())
});

export const scaffoldTemplateCreateBodySchema = z.object({ templateId: nonEmptyString, name: nonEmptyString, targetPath: nonEmptyString });
