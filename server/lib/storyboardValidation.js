/**
 * Zod schemas for the Storyboards routes. Caps and vocabularies come from
 * storyboardRecord.js (the sanitizer's constants) so the route check and the
 * normalizer cannot drift. Over-limit text is refused here, never cut.
 */

import { z } from 'zod';
import {
  STORYBOARD_ART_STYLES, STORYBOARD_ASPECT_RATIOS, STORYBOARD_LIMITS as L, STORYBOARD_MUSICAL_ROLES,
  STORYBOARD_PANEL_FRAMINGS, STORYBOARD_TAKE_SOURCES,
} from './storyboardVocabulary.js';

const text = (max) => z.string().max(max);
const ref = z.string().trim().min(1).max(L.refId);
const nullableRef = ref.nullable();
const refs = z.array(ref).max(L.refs);
const entityId = z.string().trim().min(1).max(120);
const position = z.number().int().min(0).max(10_000);

export const storyboardCreateSchema = z.object({
  name: text(L.name).optional(),
  logline: text(L.logline).optional(),
  aspectRatio: z.enum(STORYBOARD_ASPECT_RATIOS).optional(),
  artStyle: z.enum(STORYBOARD_ART_STYLES).optional(),
  universeId: nullableRef.optional(),
  moodBoardId: nullableRef.optional(),
}).strict();

export const storyboardUpdateSchema = storyboardCreateSchema;

const beatFields = {
  title: text(L.beatTitle).optional(),
  what: text(L.beatText).optional(),
  why: text(L.beatText).optional(),
  emotion: text(L.emotion).optional(),
  musicalRole: z.enum(STORYBOARD_MUSICAL_ROLES).nullable().optional(),
  sectionHint: text(L.sectionHint).optional(),
};

export const storyboardBeatCreateSchema = z.object({ ...beatFields, index: position.optional() }).strict();
export const storyboardBeatUpdateSchema = z.object(beatFields).strict();
export const storyboardMoveSchema = z.object({ index: position }).strict();

const panelFields = {
  action: text(L.panelText).optional(),
  dialogue: text(L.panelText).optional(),
  framing: z.enum(STORYBOARD_PANEL_FRAMINGS).nullable().optional(),
  camera: text(L.camera).optional(),
  seconds: z.number().positive().max(L.panelSecondsMax).nullable().optional(),
  castIds: refs.optional(),
  environmentIds: refs.optional(),
  objectIds: refs.optional(),
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
