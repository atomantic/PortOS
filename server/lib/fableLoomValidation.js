/**
 * Zod schemas for the FableLoom routes. Length caps come straight from
 * LOOM_LIMITS (the sanitizer's constants) so the door check and the
 * enforcement layer can never drift — the sprite/creative-commission
 * validation modules follow the same import-the-service-constants pattern.
 */

import { z } from 'zod';
import { LOOM_LIMITS } from './fableLoomLimits.js';
import { LOOM_FORMATS } from './fableLoomFormats.js';
import {
  FABLELOOM_AUDIO_TARGETS,
  FABLELOOM_HOLD_ROTATION_MODES,
  FABLELOOM_PLAYBACK_MODES,
  FABLELOOM_PROTAGONIST_PRESENCE,
} from './fableLoomPlayback.js';
import {
  FABLELOOM_AUDIENCE_CONNECTION_STATES,
  FABLELOOM_PARTICIPATION_MODES,
} from './fableLoomParticipation.js';
import {
  FABLELOOM_ASSET_TYPES,
  FABLELOOM_PRODUCTION_MODES,
} from './fableLoomProduction.js';
import { FABLELOOM_PLAYTEST_LIMITS } from './fableLoomPlaytest.js';
import { EFFORT_LEVELS } from './providerModels.js';
import { QUEUEABLE_IMAGE_MODES, VIDEO_GEN_MODES } from './generationModes.js';
import { llmRoutePinSchema } from './llmRoutePin.js';

const name = z.string().trim().min(1).max(LOOM_LIMITS.NAME_MAX);
const logline = z.string().max(LOOM_LIMITS.LOGLINE_MAX);
const premise = z.string().max(LOOM_LIMITS.PREMISE_MAX);
const styleNotes = z.string().max(LOOM_LIMITS.STYLE_NOTES_MAX);
const participationMode = z.enum(FABLELOOM_PARTICIPATION_MODES);
const audienceCommunicationMedium = z.string().max(LOOM_LIMITS.AUDIENCE_COMMUNICATION_MEDIUM_MAX);
const refId = z.string().max(LOOM_LIMITS.REF_ID_MAX).nullable();
const title = z.string().max(LOOM_LIMITS.EPISODE_TITLE_MAX);
const synopsis = z.string().max(LOOM_LIMITS.SYNOPSIS_MAX);
const nodeIdStr = z.string().min(1).max(80);
const format = z.enum(LOOM_FORMATS);
// The loom's pinned play routing is the shared per-record LLM route pin
// (`server/lib/llmRoutePin.js`), nullable as a whole so the UI can clear it
// outright. Its `effort` is the shared ladder enum rather than a free string —
// the runner would clamp an unknown level silently, and the door check is
// where a typo should surface.
const playSettings = llmRoutePinSchema.nullable();
const planItemId = z.string().min(1).max(80).optional();
const planEpisodeId = z.string().min(1).max(80).nullable().optional();
const planItemFields = {
  id: planItemId,
  title: z.string().max(LOOM_LIMITS.PLAN_ITEM_TITLE_MAX),
  description: z.string().max(LOOM_LIMITS.PLAN_ITEM_DESCRIPTION_MAX),
};
const seriesPlan = z.object({
  storyArc: z.string().max(LOOM_LIMITS.STORY_ARC_MAX),
  plotPoints: z.array(z.object({
    ...planItemFields,
    episodeId: planEpisodeId,
  })).max(LOOM_LIMITS.PLAN_ITEMS_MAX),
  sideQuests: z.array(z.object({
    ...planItemFields,
    status: z.enum(['idea', 'planned', 'active', 'resolved']),
    startEpisodeId: planEpisodeId,
    endEpisodeId: planEpisodeId,
  })).max(LOOM_LIMITS.PLAN_ITEMS_MAX),
  deliveryOptions: z.object({
    overnightVoicemails: z.boolean().optional(),
    nextSeasonTeaser: z.boolean().optional(),
  }).optional(),
  interEpisodeVoicemails: z.array(z.object({
    id: planItemId,
    fromEpisodeId: planEpisodeId,
    toEpisodeId: planEpisodeId,
    title: z.string().max(LOOM_LIMITS.PLAN_ITEM_TITLE_MAX),
    transcript: z.string().max(LOOM_LIMITS.DELIVERY_MESSAGE_MAX),
  })).max(LOOM_LIMITS.EPISODES_MAX).optional(),
  nextSeasonTeaser: z.object({
    title: z.string().max(LOOM_LIMITS.PLAN_ITEM_TITLE_MAX),
    transcript: z.string().max(LOOM_LIMITS.DELIVERY_MESSAGE_MAX),
  }).nullable().optional(),
});

