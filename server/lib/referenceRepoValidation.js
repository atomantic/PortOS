/**
 * Zod schemas for the reference-repo routes (create, update, mark reviewed).
 *
 * Moved out of the retired catch-all validation.js (#16828); the route family that consumes these schemas imports this module directly.
 */

import { z } from 'zod';

// Used by routes that POST a NEW reference repo (id/createdAt are server-
// assigned, lastReviewedSha/lastCheckedAt populate after the first check).
// `.trim()` runs before `min(1)` so a name/repoUrl that's just whitespace
// fails validation rather than slipping through and producing confusing
// git failures downstream — matches the project convention used elsewhere
// in this file.
// Reference-repo entry. Each app can list upstream repos it watches for
// clean-room reimplementation; the `reference-watch` scheduled task fetches
// each one, finds commits since `lastReviewedSha`, and files proposals in the
// app's configured tracker (PLAN.md checklist IDs or forge issue numbers) for
// `/claim` / `plan-task` / `claim-issue*` to pick up. `notes` is the free-text
// "what we use from this repo" field, fed into the review prompt so the agent
// knows which features in our app are load-bearing for the watch. `repoUrl` is
// either a clonable URL (https://github.com/owner/repo or scp-style
// user@host:owner/repo.git) or a local filesystem path; the service detects
// remote URLs by matching
// `scheme://` or scp-style `user@host:path` (see isLocalPath in
// services/referenceRepos.js) and treats anything else as a local path.
// The persisted record's server-owned fields (id, status, lastError,
// lastCheckedAt, lastKnownGoodSnapshot, createdAt) are stamped by
// services/referenceRepos.js and never accepted from a request body.
export const referenceRepoCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  repoUrl: z.string().trim().min(1).max(500),
  branch: z.string().trim().max(120).optional(),
  notes: z.string().max(4000).optional()
});

// Patch schema — every field optional. `lastReviewedSha` is also accepted
// here so the UI's "mark as reviewed" button (and the post-check service
// path) can pin a SHA. Same trim-before-min-length convention as the
// create schema. lastReviewedSha is hex-validated so a bad PATCH can't
// persist a non-SHA into apps.json.
export const referenceRepoUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  repoUrl: z.string().trim().min(1).max(500).optional(),
  branch: z.string().trim().max(120).optional(),
  notes: z.string().max(4000).optional(),
  lastReviewedSha: z.string().regex(/^[0-9a-f]{40}$/i, 'must be a 40-char hex SHA').nullable().optional()
});

export const referenceRepoReviewedBodySchema = z.object({ sha: z.string().trim().default('') });
