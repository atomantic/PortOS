/**
 * Zod schemas for the skill registry's REST routes and CoS tools: list/view queries, the per-action `skills.manage` union, and the external-directory config.
 */

import { isAbsolute } from 'path';
import { z } from 'zod';
import { SKILL_LIMITS, SKILL_NAME_RE } from './skills/skillRegistry.js';

const appIdSchema = z.string().trim().min(1).max(128);
const skillRefSchema = z.string().trim().min(1).max(400);
const skillNameSchema = z.string().trim().regex(SKILL_NAME_RE, 'name must be 1-64 letters, digits, ".", "_" or "-"');
const supportPathSchema = z.string().trim().min(1).max(SKILL_LIMITS.SUPPORT_PATH_CHARS);
const skillContentSchema = z.string().min(1).max(SKILL_LIMITS.MAX_SKILL_BYTES);

export const SKILLS_EXTERNAL_DIRS_MAX = 10;

export const skillsListQuerySchema = z.object({
  appId: appIdSchema.optional(),
}).strict();

export const skillsViewQuerySchema = z.object({
  ref: skillRefSchema,
  appId: appIdSchema.optional(),
  file: supportPathSchema.optional(),
}).strict();

// One strict schema per action, so an argument meant for one action can never
// ride along on another.
export const skillsManageSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    name: skillNameSchema,
    category: skillNameSchema.optional(),
    content: skillContentSchema,
  }).strict(),
  z.object({
    action: z.literal('patch'),
    name: skillRefSchema,
    oldString: z.string().min(1).max(SKILL_LIMITS.MAX_SKILL_BYTES),
    newString: z.string().max(SKILL_LIMITS.MAX_SKILL_BYTES),
    replaceAll: z.boolean().optional(),
  }).strict(),
  z.object({
    action: z.literal('write_file'),
    name: skillRefSchema,
    path: supportPathSchema,
    content: z.string().max(SKILL_LIMITS.MAX_SUPPORT_FILE_BYTES),
  }).strict(),
  z.object({
    action: z.literal('remove_file'),
    name: skillRefSchema,
    path: supportPathSchema,
  }).strict(),
  z.object({
    action: z.literal('delete'),
    name: skillRefSchema,
  }).strict(),
]);

// The tool-facing JSON Schema is one flat object (JSON Schema round-trips a
// flat shape through z.fromJSONSchema reliably); the service re-validates the
// arguments against skillsManageSchema before acting.
export const skillsManageToolInputSchema = z.object({
  action: z.enum(['create', 'patch', 'write_file', 'remove_file', 'delete']),
  name: skillRefSchema,
  category: skillNameSchema.optional(),
  content: z.string().max(SKILL_LIMITS.MAX_SKILL_BYTES).optional(),
  oldString: z.string().max(SKILL_LIMITS.MAX_SKILL_BYTES).optional(),
  newString: z.string().max(SKILL_LIMITS.MAX_SKILL_BYTES).optional(),
  replaceAll: z.boolean().optional(),
  path: supportPathSchema.optional(),
}).strict();

export const skillsSettingsSchema = z.object({
  externalDirs: z.array(z.string().trim().min(1).max(1000)
    .refine((dir) => isAbsolute(dir), 'external skill directories must be absolute paths'))
    .max(SKILLS_EXTERNAL_DIRS_MAX)
    .optional(),
}).strict();
