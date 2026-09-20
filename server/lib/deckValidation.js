/**
 * Zod schemas for the `/api/decks` routes. A separate leaf from
 * `deckTemplates.js` so the client can re-export the pure roster/composition
 * helpers without pulling zod into the bundle.
 */

import { z } from 'zod';
import {
  DECK_CARD_ORIENTATIONS, DECK_CARD_SIZE_MAX, DECK_CARD_SIZE_MIN, DECK_KINDS,
} from './deckTemplates.js';
import { llmRoutePinSchema } from './llmRoutePin.js';
import { INFLUENCE_ENTRY_MAX, INFLUENCES_PER_LIST_MAX, STYLE_NOTES_MAX } from './universeBibleLimits.js';

export const DECK_NAME_MAX = 120;
export const DECK_DESCRIPTION_MAX = 2000;
export const DECK_LAYOUT_PROMPT_MAX = 1000;
export const DECK_CARD_PROMPT_MAX = 4000;
export const DECK_CARD_NAME_MAX = 120;
export const DECK_SAMPLES_MAX = 12;
export const DECK_SAMPLE_TITLE_MAX = 120;
export const DECK_SAMPLE_PROMPT_MAX = 4000;
export const DECK_CARD_IMAGE_REFS_MAX = 24;
export const DECK_CARDS_PER_REQUEST_MAX = 120;

const idField = z.string().trim().min(1).max(200);
const galleryFilename = z.string().trim().min(1).max(300);
// Per-call provider/model/effort — the same three fields the deck's stored
// `promptLlm` pin carries, so a route resolves them with `resolveLlmRoutePin`.
const perCallLlm = llmRoutePinSchema.shape;

const influenceEntry = z.string().trim().min(1).max(INFLUENCE_ENTRY_MAX);
const influencesSchema = z.object({
  embrace: z.array(influenceEntry).max(INFLUENCES_PER_LIST_MAX).optional().default([]),
  avoid: z.array(influenceEntry).max(INFLUENCES_PER_LIST_MAX).optional().default([]),
}).strict();

const cardEdge = z.number().int().min(DECK_CARD_SIZE_MIN).max(DECK_CARD_SIZE_MAX);
const cardSizeSchema = z.object({ width: cardEdge, height: cardEdge }).strict();

export const deckCreateSchema = z.object({
  name: z.string().trim().min(1).max(DECK_NAME_MAX),
  kind: z.enum(DECK_KINDS),
  description: z.string().trim().max(DECK_DESCRIPTION_MAX).optional().default(''),
  // Linked universe (optional). `seedStyleFromUniverse` copies its influences
  // + style notes into the deck at creation; the link itself also feeds the
  // casting step (universe cast/places/objects placed on cards).
  universeId: idField.nullable().optional(),
  seedStyleFromUniverse: z.boolean().optional().default(true),
}).strict();

export const deckUpdateSchema = z.object({
  name: z.string().trim().min(1).max(DECK_NAME_MAX).optional(),
  description: z.string().trim().max(DECK_DESCRIPTION_MAX).optional(),
  styleNotes: z.string().trim().max(STYLE_NOTES_MAX).optional(),
  influences: influencesSchema.optional(),
  layoutPrompt: z.string().trim().max(DECK_LAYOUT_PROMPT_MAX).optional(),
  cardOrientation: z.enum(DECK_CARD_ORIENTATIONS).optional(),
  // Null clears the authored override and returns to the built-in prompt for
  // the selected orientation.
  cardOrientationPrompt: z.string().trim().max(DECK_LAYOUT_PROMPT_MAX).nullable().optional(),
  universeId: idField.nullable().optional(),
  // Per-record render pin (#3231 Phase 3 shape): null clears.
  imageMode: z.string().trim().max(40).nullable().optional(),
  imageModelId: z.string().trim().max(64).nullable().optional(),
  cardSize: cardSizeSchema.optional(),
  // The LLM pin for casting + prompt writing; null clears.
  promptLlm: llmRoutePinSchema.nullable().optional(),
}).strict();

export const deckCardUpdateSchema = z.object({
  name: z.string().trim().min(1).max(DECK_CARD_NAME_MAX).optional(),
  prompt: z.string().trim().max(DECK_CARD_PROMPT_MAX).optional(),
  negativePrompt: z.string().trim().max(DECK_CARD_PROMPT_MAX).optional(),
  primaryImageRef: galleryFilename.nullable().optional(),
  // Wholesale replace so the drawer can drop a stale render from the history.
  imageRefs: z.array(galleryFilename).max(DECK_CARD_IMAGE_REFS_MAX).optional(),
  canonRef: z.object({
    kind: z.enum(['character', 'place', 'object']),
    id: idField,
    name: z.string().trim().max(200).optional().default(''),
  }).strict().nullable().optional(),
}).strict();

export const deckAnalyzeSampleSchema = z.object({
  image: galleryFilename,
  title: z.string().trim().max(DECK_SAMPLE_TITLE_MAX).optional(),
  ...perCallLlm,
}).strict();

const sampleSchema = z.object({
  id: idField,
  title: z.string().trim().min(1).max(DECK_SAMPLE_TITLE_MAX),
  prompt: z.string().trim().max(DECK_SAMPLE_PROMPT_MAX).optional().default(''),
  imageRef: galleryFilename,
  createdAt: z.string().trim().max(40).optional(),
}).strict();

export const deckAddSampleSchema = z.object({
  sample: sampleSchema,
  adopt: z.object({
    styleNotes: z.string().trim().max(STYLE_NOTES_MAX).optional().default(''),
    influences: influencesSchema.optional().default({ embrace: [], avoid: [] }),
    layoutPrompt: z.string().trim().max(DECK_LAYOUT_PROMPT_MAX).optional(),
  }).strict().optional(),
}).strict();

export const deckGeneratePromptsSchema = z.object({
  cardIds: z.array(idField).max(DECK_CARDS_PER_REQUEST_MAX).optional(),
  // Rewrite cards that already carry a prompt (default: only fill empties).
  overwrite: z.boolean().optional().default(false),
  // Skip the universe casting pass even when a universe is linked.
  cast: z.boolean().optional().default(true),
  ...perCallLlm,
}).strict();

export const deckRenderSchema = z.object({
  cardIds: z.array(idField).max(DECK_CARDS_PER_REQUEST_MAX).optional(),
  // Skip cards that already have a render (the "finish the deck" button).
  onlyMissing: z.boolean().optional().default(false),
  mode: z.string().trim().max(40).optional(),
  model: z.string().trim().max(200).optional(),
  seed: z.number().int().min(0).optional(),
}).strict();
