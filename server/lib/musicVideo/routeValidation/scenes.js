/** Request schemas for Music Video board edits, scene renders, and takes. */

import { z } from 'zod';
import { COLOR_MATCH_LIMITS } from '../../shotColorMatch.js';
import { MUSIC_VIDEO_RENDER_TIERS, MUSIC_VIDEO_UPGRADE_METHODS } from '../musicVideoRenderTier.js';
import { galleryImageName, musicVideoUpscaleFields } from '../musicVideoValidation.js';
import { MUSIC_VIDEO_WIPES, MUSIC_VIDEO_WIPE_SEC } from '../musicVideoWipes.js';
import { videoHistoryIdSchema } from './shared.js';

export { musicVideoTakeInputSchema } from './shared.js';
export { musicVideoSceneCreateSchema, musicVideoSceneUpdateSchema } from '../musicVideoValidation.js';

const MUSIC_VIDEO_TAKE_STATUSES = ['candidate', 'rejected'];

/** Undo restores a take only while its slot still holds the operation's result. */
export const musicVideoTakeSelectSchema = z.object({
  expectedSelectedAssetId: z.string().min(1).max(256).nullable().optional(),
}).strict();

/** Move one take to another shot of the same project (organizing takes; the files stay where they are). */
export const musicVideoTakeMoveSchema = z.object({
  toSceneId: z.string().min(1).max(128),
}).strict();

// Put an unused still or clip from the project's pool on a shot; `withAssetId` is its partner (a still's clip, a clip's still).
// `endImage` puts a still on the shot's end frame; only a start still pairs with a clip.
export const musicVideoPoolUseSchema = z.object({
  kind: z.enum(['image', 'video', 'endImage']),
  assetId: z.string().min(1).max(256),
  withAssetId: z.string().min(1).max(256).optional(),
}).strict().superRefine((input, ctx) => {
  if (input.kind === 'endImage' && input.withAssetId !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['withAssetId'], message: 'An end frame is placed on its own' });
  }
  const [still, clip] = input.kind === 'video' ? [input.withAssetId, input.assetId] : [input.assetId, input.withAssetId];
  for (const [value, schema, path] of [[still, galleryImageName, input.kind === 'video' ? 'withAssetId' : 'assetId'], [clip, videoHistoryIdSchema, input.kind === 'video' ? 'assetId' : 'withAssetId']]) {
    if (value === undefined) continue;
    const parsed = schema.safeParse(value);
    if (!parsed.success) ctx.addIssue({ code: 'custom', path: [path], message: parsed.error.issues[0].message });
  }
});

// Review a take: reject/restore it, leave a note for regeneration, acknowledge a rendering defect or confirm a frame.
export const musicVideoTakeReviewSchema = z.object({
  acknowledgeRenderQuality: z.object({ basis: z.string().min(1), note: z.string().min(1).max(1000) }).strict().optional(),
  // The selected frame still matches the shot's current prompt (#15982).
  confirmFrame: z.literal(true).optional(),
  // The take still matches its characters' current reference images (#16473), at the revision the warning showed.
  acceptCharacterReferences: z.object({ revision: z.string().min(1).max(128) }).strict().optional(),
  status: z.enum(MUSIC_VIDEO_TAKE_STATUSES).optional(),
  note: z.string().max(1000).nullable().optional(),
}).strict().refine((r) => r.status !== undefined || r.note !== undefined || r.acknowledgeRenderQuality !== undefined || r.confirmFrame !== undefined
  || r.acceptCharacterReferences !== undefined, { message: 'status, note, acknowledgement or confirmation is required' });

const colorMatchNumber = (key) => z.number().min(COLOR_MATCH_LIMITS[key][0]).max(COLOR_MATCH_LIMITS[key][1]);

const musicVideoColorMatchCorrectionSchema = z.object({
  black: colorMatchNumber('black'),
  white: colorMatchNumber('white'),
  gamma: colorMatchNumber('gamma'),
  balanceR: colorMatchNumber('balanceR'),
  balanceB: colorMatchNumber('balanceB'),
  saturation: colorMatchNumber('saturation'),
}).strict();

export const musicVideoColorMatchTakePatchSchema = z.object({
  enabled: z.boolean().optional(),
  strength: z.number().min(0).max(1).optional(),
  correction: musicVideoColorMatchCorrectionSchema.optional(),
}).strict().refine((body) => body.enabled !== undefined || body.strength !== undefined || body.correction !== undefined, {
  message: 'enabled, strength or correction is required',
});

// Start a shot from the previous shot's on-screen out-frame; optionally keep
// the current start frame as its end frame.
export const musicVideoContinueShotSchema = z.object({ keepStillAsEnd: z.boolean().optional() }).strict();

// "Vary wipes" (musicVideoWipes.js): a wipe out of each of `count` shots from `fromSceneId` in song
// order, no style twice in a row, drawn from `styles` (default every wipe).
export const musicVideoVaryWipesSchema = z.object({
  fromSceneId: z.string().min(1).max(200),
  count: z.number().int().min(1).max(1000),
  styles: z.array(z.enum(MUSIC_VIDEO_WIPES)).min(1).max(MUSIC_VIDEO_WIPES.length).optional(),
  lengthSec: z.number().min(MUSIC_VIDEO_WIPE_SEC.min).max(MUSIC_VIDEO_WIPE_SEC.max).nullable().optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i, 'color is #rrggbb').nullable().optional(),
  seed: z.number().int().min(0).max(2147483646).optional(),
}).strict();

// Reorder the board: the full set of scene ids in their new order.
export const musicVideoSceneReorderSchema = z.object({
  sceneIds: z.array(z.string().min(1).max(64)).min(1).max(500),
}).strict();

