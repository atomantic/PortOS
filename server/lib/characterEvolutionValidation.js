/**
 * Zod schemas for the OPTIONAL five-stage character evolution lens (#6440).
 *
 * Its own module rather than a fragment in `sharedSchemas.js` because that file
 * is pulled in by `validation.js`, which nearly every server suite reaches —
 * adding an eager edge there costs one module instantiation per suite for a
 * shape only two hosts validate (see the Import scoping section of
 * server/AGENTS.md). The two consumers are `routes/pipeline/series.js`
 * (`series.characterArcs[].evolution`), `lib/fableLoomValidation.js`
 * (`loom.seriesPlan.characterEvolutions[]`) and `lib/pipelineValidation.js`'s
 * Writers Room cast schemas (`characters[].evolution`, #6445); sharing one
 * definition is what keeps their caps and vocabularies from drifting.
 */

import { z } from 'zod';
import {
  CHARACTER_EVOLUTION_LIMITS,
  EVOLUTION_OUTCOMES,
  EVOLUTION_STAGES,
  EVOLUTION_STAGE_TEXT_FIELDS,
} from './characterEvolution.js';

/**
 * The OPTIONAL five-stage character evolution lens (#6440), as a route input.
 *
 * Shared because two unrelated hosts embed the same lens —
 * `series.characterArcs[].evolution` (`routes/pipeline/series.js`) and
 * `loom.seriesPlan.characterEvolutions[]` (`fableLoomValidation.js`) — and a
 * hand-mirrored second copy would drift the moment a cap or a stage id moved.
 *
 * Every field is optional so a partial save and a deliberate clear both
 * round-trip; `sanitizeCharacterEvolution` stays the authority (it drops empty
 * stages, rejects an unknown `stageId` / `outcome`, and collapses an entirely
 * blank lens to null). `outcome` is `.nullable()` rather than required
 * because both hosts carry the lens inside a WHOLESALE-replaced field: making
 * it mandatory would 400 an unrelated edit to a neighbouring arc whenever a
 * lens had not been declared yet. The declaration is enforced semantically by
 * `isDeclaredEvolution`, which is what keeps an undeclared lens from reading
 * as a declared flat arc downstream.
 */
export const characterEvolutionEvidenceSchema = z.object({
  atIssue: z.number().int().min(0).max(CHARACTER_EVOLUTION_LIMITS.atIssue).nullable().optional(),
  atSceneAnchor: z.string().trim().max(CHARACTER_EVOLUTION_LIMITS.atSceneAnchor).optional(),
  transitionId: z.string().trim().max(CHARACTER_EVOLUTION_LIMITS.evidenceRef).optional(),
  episodeId: z.string().trim().max(CHARACTER_EVOLUTION_LIMITS.evidenceRef).optional(),
  sceneKey: z.string().trim().max(CHARACTER_EVOLUTION_LIMITS.evidenceRef).optional(),
  // Writers Room manuscript anchors (#6445). `segmentId` is shape-checked by
  // the sanitizer (a `seg-NNN`), not here, so a peer or an older client sending
  // a junk pointer is cleaned rather than 400'd; `anchorQuote` is prose.
  segmentId: z.string().trim().max(CHARACTER_EVOLUTION_LIMITS.evidenceRef).optional(),
  anchorQuote: z.string().trim().max(CHARACTER_EVOLUTION_LIMITS.anchorQuote).optional(),
});

export const characterEvolutionStageSchema = z.object({
  stageId: z.enum(EVOLUTION_STAGES),
  // Derived from the shared field list + cap table rather than re-typed, so a
  // fifth stage field is one edit, not three, and a cap can never drift from
  // what the sanitizer enforces.
  ...Object.fromEntries(EVOLUTION_STAGE_TEXT_FIELDS
    .map((field) => [field, z.string().trim().max(CHARACTER_EVOLUTION_LIMITS[field]).optional()])),
  evidence: characterEvolutionEvidenceSchema.nullable().optional(),
});

export const characterEvolutionSchema = z.object({
  outcome: z.enum(EVOLUTION_OUTCOMES).nullable().optional(),
  outcomeNote: z.string().trim().max(CHARACTER_EVOLUTION_LIMITS.outcomeNote).optional(),
  // Sparse by design: a lens with only stages 1 and 3 authored is valid, so the
  // array is capped at the stage count rather than required to be full.
  stages: z.array(characterEvolutionStageSchema)
    .max(CHARACTER_EVOLUTION_LIMITS.STAGES_PER_LENS_MAX).optional(),
});

/**
 * A per-character lens LIST, as `loom.seriesPlan.characterEvolutions[]` stores
 * it. Kept beside the lens itself so the entry shape has exactly one
 * definition; `sanitizeCharacterEvolutionList` stays the authority (drops
 * identity-less or empty entries and dedupes by character).
 */
export const characterEvolutionListSchema = z.array(z.object({
  characterId: z.string().trim().max(CHARACTER_EVOLUTION_LIMITS.evidenceRef).optional(),
  characterName: z.string().trim().max(CHARACTER_EVOLUTION_LIMITS.characterName).optional(),
  evolution: characterEvolutionSchema.nullable().optional(),
})).max(CHARACTER_EVOLUTION_LIMITS.LENSES_PER_PLAN_MAX);
