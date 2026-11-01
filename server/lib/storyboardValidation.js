/**
 * Zod schemas for the Storyboards routes. Caps and vocabularies come from
 * storyboardRecord.js (the sanitizer's constants) so the route check and the
 * normalizer cannot drift. Over-limit text is refused here, never cut.
 */

import { z } from 'zod';
import {
  STORYBOARD_ART_STYLES, STORYBOARD_ASPECT_RATIOS, STORYBOARD_LIMITS as L, STORYBOARD_MUSICAL_ROLES,
  STORYBOARD_PANEL_ANGLES, STORYBOARD_PANEL_COMPOSITIONS, STORYBOARD_PANEL_EYELINES, STORYBOARD_PANEL_FACINGS, STORYBOARD_PANEL_FOCUSES,
  STORYBOARD_PANEL_FRAMINGS, STORYBOARD_PANEL_LENSES, STORYBOARD_PANEL_MOVES, STORYBOARD_TAKE_SOURCES,
} from './storyboardVocabulary.js';
import { RECIPE_LIMITS as R, RECIPE_NODE_TYPES, RECIPE_PORT_LABELS } from './storyboardRecipe.js';
import { BEAT_EXTRACT_LIMITS } from './storyboardBeatExtract.js';
import { localImageFilename } from './localImageFilename.js';
import { isStoryboardTempTrackFilename } from './storyboardRecord.js';
import { creativeDirectorProjectCreateSchema } from './creativeDirectorValidation.js';
import { GREYBOX_SHOT_ID_MAX, GREYBOX_SHOT_ID_PATTERN } from './greyboxVocabulary.js';

const text = (max) => z.string().max(max);
const ref = z.string().trim().min(1).max(L.refId);
const nullableRef = ref.nullable();
const refs = z.array(ref).max(L.refs);
const entityId = z.string().trim().min(1).max(120);
const position = z.number().int().min(0).max(10_000);
const markerAt = z.number().min(0).max(L.markerAtMax);

export const storyboardCreateSchema = z.object({
  name: text(L.name).optional(),
  logline: text(L.logline).optional(),
  aspectRatio: z.enum(STORYBOARD_ASPECT_RATIOS).optional(),
  artStyle: z.enum(STORYBOARD_ART_STYLES).optional(),
  universeId: nullableRef.optional(),
  moodBoardId: nullableRef.optional(),
  plot: text(BEAT_EXTRACT_LIMITS.plot).optional(),
  // An audio file already in /api/uploads; null takes the temp track off.
  tempTrack: z.object({
    filename: z.string().refine(isStoryboardTempTrackFilename, { message: 'tempTrack.filename must name an uploaded audio file' }),
    name: text(L.tempTrackName).optional(),
    sections: z.array(z.object({ id: entityId.optional(), label: text(L.sectionLabel), at: markerAt }).strict()).max(L.songSections).optional(),
    lines: z.array(z.object({ id: entityId.optional(), text: text(L.lyricLine), at: markerAt.nullable() }).strict()).max(L.lyricLines).optional(),
  }).strict().nullable().optional(),
}).strict();

export const storyboardUpdateSchema = storyboardCreateSchema;

const beatFields = {
  title: text(L.beatTitle).optional(),
  what: text(L.beatText).optional(),
  why: text(L.beatText).optional(),
  emotion: text(L.emotion).optional(),
  musicalRole: z.enum(STORYBOARD_MUSICAL_ROLES).nullable().optional(),
  sectionHint: text(L.sectionHint).optional(),
  pin: entityId.nullable().optional(),
  beforeSong: z.boolean().optional(),
};

export const storyboardBeatCreateSchema = z.object({ ...beatFields, index: position.optional() }).strict();
export const storyboardBeatUpdateSchema = z.object(beatFields).strict();
export const storyboardMoveSchema = z.object({ index: position }).strict();

const panelFields = {
  action: text(L.panelText).optional(),
  dialogue: text(L.panelText).optional(),
  framing: z.enum(STORYBOARD_PANEL_FRAMINGS).nullable().optional(),
  angle: z.enum(STORYBOARD_PANEL_ANGLES).nullable().optional(),
  facing: z.enum(STORYBOARD_PANEL_FACINGS).nullable().optional(),
  composition: z.enum(STORYBOARD_PANEL_COMPOSITIONS).nullable().optional(),
  move: z.enum(STORYBOARD_PANEL_MOVES).nullable().optional(),
  lens: z.enum(STORYBOARD_PANEL_LENSES).nullable().optional(),
  focus: z.enum(STORYBOARD_PANEL_FOCUSES).nullable().optional(),
  eyeline: z.enum(STORYBOARD_PANEL_EYELINES).nullable().optional(),
  camera: text(L.camera).optional(),
  seconds: z.number().positive().max(L.panelSecondsMax).nullable().optional(),
  castIds: refs.optional(),
  environmentIds: refs.optional(),
  objectIds: refs.optional(),
  // Which gallery image of a linked record Make sends. Null clears every pick.
  // Absent leaves the stored map alone. A value that is not a gallery image is refused.
  linkMedia: z.record(ref, z.string().trim().min(1).max(300).refine((value) => {
    const name = localImageFilename(value);
    return !!name && /\.(png|jpe?g|webp)$/i.test(name);
  }, { message: 'linkMedia values must be gallery image filenames' })).refine(
    (value) => Object.keys(value).length <= L.refs * 3,
    { message: 'linkMedia has too many picks' },
  ).nullable().optional(),
  // Which saved greybox camera of one of its environments the panel is seen from.
  setShot: z.object({ environmentId: ref, shotId: z.string().min(1).max(GREYBOX_SHOT_ID_MAX).regex(GREYBOX_SHOT_ID_PATTERN) }).strict().nullable().optional(),
  notes: text(L.notes).optional(),
};

