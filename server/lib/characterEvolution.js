/**
 * The OPTIONAL five-stage character evolution lens (#6440, epic #6418).
 *
 * A story-scoped craft lens layered over the universe-level psychology profile
 * in `characterFramework.js` (Ghost → Wound → Lie → Want → Need, theory of
 * control, drives). That profile is the character's baseline IDENTITY and is
 * owned by the universe; this module models what ONE story does to it — the
 * belief it puts under test, the pressure it applies, the choice the character
 * makes, and what that choice causes. A series/work/branch's realized change
 * must never be written back over world-level identity, which is why the lens
 * hangs off the story record (`series.characterArcs[].evolution`,
 * `loom.seriesPlan.characterEvolutions[]`) and links to the cast by character
 * id alone.
 *
 * Deliberate non-rules, carried from #6418:
 *   - The lens is OPTIONAL. Every arc, beat structure and authored transition
 *     kind stays valid with it unset; nothing here becomes a gate.
 *   - The five stages are a craft lens over authored beats, NOT a page count,
 *     a chapter count, or a percentage layout.
 *   - The changed belief need not be the literal negation of the tested one.
 *   - Not every character transforms. `tragic-refusal`, `flat-testing` and
 *     `partial-open` are DECLARED outcomes, not defects — declaring one is what
 *     stops a downstream review reading a deliberate flat arc as a gap.
 *   - Stages are SPARSE: a lens with only stages 1 and 3 authored is valid.
 *
 * A PURE LEAF (imports only `bibleLimits.js` + the dependency-free trim
 * helpers in `textUtils.js`), matching `characterFramework.js`, so
 * `client/src/lib/characterEvolution.js` can re-export the vocabularies into
 * the browser bundle without dragging `crypto` / `fileUtils` along. That
 * purity is why a stage has no minted uuid: `stageId` is the identity (one
 * record per stage per lens), which needs no id generator and keeps a
 * round trip byte-stable.
 *
 * Embedded by `seriesCharacterArc.js` (`series.characterArcs[].evolution`) and
 * `services/fableLoom/records.js` (`loom.seriesPlan.characterEvolutions[]`),
 * both of which sanitize on load/save/sync; later slices of #6418 add the
 * character-arc editorial checks and the FableLoom plan review on top.
 */

import { BIBLE_LIMITS } from './bibleLimits.js';
import { trimTo, trimToClause } from './textUtils.js';

// Storr's sequence as #6418 restates it, in order: the control strategy is
// visibly failing; an event forces exploration of another way; the character
// commits to a changed strategy; consequences test whether they can bear its
// cost; a final choice and its aftermath demonstrate enduring change (or
// refusal). An unknown stage id is REJECTED rather than coerced — a beat that
// cannot be placed in the sequence cannot be reasoned about, and silently
// snapping it to a neighbouring stage would fabricate authored intent.
export const EVOLUTION_STAGES = Object.freeze([
  'control-strategy-failing',
  'pressure-forces-exploration',
  'commitment-to-change',
  'cost-tested',
  'final-proof',
]);

// The four DECLARED outcome kinds. `full-change` = the change endures;
// `tragic-refusal` = the character doubles down on the control belief;
// `flat-testing` = the belief is tested and deliberately holds (the character
// changes the world instead of themselves); `partial-open` = only some of the
// change is earned, or the ending leaves it genuinely open. All four are
// first-class authored endings — none is a finding.
export const EVOLUTION_OUTCOMES = Object.freeze([
  'full-change',
  'tragic-refusal',
  'flat-testing',
  'partial-open',
]);

// The prose half of one stage, in authoring order.
export const EVOLUTION_STAGE_TEXT_FIELDS = Object.freeze([
  'testedBelief', 'externalPressure', 'characterChoice', 'causalConsequence',
]);

