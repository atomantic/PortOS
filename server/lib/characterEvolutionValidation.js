/**
 * Zod schemas for the OPTIONAL five-stage character evolution lens (#6440).
 *
 * Zod schemas for the evolution lens — `characterEvolutionSchema` (one lens),
 * `characterEvolutionStageSchema`, `characterEvolutionEvidenceSchema` and
 * `characterEvolutionListSchema` (the FableLoom plan's per-character list). Its own module rather than
 * a `sharedSchemas.js` fragment so `sharedSchemas.js` (which many suites reach) doesn't grow an
 * eager edge for a shape only two hosts validate.
 */

import { z } from 'zod';
import {
  CHARACTER_EVOLUTION_LIMITS,
  EVOLUTION_OUTCOMES,
  EVOLUTION_STAGES,
  EVOLUTION_STAGE_TEXT_FIELDS,
} from './characterEvolution.js';

/**
 * The OPTIONAL five-stage character evolution lens (#6440), as a route input, shared
 * by `series.characterArcs[].evolution`, `loom.seriesPlan.characterEvolutions[]` and the
 * Writers Room cast schemas so caps and vocabularies cannot drift.
 *
 * Every field is optional so a partial save and a deliberate clear both round-trip;
 * `sanitizeCharacterEvolution` stays the authority. `outcome` is `.nullable()` because
 * the lens lives in a WHOLESALE-replaced field, and requiring it would 400 an unrelated
 * edit to a neighbouring arc; `isDeclaredEvolution` enforces declaration semantically.
 */
export const characterEvolutionEvidenceSchema = z.object({
  atIssue: z.number().int().min(0).max(CHARACTER_EVOLUTION_LIMITS.atIssue).nullable().optional(),
  atSceneAnchor: z.string().trim().max(CHARACTER_EVOLUTION_LIMITS.atSceneAnchor).optional(),
  transitionId: z.string().trim().max(CHARACTER_EVOLUTION_LIMITS.evidenceRef).optional(),
  episodeId: z.string().trim().max(CHARACTER_EVOLUTION_LIMITS.evidenceRef).optional(),
  sceneKey: z.string().trim().max(CHARACTER_EVOLUTION_LIMITS.evidenceRef).optional(),
  // Writers Room manuscript anchors (#6445). `segmentId` is shape-checked by the
  // sanitizer, not here, so a junk pointer from a peer is cleaned rather than 400'd.
  segmentId: z.string().trim().max(CHARACTER_EVOLUTION_LIMITS.evidenceRef).optional(),
  anchorQuote: z.string().trim().max(CHARACTER_EVOLUTION_LIMITS.anchorQuote).optional(),
});

export const characterEvolutionStageSchema = z.object({
  stageId: z.enum(EVOLUTION_STAGES),
  // Derived from the shared field list + cap table so caps cannot drift from the sanitizer.
  ...Object.fromEntries(EVOLUTION_STAGE_TEXT_FIELDS
    .map((field) => [field, z.string().trim().max(CHARACTER_EVOLUTION_LIMITS[field]).optional()])),
  evidence: characterEvolutionEvidenceSchema.nullable().optional(),
});

export const characterEvolutionSchema = z.object({
  outcome: z.enum(EVOLUTION_OUTCOMES).nullable().optional(),
  outcomeNote: z.string().trim().max(CHARACTER_EVOLUTION_LIMITS.outcomeNote).optional(),
  // Sparse by design: capped at the stage count, not required to be full.
  stages: z.array(characterEvolutionStageSchema)
    .max(CHARACTER_EVOLUTION_LIMITS.STAGES_PER_LENS_MAX).optional(),
});

/** Per-character lens LIST as `loom.seriesPlan.characterEvolutions[]`; `sanitizeCharacterEvolutionList` stays the authority. */
export const characterEvolutionListSchema = z.array(z.object({
  characterId: z.string().trim().max(CHARACTER_EVOLUTION_LIMITS.evidenceRef).optional(),
  characterName: z.string().trim().max(CHARACTER_EVOLUTION_LIMITS.characterName).optional(),
  evolution: characterEvolutionSchema.nullable().optional(),
})).max(CHARACTER_EVOLUTION_LIMITS.LENSES_PER_PLAN_MAX);
