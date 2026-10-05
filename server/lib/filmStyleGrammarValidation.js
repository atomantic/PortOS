/**
 * Zod contract for a film style grammar (#10252) — the record shape the
 * authoring prompts of later phases consume. A grammar describes how a medium
 * is imitated procedurally (layers, mark stepping, camera vocabulary, sound
 * palette); every field is bounded so the rendered prompt section stays small.
 */
import { z } from 'zod';

export const FILM_STYLE_CATEGORIES = Object.freeze(['print', 'drawing', 'film', 'digital', 'craft', 'dimensional', 'interface']);

/** Renderable sections, in render order. `parts` selects a subset of these. */
export const FILM_STYLE_PARTS = Object.freeze([
  'essence', 'rendering', 'colourLogic', 'type', 'motion', 'camera', 'sound', 'nativeMoves', 'pitfalls',
]);

export const FILM_STYLE_LIMITS = Object.freeze({
  id: 48,
  label: 60,
  summary: 140,
  trait: 120,
  traits: { min: 3, max: 5 },
  confusedWith: { min: 1, max: 3 },
  confusedWithItem: 80,
  rendering: 420,
  colourLogic: 240,
  type: 200,
  motion: 260,
  cameraRows: { min: 3, max: 5 },
  cameraMove: 40,
  cameraExpresses: 90,
  canServe: { min: 1, max: 3 },
  canServeItem: 40,
  sound: 240,
  nativeMoves: { min: 3, max: 5 },
  nativeMoveName: 40,
  nativeMoveHow: 160,
  fitsContentLike: { min: 1, max: 3 },
  fitsContentLikeItem: 40,
  pitfalls: 240,
});

const L = FILM_STYLE_LIMITS;
const text = max => z.string().trim().min(1).max(max);
const list = (max, { min, max: count }) => z.array(text(max)).min(min).max(count);

export const filmStyleIdSchema = z.string().min(1).max(L.id).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'id must be kebab-case');

export const filmStyleGrammarSchema = z.object({
  id: filmStyleIdSchema,
  label: text(L.label),
  category: z.enum(FILM_STYLE_CATEGORIES),
  summary: text(L.summary),
  essence: z.object({
    traits: list(L.trait, L.traits),
    confusedWith: list(L.confusedWithItem, L.confusedWith),
  }).strict(),
  rendering: text(L.rendering),
  colourLogic: text(L.colourLogic),
  type: text(L.type),
  motion: text(L.motion),
  camera: z.array(z.object({
    move: text(L.cameraMove),
    expresses: text(L.cameraExpresses),
    canServe: list(L.canServeItem, L.canServe),
  }).strict()).min(L.cameraRows.min).max(L.cameraRows.max),
  sound: text(L.sound),
  nativeMoves: z.array(z.object({
    name: text(L.nativeMoveName),
    how: text(L.nativeMoveHow),
    fitsContentLike: list(L.fitsContentLikeItem, L.fitsContentLike),
  }).strict()).min(L.nativeMoves.min).max(L.nativeMoves.max),
  pitfalls: text(L.pitfalls),
}).strict();

/** `'all'` or a non-empty, duplicate-free subset of FILM_STYLE_PARTS. */
export const filmStylePartsSchema = z.union([
  z.literal('all'),
  z.array(z.enum(FILM_STYLE_PARTS)).min(1).max(FILM_STYLE_PARTS.length)
    .refine(parts => new Set(parts).size === parts.length, 'parts must not repeat'),
]);

export const filmStyleParamsSchema = z.object({ id: filmStyleIdSchema });

/** `?parts=motion,camera` (comma-separated) or absent/`all` → the renderer `parts` option. */
export const filmStylePromptQuerySchema = z.object({
  parts: z.string().trim().max(200).optional()
    .transform(value => (!value || value === 'all' ? 'all' : value.split(',').map(part => part.trim())))
    .pipe(filmStylePartsSchema),
});
