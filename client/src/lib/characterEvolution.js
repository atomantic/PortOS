/**
 * The five-stage character evolution lens as the editors consume it (#6440).
 *
 * Re-exports the vocabularies from the pure server leaf
 * `server/lib/characterEvolution.js` — imported rather than copied so the two
 * runtimes cannot drift — and adds the editor-only descriptors (label,
 * placeholder, per-field cap) the arc and FableLoom plan editors render.
 * Exactly how `client/src/lib/characterFramework.js` mirrors
 * `server/lib/characterFramework.js`; a guard in
 * `server/lib/characterEvolution.test.js` fails if this file ever restates a
 * vocabulary instead of re-exporting it.
 *
 * The lens is OPTIONAL everywhere it appears: an editor renders it unset by
 * default, and clearing every field is a real clear that sanitizes the whole
 * lens back to absent.
 */
import {
  CHARACTER_EVOLUTION_LIMITS,
  EVOLUTION_EVIDENCE_FIELDS,
  EVOLUTION_EVIDENCE_STATUSES,
  EVOLUTION_OUTCOMES,
  EVOLUTION_STAGES,
  EVOLUTION_STAGE_LABELS,
  EVOLUTION_STAGE_TEXT_FIELDS,
  evolutionEvidenceStatus,
  isDeclaredEvolution,
} from '../../../server/lib/characterEvolution.js';

export {
  CHARACTER_EVOLUTION_LIMITS,
  // Which anchor fields each host offers — the series arc points at an issue,
  // a scene anchor or an authored transition beat; a FableLoom lens at an
  // episode and an outline scene key.
  EVOLUTION_EVIDENCE_FIELDS,
  EVOLUTION_EVIDENCE_STATUSES,
  EVOLUTION_OUTCOMES,
  EVOLUTION_STAGES,
  EVOLUTION_STAGE_LABELS,
  EVOLUTION_STAGE_TEXT_FIELDS,
  // Derived on read, never persisted — only `anchored` means verified.
  evolutionEvidenceStatus,
  isDeclaredEvolution,
};

// The four prose fields of one stage, in authoring order, with the copy an
// editor renders. Kept beside the field list rather than inside a component so
// the series arc editor and the FableLoom plan editor ask the same questions.
export const EVOLUTION_STAGE_EDITOR_FIELDS = Object.freeze([
  {
    name: 'testedBelief',
    label: 'Belief under test',
    placeholder: 'the operating rule this stage puts pressure on — it need not be the literal opposite of what they end up believing',
    max: CHARACTER_EVOLUTION_LIMITS.testedBelief,
  },
  {
    name: 'externalPressure',
    label: 'External pressure',
    placeholder: 'what the story does TO them here — the event, not the feeling',
    max: CHARACTER_EVOLUTION_LIMITS.externalPressure,
  },
  {
    name: 'characterChoice',
    label: 'Character choice',
    placeholder: 'what they actively decide in response — behavior, not realization alone',
    max: CHARACTER_EVOLUTION_LIMITS.characterChoice,
  },
  {
    name: 'causalConsequence',
    label: 'Causal consequence',
    placeholder: 'what that choice causes — the link the next stage builds on',
    max: CHARACTER_EVOLUTION_LIMITS.causalConsequence,
  },
]);

// What each declared outcome means, so a writer picks the honest one instead of
// defaulting to full change. All four are first-class endings, and declaring
// one is what stops a review reading a deliberate flat arc as a gap.
export const EVOLUTION_OUTCOME_HINTS = Object.freeze({
  'full-change': 'the changed behavior endures past the final cost',
  'tragic-refusal': 'they double down on the control belief and pay for it',
  'flat-testing': 'the belief is tested and deliberately holds — they change the world instead',
  'partial-open': 'only part of the change is earned, or the ending leaves it open',
});
