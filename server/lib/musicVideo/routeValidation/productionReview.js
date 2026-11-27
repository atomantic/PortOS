/** Request schemas for Music Video production review, approvals, and proof renders. */

import { z } from 'zod';
import { musicVideoProductionDraftSchema } from '../musicVideoValidation.js';
import { musicVideoCastAndSetsStartSchema } from './shared.js';

export { musicVideoCastAndSetsStartSchema, musicVideoProductionDraftSchema };

export const musicVideoAlignmentReviewSchema = z.object({
  basis: z.string().min(1).max(128), notes: z.string().trim().max(4000).default(''),
}).strict();

export const musicVideoDocumentShotsSchema = z.object({
  documentDirectory: z.string().min(1).max(500), audioBasis: z.string().min(1).max(128),
  sourceFile: z.string().min(1).max(200),
  shots: musicVideoProductionDraftSchema.shape.storyboard.min(1),
}).strict().superRefine((value, ctx) => {
  const ids = new Set();
  for (const shot of value.shots) {
    if (!shot.id?.trim() || ids.has(shot.id) || shot.sceneId != null
      || !Number.isFinite(shot.startSec) || !(shot.endSec > shot.startSec)) {
      ctx.addIssue({ code: 'custom', message: 'Document shots need unique source IDs, positive timing and no Board scene binding' });
    }
    ids.add(shot.id);
  }
});

export const musicVideoProductionImportSchema = z.object({ source: z.string().min(2).max(250000) }).strict();

export const musicVideoProductionApprovalSchema = z.object({
  stage: z.enum(['art', 'storyboard', 'proof']), basis: z.string().min(1).max(128),
  password: z.string().max(1024).optional(),
  proofReview: z.object({
    method: z.enum(['playback', 'machine']).optional(),
    watchedWithAudio: z.boolean(),
    machineEvidence: z.object({
      visualReview: z.string().trim().min(40).max(8000),
      audioReview: z.string().trim().min(40).max(8000),
      limitations: z.string().trim().min(1).max(4000),
    }).strict().optional(),
    excerptId: z.string().min(1).max(200), filename: z.string().min(1).max(200),
    energyComparison: z.string().trim().max(4000).optional(),
    timecodedNotes: z.string().trim().max(4000).optional(),
  }).strict().optional(),
}).strict();

export const musicVideoProductionProofSchema = z.object({
  kind: z.enum(['proof', 'prototype']).optional(),
  startSec: z.number().min(0), endSec: z.number().positive(),
}).strict();

export const musicVideoProductionFeedbackSchema = z.object({
  stage: z.enum(['art', 'storyboard', 'proof']), basis: z.string().min(1).max(128),
  target: z.string().trim().min(1).max(300), text: z.string().trim().min(1).max(8000),
  decision: z.enum(['comment', 'structure-accepted', 'request-changes']),
}).strict();

export const musicVideoProductionReviseSchema = musicVideoCastAndSetsStartSchema.extend({
  stage: z.enum(['art', 'storyboard', 'proof']),
}).strict();

// The input label a stale approval names (`concept`, `scene 3 prompt`, …) — the server finds its stored value.
export const musicVideoProductionRevertSchema = z.object({
  stage: z.enum(['art', 'storyboard', 'proof', 'castAndSets']), field: z.string().trim().min(1).max(100),
}).strict();

// Anchor these storyboard shots (every flagged shot when absent) to the lyric lines sung over them.
export const musicVideoLyricAnchorSyncSchema = z.object({
  sceneIds: z.array(z.string().min(1).max(64)).min(1).max(2000).optional(),
}).strict();

export const musicVideoProductionFeedbackResolutionSchema = z.object({
  feedbackId: z.string().min(1).max(128), resolution: z.string().trim().max(8000).default(''), password: z.string().max(1024).optional(),
}).strict();