// Per-field caps keyed by field name (mirrors CHARACTER_PSYCHOLOGY_LIMITS) so a
// Zod schema or an editor sizes every input from one map instead of
// re-deriving the `<FIELD>_MAX` naming convention.
export const CHARACTER_EVOLUTION_LIMITS = Object.freeze({
  testedBelief: BIBLE_LIMITS.EVOLUTION_TESTED_BELIEF_MAX,
  externalPressure: BIBLE_LIMITS.EVOLUTION_EXTERNAL_PRESSURE_MAX,
  characterChoice: BIBLE_LIMITS.EVOLUTION_CHARACTER_CHOICE_MAX,
  causalConsequence: BIBLE_LIMITS.EVOLUTION_CAUSAL_CONSEQUENCE_MAX,
  outcomeNote: BIBLE_LIMITS.EVOLUTION_OUTCOME_NOTE_MAX,
  characterName: BIBLE_LIMITS.NAME_MAX,
  atSceneAnchor: BIBLE_LIMITS.EVOLUTION_EVIDENCE_ANCHOR_MAX,
  evidenceRef: BIBLE_LIMITS.EVOLUTION_EVIDENCE_REF_MAX,
  atIssue: BIBLE_LIMITS.STORY_ISSUE_NUMBER_MAX,
  STAGES_PER_LENS_MAX: EVOLUTION_STAGES.length,
  LENSES_PER_PLAN_MAX: BIBLE_LIMITS.EVOLUTIONS_PER_PLAN_MAX,
});

// How much a stage's evidence anchor actually PROVES. Only `anchored` counts
// as verified — the epic's non-negotiable is that a missing or stale anchor can
// never read as verified, so every other value must fail an "is this proven?"
// test:
//   `unanchored` — nothing authored. Not a defect on its own (the lens is a
//                  plan; evidence arrives when the beat does), just unproven.
//   `unverified` — a pointer is authored but the caller supplied no reference
//                  set to check it against. Unknown, therefore not verified.
//   `anchored`   — every authored pointer resolves against the host record.
//   `stale`      — at least one authored pointer names something that no
//                  longer exists. PRESERVED, never silently dropped, following
//                  the `sanitizeStoryOutline` precedent that keeps an unknown
//                  `targetKey` so `DANGLING_TRANSITION` can report it.
export const EVOLUTION_EVIDENCE_STATUSES = Object.freeze([
  'unanchored', 'unverified', 'anchored', 'stale',
]);

// Shared per-character story-list primitives. They live in this leaf — the
// lowest module both per-character story lists reach — rather than beside
// either host, because a rule that lives in two places drifts: widen the canon
// id shape on the arc path alone and the same id silently blanks on the lens
// path, or refine the identity key on one side and two records that collapse
// on the pipeline host stay split on the FableLoom host.
const CHARACTER_ID_RE = /^chr-[a-zA-Z0-9-]+$/;
const TRANSITION_ID_RE = /^trn-[a-zA-Z0-9-]+$/;
const EPISODE_ID_RE = /^ep-[a-zA-Z0-9-]+$/;

const isStr = (v) => typeof v === 'string';

/** True for a canon cast pointer (`chr-<uuid>`). */
export const isCanonCharacterId = (raw) => isStr(raw) && CHARACTER_ID_RE.test(raw);

/** True for an authored transition-beat id (`trn-<uuid>`). */
export const isStoryBeatId = (raw) => isStr(raw) && TRANSITION_ID_RE.test(raw);

/**
 * Dedupe key for a per-character story list: the canon pointer wins, and a
 * case-folded name is the fallback so a name-only entry still de-dupes against
 * itself. Read by `sanitizeCharacterArcList` and `sanitizeCharacterEvolutionList`.
 */
export const characterIdentityKey = (characterId, characterName) => (
  characterId || `name:${String(characterName).trim().toLowerCase()}`
);

/**
 * Optional non-negative issue number. Absent / non-finite → null so a caller
 * can tell "no issue pinned" from issue 0. Shared with the arc's transition
 * anchors, which cap against the same `STORY_ISSUE_NUMBER_MAX`.
 */
export const optIssueNumber = (raw, max) => (
  Number.isFinite(raw) ? Math.max(0, Math.min(max, Math.floor(raw))) : null
);

// A pointer is kept only when it matches its host's id shape; anything else
// collapses to '' so a junk value can't masquerade as evidence. A well-shaped
// pointer to a DELETED record is a different case entirely — it survives here
// and `evolutionEvidenceStatus` reports it stale.
const shapedRef = (raw, re) => {
  if (!isStr(raw)) return '';
  const value = raw.trim();
  return re.test(value) ? value.slice(0, CHARACTER_EVOLUTION_LIMITS.evidenceRef) : '';
};

const asSet = (value) => {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value);
  return null;
};