export const storyboardPanelCreateSchema = z.object({ ...panelFields, index: position.optional() }).strict();
export const storyboardPanelUpdateSchema = z.object(panelFields).strict();
export const storyboardPanelMoveSchema = z.object({ beatId: entityId.optional(), index: position }).strict();

// A take names a gallery image (any source but sketch) or a sketch key.
export const storyboardTakeCreateSchema = z.object({
  source: z.enum(STORYBOARD_TAKE_SOURCES),
  image: z.string().trim().min(1).max(300).optional(),
  sketchKey: z.string().trim().regex(/^sketch:[A-Za-z0-9-]{1,80}$/).optional(),
  refId: ref.optional(),
}).strict().refine(
  (take) => (take.source === 'sketch' ? !!take.sketchKey && !take.image : !!take.image && !take.sketchKey),
  { message: 'A sketch take needs sketchKey; every other take needs image' },
);

// Panel maker. The recipe graph is normalized by sanitizeRecipe; the route
// refuses an over-limit node rather than letting the normalizer drop it.
const recipeImage = z.object({ image: z.string().trim().min(1).max(200), label: text(R.title).optional() }).strict();
const recipeNode = z.object({
  id: z.string().trim().regex(/^node-[A-Za-z0-9-]{1,80}$/),
  type: z.enum(RECIPE_NODE_TYPES),
  title: text(R.title).optional(),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  text: text(R.text).optional(),
  settings: z.record(z.union([z.string().max(256), z.number(), z.boolean(), z.null()])).optional(),
  images: z.array(recipeImage).max(R.images).optional(),
}).strict();
const recipeEdge = z.object({
  from: z.string().trim().min(1).max(90),
  to: z.string().trim().min(1).max(90),
  toPort: z.enum(Object.keys(RECIPE_PORT_LABELS)),
}).strict();

const recipeGraph = z.object({
  nodes: z.array(recipeNode).max(R.nodes),
  edges: z.array(recipeEdge).max(R.nodes * 3),
}).strict();

export const storyboardRecipeSchema = z.object({ recipe: recipeGraph.nullable() }).strict();

// A library entry: a named copy of a board's graph.
export const storyboardSavedRecipeSchema = z.object({
  name: z.string().trim().min(1).max(R.title),
  recipe: recipeGraph.extend({ nodes: z.array(recipeNode).min(1).max(R.nodes) }),
}).strict();

export const storyboardPanelNodeUpdateSchema = z.object({
  text: text(R.text).optional(),
  excludedRefs: z.array(z.string().trim().min(1).max(200)).max(40).optional(),
  extraRefs: z.array(recipeImage).max(R.images).optional(),
}).strict();

// Make empty panels, or Redraw all (every panel, one new frame each).
export const storyboardMakeEmptySchema = z.object({
  redraw: z.boolean().optional(),
  selectNew: z.boolean().optional(),
}).strict();

// A frame correction: the take it starts from and the director's note.
export const storyboardPanelCorrectSchema = z.object({
  takeId: entityId,
  note: z.string().trim().min(1).max(L.panelText),
}).strict();

// Beats from a plot summary: the plot and the LLM pick (blank = the active provider).
const llmField = z.string().trim().max(256).optional();
export const storyboardPlotExtractSchema = z.object({
  plot: text(BEAT_EXTRACT_LIMITS.plot),
  providerId: llmField,
  model: llmField,
  effort: llmField,
}).strict();

// The previewed beats the user adds, each with its panels.
const addedPanel = z.object({
  action: text(L.panelText).optional(),
  dialogue: text(L.panelText).optional(),
  framing: panelFields.framing,
  camera: panelFields.camera,
  seconds: panelFields.seconds,
}).strict();
export const storyboardBeatsAddSchema = z.object({
  beats: z.array(z.object({ ...beatFields, panels: z.array(addedPanel).max(L.panelsPerBeat) }).strict()).min(1).max(L.beats),
}).strict();

// Start a Video from a storyboard: the Video draft drawer's choices plus the
// board revision the shot preview was drawn from. The draft is always a Video.
export const storyboardVideoStartSchema = z.object({
  boardUpdatedAt: z.string().min(1).max(64),
  project: z.preprocess((value) => (value && typeof value === 'object' ? { ...value, workspace: 'video' } : value), creativeDirectorProjectCreateSchema),
}).strict();

// Fit to song: the board revision the preview was built from, and the beat starts the user picked.
export const storyboardFitSchema = z.object({
  boardUpdatedAt: z.string().min(1).max(64),
  starts: z.record(entityId, z.number().min(0).max(36000))
    .refine((starts) => Object.keys(starts).length <= L.beats, { message: `At most ${L.beats} picked starts` }).optional(),
}).strict();

// Sync shots: the board and shot revisions the preview was built from, and
// whether locked shots no panel keeps go too.
export const storyboardShotSyncSchema = z.object({
  boardUpdatedAt: z.string().min(1).max(64),
  projectUpdatedAt: z.string().min(1).max(64).optional(),
  removeLocked: z.boolean().optional(),
  removeWithMedia: z.boolean().optional(),
}).strict();

// Keep a video's shots in sync with its board after each edit (on), or stop (off).
export const storyboardShotSyncAutoSchema = z.object({ on: z.boolean() }).strict();

// Update a pipeline issue's shots from its board: every edited panel, or one shot's.
export const storyboardPipelineUpdateSchema = z.object({
  shotId: z.string().trim().min(1).max(80).optional(),
}).strict();

// Make storyboard from this FableLoom path: the transition ids picked at forks.
export const storyboardFromFableLoomSchema = z.object({
  via: z.array(z.string().min(1).max(128)).max(500).default([]),
}).strict();