// Split an over-long shot on lyric/phrase boundaries (#8977). `backend` is
// the lane the director will render with; omitted/null = the project's pin.
export const musicVideoSceneSplitSchema = z.object({
  backend: z.enum(['local', 'grok', 'fal', 'runway', 'gemini', 'higgsfield', 'google']).nullable().optional(),
  // Split the shot in two at this song time instead of by the backend's longest take.
  atSec: z.number().finite().nonnegative().optional(),
}).strict();

// Cut shots on sung words (#14820): one shot per phrase or per word over the chosen lyric lines.
export const musicVideoLyricCutSchema = z.object({
  cueIds: z.array(z.string().min(1).max(64)).min(1).max(2000),
  mode: z.enum(['phrase', 'word']),
}).strict();

// Move where a shot starts; the shot before it ends there too, so the cut moves and nothing gaps or overlaps.
export const musicVideoSceneStartSchema = z.object({
  startSec: z.number().finite().nonnegative(),
}).strict();

// Move where a shot ends; the next shot starts there too, so it grows or shrinks to meet it.
export const musicVideoSceneEndSchema = z.object({
  endSec: z.number().finite().positive(),
}).strict();

// Shot-card frame and clip renders (#15583). The server loads cast media and
// the shot's references; the client sends the shot and the slot.
const musicVideoFrameImageTargetSchema = z.object({
  mode: z.string().min(1).max(40),
  modelId: z.string().min(1).max(300).optional(),
  cloudModel: z.string().min(1).max(300).optional(),
}).strict();

const musicVideoThenClipSchema = z.object({
  backend: z.string().min(1).max(40).optional(),
  model: z.string().min(1).max(300).optional(),
  songAudio: z.boolean().optional(),
}).strict();

export const musicVideoSceneFrameRenderSchema = z.object({
  slot: z.enum(['start', 'end']).optional(),
  select: z.boolean().optional(),
  imageTarget: musicVideoFrameImageTargetSchema.optional(),
  refine: z.string().max(32000).optional(),
  includeReferences: z.boolean().optional(),
  fromFrame: z.boolean().optional(),
  referenceImageId: galleryImageName.optional(),
  revisionId: z.string().min(1).max(200).optional(),
  thenClip: musicVideoThenClipSchema.optional(),
}).strict();

const musicVideoSceneIdListSchema = z.array(z.string().min(1).max(64)).min(1).max(200);

// A clip is either the video body the shot card already builds, or a short
// form (`card` / `target`) the server expands. The video route re-validates
// the assembled body, so provider fields stay on this object.
const musicVideoClipCardSchema = z.object({
  prompt: z.string().max(32000).optional(),
  endFrame: z.boolean().optional(),
  songAudio: z.boolean().optional(),
  wholeLine: z.boolean().optional(),
  ltxReferences: z.boolean().optional(),
  startFrameLayout: z.boolean().optional(),
  frameRoute: z.enum(['reference', 'image']).optional(),
  expectedClipReferenceFiles: z.array(galleryImageName).max(16).optional(),
  expectedClipReferenceLabels: z.array(z.string().max(200)).max(16).optional(),
}).strict();

const musicVideoClipTargetSchema = z.object({
  backend: z.enum(['local', 'grok', 'fal', 'runway', 'gemini', 'higgsfield', 'google']).optional(),
  modelId: z.string().max(300).optional(),
  generationMode: z.string().max(80).optional(),
  higgsfieldModelId: z.string().min(1).max(100).nullable().optional(),
  higgsfieldDuration: z.number().int().min(2).max(30).nullable().optional(),
  higgsfieldResolution: z.enum(['480p', '720p', '1080p']).nullable().optional(),
  googleModelId: z.string().min(1).max(100).nullable().optional(),
  googleDuration: z.number().int().min(1).max(60).nullable().optional(),
  googleResolution: z.enum(['720p', '1080p']).nullable().optional(),
  grokDuration: z.number().positive().max(60).optional(),
  numFrames: z.number().int().positive().max(1000).optional(),
  audioReactiveScale: z.number().min(0).max(4).optional(),
}).strict();

export const musicVideoSceneClipRenderSchema = z.object({
  revisionId: z.string().min(1).max(200).optional(),
  // Draft or final clip (#16136): the shot's model renders at the project's tier
  // resolution unless the request names one; the take records the tier.
  tier: z.enum(MUSIC_VIDEO_RENDER_TIERS).optional(),
  prompt: z.string().max(32000).optional(),
  card: musicVideoClipCardSchema.optional(),
  target: musicVideoClipTargetSchema.optional(),
}).passthrough();

// #16136: approve (or clear) shots for the final-resolution upgrade.
export const musicVideoApproveFinalSchema = z.object({
  sceneIds: musicVideoSceneIdListSchema,
  approved: z.boolean(),
});

// #16136: upgrade approved shots; no sceneIds = every approved shot. dryRun prices the plan and renders nothing.
export const musicVideoUpgradeSchema = z.object({
  sceneIds: musicVideoSceneIdListSchema.optional(),
  method: z.enum(MUSIC_VIDEO_UPGRADE_METHODS),
  ...musicVideoUpscaleFields,
  topazQuotes: z.record(z.string().min(1).max(128), z.string().uuid()).optional(),
  dryRun: z.boolean().optional(),
});

export const musicVideoPerformanceRepairSchema = z.object({
  excerptId: z.string().min(1).max(200),
  sourceAssetId: z.string().min(1).max(200),
  boundarySec: z.number().finite().min(0).max(36000),
}).strict();