// The anchor fields each host owns, and the ref set each resolves against.
// ONE table so the sanitizer, the status check, the renderer, the Zod schema
// and the client editor never enumerate the vocabulary five different ways.
export const EVOLUTION_EVIDENCE_FIELDS = Object.freeze({
  pipelineSeries: Object.freeze(['atIssue', 'atSceneAnchor', 'transitionId']),
  fableLoom: Object.freeze(['episodeId', 'sceneKey']),
});

// Pointer fields that resolve against a host reference set, paired with the
// `refs` key that carries it. `atIssue` / `atSceneAnchor` are deliberately
// absent: they are authored locators with nothing to resolve against.
const RESOLVABLE_ANCHORS = Object.freeze([
  ['transitionId', 'transitionIds'],
  ['episodeId', 'episodeIds'],
  ['sceneKey', 'sceneKeys'],
]);

/**
 * Sanitize one stage's evidence anchor. Returns `null` when nothing is
 * authored so an evidence-free stage carries no empty husk.
 *
 * Both hosts' vocabularies live in one block on purpose — the lens shape is
 * shared, and each host resolves only the pointers it owns:
 *   - Pipeline series: `atIssue` / `atSceneAnchor` (the same optional pair
 *     `sanitizeTransition` accepts) plus `transitionId`, naming the authored
 *     `trn-` beat that proves the stage.
 *   - FableLoom: `episodeId` (`ep-<uuid>`) plus `sceneKey` (a
 *     `storyOutline.scenes[].key`).
 * A field the host does not use simply stays empty.
 */
export function sanitizeEvolutionEvidence(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const evidence = {
    atIssue: optIssueNumber(raw.atIssue, CHARACTER_EVOLUTION_LIMITS.atIssue),
    atSceneAnchor: trimTo(raw.atSceneAnchor, CHARACTER_EVOLUTION_LIMITS.atSceneAnchor),
    transitionId: shapedRef(raw.transitionId, TRANSITION_ID_RE),
    episodeId: shapedRef(raw.episodeId, EPISODE_ID_RE),
    // Outline scene keys are author-chosen slugs with no prefix contract, so
    // they are length-bounded rather than shape-matched; resolution against the
    // episode's real keys is what separates a live anchor from a stale one.
    sceneKey: trimTo(raw.sceneKey, CHARACTER_EVOLUTION_LIMITS.evidenceRef),
  };
  const authored = evidence.atIssue !== null
    || evidence.atSceneAnchor
    || evidence.transitionId
    || evidence.episodeId
    || evidence.sceneKey;
  return authored ? evidence : null;
}

/**
 * How much this evidence proves, given what the host record actually contains.
 * DERIVED on read rather than persisted, so a status can never drift out of
 * step with the record it describes and a peer can never assert its own
 * anchors verified. Pass whichever reference sets the host owns:
 *
 *   { transitionIds, episodeIds, sceneKeys }   // Set | Array | omitted
 *
 * An omitted set means "not checked here" → `unverified`, never `anchored`.
 * Returns one of EVOLUTION_EVIDENCE_STATUSES; only `anchored` is verified.
 */
export function evolutionEvidenceStatus(evidence, refs = {}) {
  if (!evidence || typeof evidence !== 'object') return 'unanchored';
  const authored = RESOLVABLE_ANCHORS.filter(([field]) => Boolean(evidence[field]));
  // A free-text scene anchor / issue number is an authored locator with nothing
  // to resolve against — it counts as authored evidence but can never be
  // machine-verified, so on its own it stays `unverified`. Checked before the
  // ref sets are materialized so the common no-pointer case allocates nothing.
  if (authored.length === 0) {
    return evidence.atIssue != null || evidence.atSceneAnchor ? 'unverified' : 'unanchored';
  }
  let unchecked = false;
  for (const [field, refsKey] of authored) {
    const known = asSet(refs[refsKey]);
    if (!known) unchecked = true;
    else if (!known.has(evidence[field])) return 'stale';
  }
  return unchecked ? 'unverified' : 'anchored';
}

/**
 * Sanitize one stage. Returns `null` when the stage id is unknown (rejected,
 * never coerced) or when nothing is authored under it, so `cleanStages` drops
 * it and a sparse lens stays sparse.
 */