const outlineTransitionSchema = z.object({
  targetKey: z.string().max(LOOM_LIMITS.OUTLINE_KEY_MAX),
  intent: z.string().max(LOOM_LIMITS.INTENT_MAX),
});

const outlineValidationSchema = z.object({
  status: z.enum(['draft', 'valid', 'invalid']).optional(),
  issues: z.array(z.object({
    code: z.string().max(80).optional(),
    severity: z.enum(['error', 'warning']).optional(),
    message: z.string().max(LOOM_LIMITS.OUTLINE_ISSUE_MESSAGE_MAX),
    sceneKey: z.string().max(LOOM_LIMITS.OUTLINE_KEY_MAX).optional(),
    transitionIndex: z.number().int().min(0).optional(),
  })).max(LOOM_LIMITS.OUTLINE_ISSUES_MAX).optional(),
  validatedAt: z.string().max(80).optional(),
}).optional();

const storyOutline = z.object({
  version: z.number().int().min(1).max(1).optional(),
  startKey: z.string().max(LOOM_LIMITS.OUTLINE_KEY_MAX).nullable().optional(),
  scenes: z.array(z.object({
    key: z.string().max(LOOM_LIMITS.OUTLINE_KEY_MAX),
    title: z.string().max(LOOM_LIMITS.NODE_TITLE_MAX).optional(),
    summary: z.string().max(LOOM_LIMITS.OUTLINE_SUMMARY_MAX).optional(),
    playbackMode: z.enum(['cut', 'decision']).optional(),
    audienceConnection: z.enum(['connected', 'disconnected']).optional(),
    protagonistPresence: z.enum(FABLELOOM_PROTAGONIST_PRESENCE).optional(),
    isEnding: z.boolean().optional(),
    endingLabel: z.string().max(LOOM_LIMITS.ENDING_LABEL_MAX).optional(),
    transitions: z.array(outlineTransitionSchema).max(LOOM_LIMITS.OUTLINE_TRANSITIONS_MAX).optional(),
  })).max(LOOM_LIMITS.OUTLINE_SCENES_MAX),
  validation: outlineValidationSchema,
}).nullable().optional();

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
  participationMode: participationMode.optional(),
  audienceCommunicationMedium: audienceCommunicationMedium.optional(),
  format: format.optional(),
  playSettings: playSettings.optional(),
  seriesPlan: seriesPlan.optional(),
  protagonistCharacterId: refId.optional(),
  protagonistWardrobeId: refId.optional(),
  protagonistWardrobeLocked: z.boolean().optional(),
  universeId: refId.optional(),
  seriesId: refId.optional(),
});

