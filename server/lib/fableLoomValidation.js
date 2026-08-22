/**
 * Zod schemas for the FableLoom routes. Length caps come straight from
 * LOOM_LIMITS (the sanitizer's constants) so the door check and the
 * enforcement layer can never drift — the sprite/creative-commission
 * validation modules follow the same import-the-service-constants pattern.
 */

import { z } from 'zod';
import { LOOM_LIMITS } from '../services/fableLoom/limits.js';
import { LOOM_FORMATS } from '../services/fableLoom/formats.js';
import { EFFORT_LEVELS } from './providerModels.js';

const name = z.string().trim().min(1).max(LOOM_LIMITS.NAME_MAX);
const logline = z.string().max(LOOM_LIMITS.LOGLINE_MAX);
const premise = z.string().max(LOOM_LIMITS.PREMISE_MAX);
const styleNotes = z.string().max(LOOM_LIMITS.STYLE_NOTES_MAX);
const refId = z.string().max(LOOM_LIMITS.REF_ID_MAX).nullable();
const title = z.string().max(LOOM_LIMITS.EPISODE_TITLE_MAX);
const synopsis = z.string().max(LOOM_LIMITS.SYNOPSIS_MAX);
const nodeIdStr = z.string().min(1).max(80);
const format = z.enum(LOOM_FORMATS);
// The loom's pinned play routing. Nullable per field ('' from a cleared select
// is normalized to null by the sanitizer) and nullable as a whole, so the UI
// can clear the pin outright. `effort` is the shared ladder enum, not a free
// string — the runner would clamp an unknown level silently, and the door
// check is where a typo should surface.
const effort = z.enum(EFFORT_LEVELS);
const playSettings = z.object({
  providerId: z.string().max(LOOM_LIMITS.PROVIDER_ID_MAX).nullable().optional(),
  model: z.string().max(LOOM_LIMITS.MODEL_ID_MAX).nullable().optional(),
  effort: effort.nullable().optional(),
}).nullable();

// Index filter. `?seriesId=` scopes the list to the looms soft-linked to one
// pipeline series (the series detail page's "Branching narratives" card). An
// empty value is a no-op filter, not a 400 — a UI that builds the query from a
// possibly-unset id should not have to branch on it.
export const loomListQuerySchema = z.object({
  seriesId: z.string().max(LOOM_LIMITS.REF_ID_MAX).optional(),
});

export const loomCreateSchema = z.object({
  name,
  logline: logline.optional(),
  premise: premise.optional(),
  styleNotes: styleNotes.optional(),
  format: format.optional(),
  playSettings: playSettings.optional(),
  universeId: refId.optional(),
  seriesId: refId.optional(),
});

export const loomPatchSchema = z.object({
  name: name.optional(),
  logline: logline.optional(),
  premise: premise.optional(),
  styleNotes: styleNotes.optional(),
  format: format.optional(),
  playSettings: playSettings.optional(),
  universeId: refId.optional(),
  seriesId: refId.optional(),
});

export const episodeCreateSchema = z.object({
  title: title.optional(),
  synopsis: synopsis.optional(),
});

export const episodePatchSchema = z.object({
  title: title.optional(),
  synopsis: synopsis.optional(),
  number: z.number().int().min(1).max(9999).optional(),
  startNodeId: nodeIdStr.nullable().optional(),
});

const transitionFields = {
  targetNodeId: nodeIdStr,
  intent: z.string().max(LOOM_LIMITS.INTENT_MAX),
  triggers: z.array(z.string().max(LOOM_LIMITS.TRIGGER_MAX)).max(LOOM_LIMITS.TRIGGERS_MAX).optional(),
  description: z.string().max(LOOM_LIMITS.TRANSITION_DESC_MAX).optional(),
};

// Whole-array replace on the node PATCH. Kept for back-compat with clients
// that predate the transition sub-resources (`id` is echoed back so a replace
// preserves the rows it did not change); new writers use the sub-resources.
const transitionSchema = z.object({
  id: z.string().max(80).optional(),
  ...transitionFields,
});

// Sub-resource POST: no `id` — the server mints it.
export const transitionCreateSchema = z.object(transitionFields);

// Sub-resource PATCH: every field optional, but `intent` may be cleared to ''
// (a path can legitimately carry only trigger phrasings), so `.optional()`
// rather than a min length is what distinguishes absent from cleared.
export const transitionPatchSchema = z.object({
  targetNodeId: nodeIdStr.optional(),
  intent: transitionFields.intent.optional(),
  triggers: transitionFields.triggers,
  description: transitionFields.description,
});

const nodeFields = {
  title: z.string().max(LOOM_LIMITS.NODE_TITLE_MAX).optional(),
  prose: z.string().max(LOOM_LIMITS.PROSE_MAX).optional(),
  imagePrompt: z.string().max(LOOM_LIMITS.IMAGE_PROMPT_MAX).optional(),
  isEnding: z.boolean().optional(),
  endingLabel: z.string().max(LOOM_LIMITS.ENDING_LABEL_MAX).optional(),
  pos: z.object({ x: z.number(), y: z.number() }).nullable().optional(),
  transitions: z.array(transitionSchema).max(LOOM_LIMITS.TRANSITIONS_MAX).optional(),
};

export const nodeCreateSchema = z.object({
  ...nodeFields,
  // Optionally wire the new scene in as a branch of an existing one.
  fromNodeId: nodeIdStr.optional(),
  fromIntent: z.string().max(LOOM_LIMITS.INTENT_MAX).optional(),
});

export const nodePatchSchema = z.object(nodeFields);

const llmPickFields = {
  providerId: z.string().max(LOOM_LIMITS.PROVIDER_ID_MAX).optional(),
  model: z.string().max(LOOM_LIMITS.MODEL_ID_MAX).optional(),
  effort: effort.optional(),
};

export const weaveSchema = z.object({
  guidance: z.string().max(4000).optional(),
  nodeTarget: z.number().int().min(3).max(60).optional(),
  endingTarget: z.number().int().min(1).max(12).optional(),
  replace: z.boolean().optional(),
  ...llmPickFields,
});

export const branchSchema = z.object({
  guidance: z.string().max(4000).optional(),
  branchCount: z.number().int().min(1).max(4).optional(),
  ...llmPickFields,
});

export const reviewSchema = z.object({ ...llmPickFields });

// A turn is EITHER a reader's free text (matched to a path by the play stage)
// or a path the reader took outright — a tapped choice needs no intent
// mapping, so it carries the transition id and no LLM call happens at all.
export const playTurnSchema = z.object({
  nodeId: nodeIdStr,
  message: z.string().min(1).max(1000).optional(),
  transitionId: z.string().min(1).max(80).optional(),
  transcript: z.array(z.object({
    role: z.enum(['reader', 'narrator']),
    text: z.string().max(4000),
  })).max(50).optional(),
  ...llmPickFields,
}).refine((body) => body.message || body.transitionId, {
  message: 'A play turn needs either a message or a transitionId',
  path: ['message'],
});

export const reformatSchema = z.object({
  format,
  ...llmPickFields,
});