export function sanitizeEvolutionStage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!EVOLUTION_STAGES.includes(raw.stageId)) return null;
  const stage = { stageId: raw.stageId };
  let authored = false;
  for (const field of EVOLUTION_STAGE_TEXT_FIELDS) {
    // Prose, not identifiers: `trimToClause` so an over-cap stage ends on a
    // sentence (or at worst a whole word) rather than mid-word. A hard clip
    // hands the next verify round a belief that stops mid-thought, which reads
    // as an authoring gap — see the same note in `seriesCharacterArc.js`.
    stage[field] = trimToClause(raw[field], CHARACTER_EVOLUTION_LIMITS[field]);
    if (stage[field]) authored = true;
  }
  stage.evidence = sanitizeEvolutionEvidence(raw.evidence);
  // A stage id with no prose and no anchor is an empty marker with nothing to
  // render or reason about (mirrors `sanitizeTransition`'s label/note rule).
  return authored || stage.evidence ? stage : null;
}

// Stages are stored in canonical sequence order, deduplicated by `stageId`
// (last write wins) — the lens is five ORDERED stages, so a round trip that
// re-sorted arbitrarily would never be byte-stable.
function cleanStages(rawList) {
  if (!Array.isArray(rawList)) return [];
  const byStage = new Map();
  for (const raw of rawList) {
    const stage = sanitizeEvolutionStage(raw);
    if (stage) byStage.set(stage.stageId, stage);
  }
  return EVOLUTION_STAGES.map((id) => byStage.get(id)).filter(Boolean);
}

/**
 * Sanitize one character's evolution lens. Returns `null` when nothing is
 * authored, mirroring `sanitizeCharacterArc`'s "no identifying content ⇒ drop"
 * rule — so a record that never opted into the lens round-trips byte-identical.
 *
 * `outcome` is the DECLARATION that keeps a deliberate flat or tragic arc from
 * reading as a defect downstream, and an unknown value is rejected outright
 * rather than coerced to a default (which would fabricate a declaration the
 * author never made). It is nullable rather than mandatory on purpose: an
 * author fills stages before they know how the story lands, a peer may send a
 * lens through an older sanitizer, and BOTH host records carry the lens inside
 * a wholesale-replaced field — so refusing a lens with no declared outcome
 * would delete authored prose on a partial save and 400 an unrelated edit.
 * `isDeclaredEvolution` is the gate downstream reviews use instead; an
 * undeclared lens is incomplete, never a declared flat arc.
 */
export function sanitizeCharacterEvolution(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const outcome = EVOLUTION_OUTCOMES.includes(raw.outcome) ? raw.outcome : null;
  const outcomeNote = trimToClause(raw.outcomeNote, CHARACTER_EVOLUTION_LIMITS.outcomeNote);
  const stages = cleanStages(raw.stages);
  if (!outcome && !outcomeNote && stages.length === 0) return null;
  return { outcome, outcomeNote, stages };
}

/**
 * True only when the author has DECLARED how the arc lands. The epic's
 * non-negotiable — a declared flat or tragic-refusal arc is first-class, not a
 * finding — applies to declared lenses only; an undeclared one is unfinished
 * planning and must read as such.
 */
export const isDeclaredEvolution = (evolution) => (
  Boolean(evolution) && EVOLUTION_OUTCOMES.includes(evolution.outcome)
);

/**
 * Sanitize a per-character lens LIST (`loom.seriesPlan.characterEvolutions[]`).
 * Each entry is `{ characterId, characterName, evolution }`; entries with no
 * identity or no authored lens are dropped, and the list dedupes by character
 * identity exactly as `sanitizeCharacterArcList` does (canon pointer first,
 * case-folded name as the fallback) so two lenses for one character collapse
 * last-write-wins. Returns [] for a non-array so a pre-lens plan migrates
 * forward without a writer pass.
 *
 * The pipeline host needs no equivalent: its lens nests inside the already
 * per-character, already deduplicated `series.characterArcs[]`.
 */
