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

// Every anchor field either host can author, derived from the shared per-host
// table rather than restated, so a sixth anchor lands here for free.
const ALL_EVIDENCE_FIELDS = Object.freeze([
  ...new Set(Object.values(EVOLUTION_EVIDENCE_FIELDS).flat()),
]);
// `atIssue` is the one numeric anchor; the rest are strings.
const TEXT_EVIDENCE_FIELDS = ALL_EVIDENCE_FIELDS.filter((field) => field !== 'atIssue');

const asText = (value) => (typeof value === 'string' ? value : '');

/** The authored stage for `stageId`, or `null` — the lens stores stages sparsely. */
export const evolutionStage = (evolution, stageId) => (
  (Array.isArray(evolution?.stages) ? evolution.stages : [])
    .find((stage) => stage?.stageId === stageId) || null
);

// Mirror of the server's "authored?" rules (`sanitizeEvolutionEvidence` /
// `sanitizeEvolutionStage` / `sanitizeCharacterEvolution`) so an editor's draft
// collapses to the same shape the sanitizer would produce. That is what makes a
// present-but-empty field a REAL clear instead of an empty husk the server then
// drops on the next save, and what keeps an untouched lens byte-stable across a
// round trip. Text is kept verbatim (not clause-trimmed) — the caps live on the
// inputs, and trimming mid-type would fight the author.
const cleanEvidence = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const evidence = { atIssue: Number.isFinite(raw.atIssue) ? raw.atIssue : null };
  for (const field of TEXT_EVIDENCE_FIELDS) evidence[field] = asText(raw[field]).trim();
  const authored = evidence.atIssue !== null
    || TEXT_EVIDENCE_FIELDS.some((field) => evidence[field]);
  return authored ? evidence : null;
};

const cleanStage = (raw) => {
  if (!EVOLUTION_STAGES.includes(raw?.stageId)) return null;
  const stage = { stageId: raw.stageId };
  let authored = false;
  for (const field of EVOLUTION_STAGE_TEXT_FIELDS) {
    stage[field] = asText(raw[field]);
    if (stage[field].trim()) authored = true;
  }
  stage.evidence = cleanEvidence(raw.evidence);
  return authored || stage.evidence ? stage : null;
};

// A lens with no declared outcome, no note and no stage is nothing at all —
// returning null (rather than an empty husk) is what lets a host omit the key
// and keep a never-authored record byte-identical.
const finishEvolution = (evolution) => (
  evolution.outcome || evolution.outcomeNote.trim() || evolution.stages.length ? evolution : null
);

const asEvolution = (raw) => ({
  outcome: EVOLUTION_OUTCOMES.includes(raw?.outcome) ? raw.outcome : null,
  outcomeNote: asText(raw?.outcomeNote),
  stages: (Array.isArray(raw?.stages) ? raw.stages : []).map(cleanStage).filter(Boolean),
});

/**
 * Apply a lens-level patch (`outcome` / `outcomeNote`). Returns the next lens,
 * or `null` once nothing is authored — callers store that `null` verbatim so a
 * full clear persists as a clear.
 */
export const patchEvolution = (evolution, patch) => (
  finishEvolution(asEvolution({ ...asEvolution(evolution), ...patch }))
);

/**
 * Apply a patch to ONE stage, upserting it into canonical stage order and
 * dropping it again once its prose and anchor are both blank.
 */
export function patchEvolutionStage(evolution, stageId, patch) {
  const base = asEvolution(evolution);
  const merged = cleanStage({ ...(evolutionStage(base, stageId) || {}), ...patch, stageId });
  const byStage = new Map(base.stages.map((stage) => [stage.stageId, stage]));
  if (merged) byStage.set(stageId, merged);
  else byStage.delete(stageId);
  return finishEvolution({
    ...base,
    stages: EVOLUTION_STAGES.map((id) => byStage.get(id)).filter(Boolean),
  });
}

/** Apply a patch to one stage's evidence anchor, merging over what it already holds. */
export const patchEvolutionEvidence = (evolution, stageId, patch) => patchEvolutionStage(
  evolution,
  stageId,
  { evidence: { ...(evolutionStage(evolution, stageId)?.evidence || {}), ...patch } },
);