export const loomPatchSchema = z.object({
  name: name.optional(),
  logline: logline.optional(),
  premise: premise.optional(),
  styleNotes: styleNotes.optional(),
  participationMode: participationMode.optional(),
  audienceCommunicationMedium: audienceCommunicationMedium.optional(),
  format: format.optional(),
  playSettings: playSettings.optional(),
  seriesPlan: seriesPlan.optional(),
  protagonistCharacterId: refId.optional(),
  protagonistWardrobeId: refId.optional(),
  protagonistWardrobeLocked: z.boolean().optional(),
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
  storyOutline,
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

const visualCanonSchema = z.object({
  mode: z.enum(['locked', 'draft']).optional(),
  characterAppearances: z.array(z.object({
    characterId: refId.unwrap(),
    wardrobeId: refId.unwrap().nullable().optional(),
    expression: z.string().max(LOOM_LIMITS.VISUAL_NOTE_MAX).optional(),
    continuityNotes: z.string().max(LOOM_LIMITS.VISUAL_NOTE_MAX).optional(),
  })).max(LOOM_LIMITS.VISUAL_BINDINGS_MAX).optional(),
  placeId: refId.optional(),
  objectIds: z.array(refId.unwrap()).max(LOOM_LIMITS.VISUAL_BINDINGS_MAX).optional(),
  continuitySourceNodeId: nodeIdStr.nullable().optional(),
  shotNotes: z.string().max(LOOM_LIMITS.VISUAL_NOTE_MAX).optional(),
  storyboardImageApproved: z.boolean().optional(),
}).nullable();

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

const audioIntervalSchema = z.object({
  startMs: z.number().min(0),
  endMs: z.number().min(0),
  characterId: z.string().max(80).optional(),
  speaker: z.string().max(100).optional(),
  blocking: z.boolean().optional(),
  name: z.string().max(100).optional(),
});

export const audioOccupancySchema = z.object({
  durationMs: z.number().min(0).optional(),
  characterDialogue: z.array(audioIntervalSchema).max(LOOM_LIMITS.AUDIO_INTERVALS_MAX).optional(),
  music: z.array(audioIntervalSchema).max(LOOM_LIMITS.AUDIO_INTERVALS_MAX).optional(),
  effects: z.array(audioIntervalSchema).max(LOOM_LIMITS.AUDIO_INTERVALS_MAX).optional(),
  clipping: z.boolean().optional(),
  clipped: z.boolean().optional(),
  clippingDetected: z.boolean().optional(),
  peakDb: z.number().optional(),
  truePeakDb: z.number().optional(),
  safeForLiveVoice: z.boolean().optional(),
});

export const playbackAssetsSchema = z.object({
  entryVideoHistoryId: z.string().max(200).nullable().optional(),
  holdLoopVideoHistoryIds: z.array(z.string().max(200)).max(LOOM_LIMITS.HOLD_LOOPS_MAX).optional(),
  exitByTransition: z.record(z.string(), z.string().max(200)).optional(),
  audioOccupancy: z.record(z.string(), audioOccupancySchema).optional(),
  provenance: z.record(z.string(), z.any()).nullable().optional(),
  visualConditioningByAsset: z.record(z.string().max(200), z.record(z.string(), z.any())).optional(),
}).nullable();

export const interactionWindowSchema = z.object({
  enabled: z.boolean().optional(),
  protagonistCharacterId: z.string().max(LOOM_LIMITS.REF_ID_MAX).nullable().optional(),
  protagonistPresence: z.enum(FABLELOOM_PROTAGONIST_PRESENCE).optional(),
  audioTarget: z.enum(FABLELOOM_AUDIO_TARGETS).optional(),
  ambientDuckDb: z.number().min(LOOM_LIMITS.AMBIENT_DUCK_DB_MIN).max(LOOM_LIMITS.AMBIENT_DUCK_DB_MAX).optional(),
  holdLoopRotation: z.enum(FABLELOOM_HOLD_ROTATION_MODES).optional(),
}).nullable();

const nodeFields = {
  title: z.string().max(LOOM_LIMITS.NODE_TITLE_MAX).optional(),
  prose: z.string().max(LOOM_LIMITS.PROSE_MAX).optional(),
  imagePrompt: z.string().max(LOOM_LIMITS.IMAGE_PROMPT_MAX).optional(),
  videoPrompt: z.string().max(LOOM_LIMITS.VIDEO_PROMPT_MAX).optional(),
  cameraMovement: z.string().max(LOOM_LIMITS.CAMERA_MOVEMENT_MAX).optional(),
  visualCanon: visualCanonSchema.optional(),
  playbackMode: z.enum(FABLELOOM_PLAYBACK_MODES).optional(),
  audienceConnection: z.enum(FABLELOOM_AUDIENCE_CONNECTION_STATES).optional(),
  protagonistPresence: z.enum(FABLELOOM_PROTAGONIST_PRESENCE).nullable().optional(),
  videoHistoryId: z.string().max(200).nullable().optional(),
  playbackAssets: playbackAssetsSchema.optional(),
  interactionWindow: interactionWindowSchema.optional(),
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

// A per-call pick carries the same three dimensions as the saved pin.
const llmPickFields = llmRoutePinSchema.shape;
const aiRunFields = { ...llmPickFields, operationId: z.string().uuid().optional() };

export const weaveSchema = z.object({
  guidance: z.string().max(4000).optional(),
  replace: z.boolean().optional(),
  expandFromOutline: z.boolean().optional(),
  ...aiRunFields,
});

export const outlineGenerateSchema = z.object({
  guidance: z.string().max(4000).optional(),
  ...aiRunFields,
});

export const outlineReviewSchema = z.object({ ...aiRunFields });

export const outlineValidateSchema = z.object({});

export const branchSchema = z.object({
  guidance: z.string().max(4000).optional(),
  branchCount: z.number().int().min(1).max(4).optional(),
  ...aiRunFields,
});

export const reviewSchema = z.object({ ...aiRunFields });

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
  ...aiRunFields,
}).refine((body) => body.message || body.transitionId, {
  message: 'A play turn needs either a message or a transitionId',
  path: ['message'],
});

export const reformatSchema = z.object({
  format,
  ...aiRunFields,
});

export const feedbackSchema = z.object({
  feedback: z.string().trim().min(1).max(LOOM_LIMITS.FEEDBACK_MAX),
  ...aiRunFields,
});

export const seriesPlanReviewSchema = z.object({ ...aiRunFields });

export const seriesPlanGenerateSchema = z.object({ ...aiRunFields });

export const seriesPlanFeedbackSchema = z.object({
  feedback: z.string().trim().min(1).max(LOOM_LIMITS.FEEDBACK_MAX),
  ...aiRunFields,
});

export const editorialRemediateSchema = z.object({
  guidance: z.string().max(LOOM_LIMITS.FEEDBACK_MAX).optional(),
  ...aiRunFields,
});

export const playthroughReviewSchema = z.object({
  aiReview: z.boolean().optional().default(true),
  maxPaths: z.number().int().min(1).max(FABLELOOM_PLAYTEST_LIMITS.MAX_PATHS).optional(),
  ...aiRunFields,
});

export const editorialAutopilotStartSchema = z.object({
  maxRounds: z.number().int().min(1).max(LOOM_LIMITS.EDITORIAL_AUTOPILOT_ROUNDS_MAX).optional(),
  maxPaths: z.number().int().min(1).max(FABLELOOM_PLAYTEST_LIMITS.MAX_PATHS).optional(),
  ...llmPickFields,
});

export const hostedSessionCreateSchema = z.object({
  audioTarget: z.enum(FABLELOOM_AUDIO_TARGETS).optional(),
  startNodeId: nodeIdStr.optional(),
  ttlMinutes: z.number().int().min(1).max(180).optional(),
});

export const hostedSessionPatchSchema = z.object({
  audioTarget: z.enum(FABLELOOM_AUDIO_TARGETS).optional(),
  currentNodeId: nodeIdStr.optional(),
  playbackPhase: z.enum(['entry', 'hold', 'exit', 'ended']).optional(),
  activeHoldIndex: z.number().int().min(0).max(10).optional(),
});

export const productionPlanSchema = z.object({
  mode: z.enum(FABLELOOM_PRODUCTION_MODES).optional(),
  imageMode: z.enum(QUEUEABLE_IMAGE_MODES).optional(),
  imageModel: z.string().trim().min(1).max(200).optional(),
  videoMode: z.enum(VIDEO_GEN_MODES).optional(),
  videoModel: z.string().trim().min(1).max(200).optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
});

export const productionBatchCreateSchema = z.object({
  mode: z.enum(FABLELOOM_PRODUCTION_MODES).optional(),
  assetTypes: z.array(z.enum(FABLELOOM_ASSET_TYPES)).max(20).optional(),
  nodeIds: z.array(nodeIdStr).max(LOOM_LIMITS.NODES_MAX).optional(),
  imageMode: z.enum(QUEUEABLE_IMAGE_MODES).optional(),
  imageModel: z.string().trim().min(1).max(200).optional(),
  videoMode: z.enum(VIDEO_GEN_MODES).optional(),
  videoModel: z.string().trim().min(1).max(200).optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
});

export const continuityReviewSchema = z.object({});