export function sanitizeCharacterEvolutionList(rawList) {
  if (!Array.isArray(rawList)) return [];
  const byKey = new Map();
  const order = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue;
    const characterId = isCanonCharacterId(raw.characterId) ? raw.characterId : '';
    const characterName = trimTo(raw.characterName, CHARACTER_EVOLUTION_LIMITS.characterName);
    if (!characterId && !characterName) continue;
    // Identity and cap are settled BEFORE the per-entry walk: a peer payload
    // skips the route's `.max()` and reaches this sanitizer directly, so a
    // 10k-entry list must not pay five stages of prose trimming per entry only
    // to be dropped at the cap.
    const key = characterIdentityKey(characterId, characterName);
    const known = byKey.has(key);
    if (!known && byKey.size >= CHARACTER_EVOLUTION_LIMITS.LENSES_PER_PLAN_MAX) continue;
    const evolution = sanitizeCharacterEvolution(raw.evolution);
    if (!evolution) continue;
    if (!known) order.push(key);
    byKey.set(key, { characterId, characterName, evolution });
  }
  return order.map((k) => byKey.get(k));
}

// Human-readable stage names for a prompt block or an editor heading. Exported
// (rather than kept private) so `client/src/lib/characterEvolution.js` renders
// the same words the review prompts do.
export const EVOLUTION_STAGE_LABELS = Object.freeze({
  'control-strategy-failing': 'control strategy failing',
  'pressure-forces-exploration': 'pressure forces exploration',
  'commitment-to-change': 'commitment to change',
  'cost-tested': 'cost tested',
  'final-proof': 'final proof',
});

// How each authored stage field reads in a prompt block.
const STAGE_FIELD_LABELS = Object.freeze({
  testedBelief: 'belief under test',
  externalPressure: 'pressure',
  characterChoice: 'choice',
  causalConsequence: 'consequence',
});

// One-line description of what a stage's anchor points at, for a prompt block.
// Says nothing about whether it resolves — `evolutionEvidenceStatus` owns that.
const describeEvidence = (evidence) => {
  if (!evidence) return 'none';
  const bits = [];
  if (evidence.atIssue != null) bits.push(`issue ${evidence.atIssue}`);
  if (evidence.atSceneAnchor) bits.push(evidence.atSceneAnchor);
  for (const [field, label] of [['transitionId', 'transition'], ['episodeId', 'episode'], ['sceneKey', 'scene']]) {
    if (evidence[field]) bits.push(`${label} ${evidence[field]}`);
  }
  return bits.join(', ') || 'none';
};

/**
 * Render one lens as a compact prompt block, or `null` when there is nothing
 * to render — mirroring `renderCharacterArcsForPrompt` so every later slice of
 * #6418 shares one renderer instead of writing three.
 *
 * `refs` is optional and is forwarded to `evolutionEvidenceStatus`; an anchor
 * is annotated only when it is stale or when it resolves, so a prompt can
 * never present an unresolvable pointer as proof.
 */
export function renderCharacterEvolutionForPrompt(evolution, refs = {}) {
  if (!evolution || typeof evolution !== 'object') return null;
  const outcome = EVOLUTION_OUTCOMES.includes(evolution.outcome) ? evolution.outcome : 'undeclared';
  const note = isStr(evolution.outcomeNote) && evolution.outcomeNote ? ` — ${evolution.outcomeNote}` : '';
  // Materialize the ref sets ONCE rather than per stage — a caller that hands
  // in arrays would otherwise rebuild the same Sets five times per lens.
  const resolved = Object.fromEntries(RESOLVABLE_ANCHORS
    .map(([, refsKey]) => [refsKey, asSet(refs[refsKey])])
    .filter(([, known]) => known));
  const stageLines = [];
  for (const stage of Array.isArray(evolution.stages) ? evolution.stages : []) {
    if (!stage || typeof stage !== 'object') continue;
    const parts = [];
    for (const field of EVOLUTION_STAGE_TEXT_FIELDS) {
      if (stage[field]) parts.push(`${STAGE_FIELD_LABELS[field]}: ${stage[field]}`);
    }
    const status = evolutionEvidenceStatus(stage.evidence, resolved);
    if (status !== 'unanchored') parts.push(`evidence: ${describeEvidence(stage.evidence)} [${status}]`);
    stageLines.push(`  ${EVOLUTION_STAGE_LABELS[stage.stageId] || stage.stageId}: ${parts.join('; ') || '(not yet authored)'}`);
  }
  // A lens with a declared outcome but no stages is still worth rendering —
  // the declaration is the part a review must not mistake for a gap. A lens
  // with neither is nothing at all (and the sanitizer would have dropped it).
  if (!stageLines.length && outcome === 'undeclared' && !note) return null;
  return [`declared outcome: ${outcome}${note}`, ...stageLines].join('\n');
}
