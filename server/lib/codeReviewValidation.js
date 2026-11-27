// Zod request schemas for the code review routes.

import { CODE_REVIEW_BATCH_BYTES, CODE_REVIEW_MAX_BATCHES } from './codeReviewBatches.js';
import { z } from 'zod';
import { isToolFreeReviewer, normalizeReviewerEffort, reviewerEffortLevels } from './reviewerConfig.js';

// Body shape for POST /api/code-review/local. `model` and `effort` are optional —
// when omitted (or empty) we fall back to the model / reasoning effort configured
// on the Code Review Defaults panel, and with no configured model either, to the
// model the backend itself reports serving when that is unambiguous (see
// `resolveServedModel`). Resolved task requests set `inheritDefaults: false` to
// preserve explicit clears and use the backend's own defaults instead.
// The diff is sent as-is; agents can pipe
// `gh pr diff <N>` straight into it without preprocessing.
// `effort` is checked against the ladder for the REQUESTED backend rather than a
// flat union of every local level: the two backends are separate identities in
// `REVIEWER_EFFORT_LEVELS`, so a union would accept a level valid only for the
// other one, and `runLocalCodeReview`'s inner `normalizeReviewerEffort` would then
// silently drop it — a 200 with the effort ignored instead of a 400. Same
// normalizer both places, so they can't disagree.
export const localReviewRequestSchema = z.object({
  backend: z.string().refine(isToolFreeReviewer),
  model: z.string().optional(),
  effort: z.string().optional(),
  inheritDefaults: z.boolean().optional(),
  cwd: z.string().min(1).optional(),
  toolFree: z.boolean().optional(),
  diff: z.string().min(1, 'diff must be non-empty'),
  timeoutMs: z.number().int().positive().max(600000).optional(),
  headSha: z.string().regex(/^[a-f0-9]{40,64}$/).optional(),
  maxBatchBytes: z.number().int().min(1024).max(CODE_REVIEW_BATCH_BYTES).optional(),
  maxBatches: z.number().int().min(1).max(CODE_REVIEW_MAX_BATCHES).optional(),
}).strict().superRefine((body, ctx) => {
  // Blank is "not pinned", not "invalid" — same fallback the sibling `model` field
  // gets from `body.model || configured` below, and what this route's header
  // documents ("when omitted or empty we fall back"). Only a NON-empty value that
  // the backend's ladder rejects is a 400.
  if (!body.effort) return
  if (normalizeReviewerEffort(body.effort, body.backend)) return
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['effort'],
    message: `Invalid effort for the ${body.backend} reviewer — expected one of: ${(reviewerEffortLevels(body.backend) || []).join(', ')}`,
  })
})

// GET /api/code-review/reviewer-identities — does each saved `@login` /
// `@org/team` reviewer exist on the target forge? Separate from /defaults so the
// settings load never waits on forge lookups. Entries come back as the operator
// saved them (nothing is dropped or rewritten) with a status of verified,
// missing (the forge answered 404), unavailable (lookup failed — not a 404), or
// skipped (forge without a lookup). `required` mirrors dispatch: a username is
// blocking unless its `@token` is in the optional set.
export const reviewerIdentityQuerySchema = z.object({
  forge: z.enum(['github', 'gitlab']).default('github'),
  host: z.string().regex(/^[A-Za-z0-9.-]{1,253}$/).optional(),
}).strict()
