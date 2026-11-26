/**
 * Zod schemas for the git write routes (stage, commit, branch, diff, cleanup) and the submodule routes.
 *
 * Moved out of the retired catch-all validation.js (#16828); the route family that consumes these schemas imports this module directly.
 */

import { z } from 'zod';
import { isSafeGitRef } from './gitArgs.js';

// ---- Git write-route bodies (#9154) -----------------------------------------
// Refs and files become argv entries for git, so a leading "-" would be parsed
// as an option; the ref grammar rejects that plus git's own invalid-ref forms.
const gitRefNameSchema = z.string().min(1).max(255).refine(isSafeGitRef, {
  message: 'not a valid git ref name',
});
const gitPathField = z.string().min(1);

export const gitPathBodySchema = z.object({ path: gitPathField });
export const gitCleanupMergedBodySchema = gitPathBodySchema.extend({
  branches: z.array(gitRefNameSchema).min(1).max(100).optional(),
}).strict();
export const gitStageBodySchema = z.object({
  path: gitPathField,
  files: z.array(z.string().min(1)).min(1).max(500),
});
export const gitCommitBodySchema = z.object({
  path: gitPathField,
  message: z.string().min(1).max(10000),
});
export const gitBranchBodySchema = z.object({ path: gitPathField, branch: gitRefNameSchema });
export const gitOptionalBranchBodySchema = z.object({
  path: gitPathField,
  branch: gitRefNameSchema.nullish(),
});
export const gitBranchComparisonBodySchema = z.object({
  path: gitPathField,
  base: gitRefNameSchema.nullish(),
  head: gitRefNameSchema.nullish(),
});
export const gitDiffBodySchema = z.object({ path: gitPathField, staged: z.boolean().default(false) });
export const gitRemoteBranchesBodySchema = z.object({ path: gitPathField, force: z.boolean().default(false) });
export const gitDeleteBranchBodySchema = z.object({
  path: gitPathField,
  branch: gitRefNameSchema,
  expectedHead: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/).optional(),
  local: z.boolean().default(false),
  remote: z.boolean().default(false),
}).refine(({ local, remote }) => local || remote, {
  message: 'at least one of local or remote must be true',
}).refine(({ expectedHead, local, remote }) => !expectedHead || (local && !remote), {
  message: 'expectedHead requires local-only deletion',
});

// Git submodules. `repoPath` is the repo ROOT (omitted = the PortOS checkout,
// and it is separately checked against the workspace allowlist); `path` is the
// repo-relative submodule path, matching `git submodule status` output.
const optionalRepoPath = z.string().trim().min(1).max(4096).nullish();

export const submoduleStatusQuerySchema = z.object({
  repoPath: optionalRepoPath
});

export const submoduleUpdateSchema = z.object({
  path: z.string().trim().min(1).max(4096),
  repoPath: optionalRepoPath,
  commit: z.boolean().optional().default(false)
});
