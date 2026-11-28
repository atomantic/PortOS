// Validates manuscript editing, text analysis, and perspective rewrite requests.

import { z } from 'zod';
import { providerOverrideShape } from './arcValidation.js';
import { STAGE_OUTPUT_MAX } from './pipelineIssueConfig.js';
import { DISMISS_REASONS, MANUSCRIPT_TYPES, REVIEW_RUN_MODES } from './pipelineSeriesConfig.js';

// Manuscript-completeness ("finish the draft") editor pass — override shape plus
// the re-run mode: 'merge' (default) leaves prior comments as-is and appends new
// findings; 'fresh' also auto-dismisses open comments this pass no longer finds
// (accepted/dismissed untouched). See seedReviewFromFindings.
export const manuscriptCompletenessSchema = z.object({
  ...providerOverrideShape,
  mode: z.enum(REVIEW_RUN_MODES).optional(),
});

// Manuscript editor — review comment operations.
export const manuscriptFixGenerateSchema = z.object(providerOverrideShape);

const manuscriptFixEditSchema = z.object({
  issueNumber: z.number().int().nullable().optional(),
  issueId: z.string().min(1).max(120).nullable().optional(),
  stageId: z.enum(MANUSCRIPT_TYPES).nullable().optional(),
  find: z.string().min(1).max(STAGE_OUTPUT_MAX),
  replace: z.string().max(STAGE_OUTPUT_MAX),
});

export const manuscriptFixAcceptSchema = z.object({
  find: z.string().min(1).max(STAGE_OUTPUT_MAX).optional(),
  replace: z.string().max(STAGE_OUTPUT_MAX).optional(),
  edits: z.array(manuscriptFixEditSchema).max(20).optional(),
}).refine((v) => (Array.isArray(v.edits) && v.edits.length > 0) || !!v.find, {
  message: 'Provide find/replace or at least one edit',
}).refine((v) => !v.find || typeof v.replace === 'string', {
  path: ['replace'],
  message: 'replace is required when find is provided',
});

// Comment PATCH: status flip and/or attach/clear a fix. `.strict()` rejects
// stray keys; `fix` nullable so an explicit clear is distinguishable from absent.
export const manuscriptCommentPatchSchema = z.object({
  status: z.enum(['open', 'accepted', 'dismissed']).optional(),
  // Why a dismissal was made (#1605) — `false-positive` flags a broken check;
  // `null` clears the reason back to a plain "won't fix" dismiss. Validated
  // against the same source the service sanitizes from.
  dismissReason: z.enum(DISMISS_REASONS).nullable().optional(),
  fix: z.object({
    find: z.string().max(STAGE_OUTPUT_MAX).optional(),
    replace: z.string().max(STAGE_OUTPUT_MAX).optional(),
    fuzzy: z.boolean().optional(),
    edits: z.array(manuscriptFixEditSchema.extend({
      title: z.string().max(200).optional(),
      note: z.string().max(1000).optional(),
      fuzzy: z.boolean().optional(),
    })).max(20).optional(),
  }).refine((v) => !!v.find || !!v.replace || (Array.isArray(v.edits) && v.edits.length > 0), {
    message: 'Fix must include find/replace or edits',
  }).nullable().optional(),
}).strict();

// Versioned free-text section save — writes one issue's manuscript stage.
export const manuscriptSectionSaveSchema = z.object({
  stageId: z.enum(MANUSCRIPT_TYPES),
  output: z.string().max(STAGE_OUTPUT_MAX),
});

export const manuscriptReformatSchema = z.object({
  stageId: z.enum(MANUSCRIPT_TYPES),
  content: z.string().max(STAGE_OUTPUT_MAX),
  ...providerOverrideShape,
});

// Full series manuscript in a chosen format (prose / teleplay / comic script).
// `?type=` selects the format; absent → the series' pinned primaryManuscriptType,
// else the auto-detected dominant format. Returns the requested format's
// sections plus the metadata the editor's format switcher needs.
export const manuscriptViewQuerySchema = z.object({ type: z.string().optional() });

// Rewrite request — povCharacterId required (a cast id or name); sourceStage
// optional (defaults to prose → comic script → teleplay); provider/model
// optional (falls through to the active or stage-pinned provider).
export const povRewriteSchema = z.object({
  povCharacterId: z.string().trim().min(1).max(120),
  sourceStage: z.enum(['prose', 'comicScript', 'teleplay']).optional(),
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
});

// Reverse-outline and continuity extraction share provider overrides and a forced rerun.
export const manuscriptAnalysisGenerateSchema = z.object({
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
  force: z.boolean().optional(),
});
