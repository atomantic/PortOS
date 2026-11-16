/**
 * The OPTIONAL five-stage character evolution lens (#6440, epic #6418).
 *
 * A story-scoped craft lens layered over the universe-level psychology profile in `characterFramework.js`
 * (Ghost -> Wound -> Lie -> Want -> Need). That profile is the character's baseline IDENTITY, owned by the
 * universe; this module models what ONE story does to it. A story's realized change must never be written back
 * over world-level identity, so the lens hangs off the story record (`series.characterArcs[].evolution`,
 * `loom.seriesPlan.characterEvolutions[]`) and links to the cast by character id alone.
 *
 * Deliberate non-rules:
 *   - The lens is OPTIONAL; nothing here becomes a gate.
 *   - The five stages are a craft lens over authored beats, NOT a page/chapter count or percentage layout.
 *   - The changed belief need not be the literal negation of the tested one.
 *   - `tragic-refusal`, `flat-testing` and `partial-open` are DECLARED outcomes, not defects.
 *   - Stages are SPARSE: a lens with only stages 1 and 3 authored is valid.
 *
 * A PURE LEAF (imports only `bibleLimits.js` + the trim helpers in `textUtils.js`) so
 * `client/src/lib/characterEvolution.js` can re-export the vocabularies without dragging `crypto` / `fileUtils`
 * into the browser bundle. That is why a stage has no minted uuid: `stageId` is the identity, which keeps a
 * round trip byte-stable.
 *
 * Embedded by `seriesCharacterArc.js`, `services/fableLoom/records.js` and `lib/storyBible.js`'s
 * `sanitizeCharacter` (a Writers Room work carries the lens per work without becoming a Pipeline series), all of
 * which sanitize on load/save/sync.
 */

import { BIBLE_LIMITS } from './bibleLimits.js';
import { trimTo, trimToClause, isStr } from './textUtils.js';

// Storr's sequence, in order: control strategy visibly failing; an event forces exploration; commitment to a
// changed strategy; consequences test its cost; a final choice demonstrates enduring change (or refusal). An
// unknown stage id is REJECTED, not coerced: snapping it to a neighbour would fabricate authored intent.
export const EVOLUTION_STAGES = Object.freeze([
  'control-strategy-failing',
  'pressure-forces-exploration',
  'commitment-to-change',
  'cost-tested',
  'final-proof',
]);

// The four DECLARED outcome kinds. `full-change` = the change endures; `tragic-refusal` = doubles down on the
// control belief; `flat-testing` = the belief is tested and holds; `partial-open` = only some change is earned or
// the ending is open. All are first-class endings, none is a finding.
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

// Per-field caps keyed by field name (mirrors CHARACTER_PSYCHOLOGY_LIMITS) so schemas and editors size from one map.
export const CHARACTER_EVOLUTION_LIMITS = Object.freeze({
  testedBelief: BIBLE_LIMITS.EVOLUTION_TESTED_BELIEF_MAX,
  externalPressure: BIBLE_LIMITS.EVOLUTION_EXTERNAL_PRESSURE_MAX,
  characterChoice: BIBLE_LIMITS.EVOLUTION_CHARACTER_CHOICE_MAX,
  causalConsequence: BIBLE_LIMITS.EVOLUTION_CAUSAL_CONSEQUENCE_MAX,
  outcomeNote: BIBLE_LIMITS.EVOLUTION_OUTCOME_NOTE_MAX,
  characterName: BIBLE_LIMITS.NAME_MAX,
  atSceneAnchor: BIBLE_LIMITS.EVOLUTION_EVIDENCE_ANCHOR_MAX,
  // The verbatim manuscript snippet a Writers Room stage quotes; same cap as the free-text scene anchor.
  anchorQuote: BIBLE_LIMITS.EVOLUTION_EVIDENCE_ANCHOR_MAX,
  evidenceRef: BIBLE_LIMITS.EVOLUTION_EVIDENCE_REF_MAX,
  atIssue: BIBLE_LIMITS.STORY_ISSUE_NUMBER_MAX,
  STAGES_PER_LENS_MAX: EVOLUTION_STAGES.length,
  LENSES_PER_PLAN_MAX: BIBLE_LIMITS.EVOLUTIONS_PER_PLAN_MAX,
});

// How much a stage's evidence anchor PROVES. Only `anchored` counts as verified: a missing or stale anchor must
// never read as verified.
//   `unanchored` - nothing authored (not a defect; evidence arrives with the beat).
//   `unverified` - a pointer is authored but no reference set was supplied to check it.
//   `anchored`   - every authored pointer resolves against the host record.
//   `stale`      - a pointer names something that no longer exists. PRESERVED, never dropped (like
//                  `sanitizeStoryOutline` keeping an unknown `targetKey` for `DANGLING_TRANSITION`).
export const EVOLUTION_EVIDENCE_STATUSES = Object.freeze([
  'unanchored', 'unverified', 'anchored', 'stale',
]);

// Shared per-character story-list primitives, in this leaf (the lowest module both hosts reach) so a rule isn't
// duplicated and can't drift between the arc path and the lens path.
const CHARACTER_ID_RE = /^chr-[a-zA-Z0-9-]+$/;
const TRANSITION_ID_RE = /^trn-[a-zA-Z0-9-]+$/;
const EPISODE_ID_RE = /^ep-[a-zA-Z0-9-]+$/;
// A Writers Room manuscript segment (`buildSegmentIndex`). POSITIONAL: `seg-003` is the third heading as the
// draft stands, recomputed on every save, so the Writers Room host pairs it with `anchorQuote`.
const SEGMENT_ID_RE = /^seg-\d+$/;

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

// A pointer is kept only when it matches its host's id shape, else '' so junk can't masquerade as evidence. A
// well-shaped pointer to a DELETED record survives and `evolutionEvidenceStatus` reports it stale.
const shapedRef = (raw, re) => {
  if (!isStr(raw)) return '';
  const value = raw.trim();
  return re.test(value) ? value.slice(0, CHARACTER_EVOLUTION_LIMITS.evidenceRef) : '';
};

// A host reference set. A Map passes through (answers `.has` like a Set and carries passage text for QUOTED_ANCHORS).
const asSet = (value) => {
  if (value instanceof Set || value instanceof Map) return value;
  if (Array.isArray(value)) return new Set(value);
  return null;
};

// The anchor fields each host owns and the ref set each resolves against; ONE table so no consumer re-enumerates it.
export const EVOLUTION_EVIDENCE_FIELDS = Object.freeze({
  pipelineSeries: Object.freeze(['atIssue', 'atSceneAnchor', 'transitionId']),
  fableLoom: Object.freeze(['episodeId', 'sceneKey']),
  // Writers Room maps the lens retrospectively onto a manuscript, so its only anchor is the segment index;
  // `anchorQuote` makes it checkable across an edit.
  writersRoom: Object.freeze(['segmentId', 'anchorQuote']),
});

// Pointer fields that resolve against a host reference set, paired with the `refs` key carrying it. `atIssue` /
// `atSceneAnchor` are authored locators with nothing to resolve against.
const RESOLVABLE_ANCHORS = Object.freeze([
  ['transitionId', 'transitionIds'],
  ['episodeId', 'episodeIds'],
  ['sceneKey', 'sceneKeys'],
  ['segmentId', 'segmentIds'],
]);

// Pointer fields with a companion QUOTE: `[pointer, refsKey, quoteField]`. When the host supplies the ref set as
// a Map of pointer -> passage text, the quote must still appear in that passage; otherwise a positional pointer
// (a Writers Room `seg-003` renumbers when a heading is added above it) would pass as "resolves" while naming
// a different passage. A plain Set (or none) leaves the quote unverifiable, not wrong.
const QUOTED_ANCHORS = Object.freeze([['segmentId', 'segmentIds', 'anchorQuote']]);

// Quotes compare whitespace-collapsed and case-folded, so a rewrap or re-case has not moved the passage.
const normalizeQuote = (raw) => (isStr(raw) ? raw.replace(/\s+/g, ' ').trim().toLowerCase() : '');

/**
 * Sanitize one stage's evidence anchor. Returns `null` when nothing is
 * authored so an evidence-free stage carries no empty husk.
 *
 * Both hosts' vocabularies live in one block; each host resolves only the pointers it owns:
 *   - Pipeline series: `atIssue` / `atSceneAnchor` plus `transitionId` (the authored `trn-` beat proving the stage).
 *   - FableLoom: `episodeId` (`ep-<uuid>`) plus `sceneKey` (a `storyOutline.scenes[].key`).
 *   - Writers Room: `segmentId` (positional `seg-NNN`, rebuilt on every save) plus `anchorQuote`, a verbatim
 *     snippet that lets `evolutionEvidenceStatus` tell "same passage" from "slot now holds another chapter".
 * A field the host does not use stays empty.
 */
export function sanitizeEvolutionEvidence(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const evidence = {
    atIssue: optIssueNumber(raw.atIssue, CHARACTER_EVOLUTION_LIMITS.atIssue),
    atSceneAnchor: trimTo(raw.atSceneAnchor, CHARACTER_EVOLUTION_LIMITS.atSceneAnchor),
    transitionId: shapedRef(raw.transitionId, TRANSITION_ID_RE),
    episodeId: shapedRef(raw.episodeId, EPISODE_ID_RE),
    // Outline scene keys are author-chosen slugs, so length-bounded rather than shape-matched.
    sceneKey: trimTo(raw.sceneKey, CHARACTER_EVOLUTION_LIMITS.evidenceRef),
    segmentId: shapedRef(raw.segmentId, SEGMENT_ID_RE),
    // Free text (a verbatim snippet of the author's prose); PRESERVED when its segment pointer goes stale, to drive re-anchor.
    anchorQuote: trimTo(raw.anchorQuote, CHARACTER_EVOLUTION_LIMITS.anchorQuote),
  };
  const authored = evidence.atIssue !== null
    || evidence.atSceneAnchor
    || evidence.transitionId
    || evidence.episodeId
    || evidence.sceneKey
    || evidence.segmentId
    || evidence.anchorQuote;
  return authored ? evidence : null;
}

/**
 * How much this evidence proves given what the host record contains. DERIVED on read, never persisted, so it
 * can't drift and a peer can't assert its own anchors verified. Pass whichever reference sets the host owns:
 *
 *
 *   { transitionIds, episodeIds, sceneKeys }   // Set | Array | omitted
 *
 * An omitted set means "not checked here" → `unverified`, never `anchored`.
 * Returns one of EVOLUTION_EVIDENCE_STATUSES; only `anchored` is verified.
 */
export function evolutionEvidenceStatus(evidence, refs = {}) {
  if (!evidence || typeof evidence !== 'object') return 'unanchored';
  const authored = RESOLVABLE_ANCHORS.filter(([field]) => Boolean(evidence[field]));
  // A free-text scene anchor / issue number counts as authored evidence but can never be machine-verified, so
  // alone it stays `unverified`. Checked before materializing ref sets so the no-pointer case allocates nothing.
  if (authored.length === 0) {
    return evidence.atIssue != null || evidence.atSceneAnchor || evidence.anchorQuote
      ? 'unverified'
      : 'unanchored';
  }
  let unchecked = false;
  for (const [field, refsKey] of authored) {
    const known = asSet(refs[refsKey]);
    if (!known) unchecked = true;
    else if (!known.has(evidence[field])) return 'stale';
  }
  // A resolved quoted pointer must still SAY what it said; checked only when the host supplied passage text,
  // else the anchor is merely unchecked (`unverified`), never `anchored`.
  for (const [field, refsKey, quoteField] of QUOTED_ANCHORS) {
    const quote = normalizeQuote(evidence[quoteField]);
    if (!evidence[field] || !quote) continue;
    const known = refs[refsKey];
    if (!(known instanceof Map)) {
      unchecked = true;
      continue;
    }
    if (!normalizeQuote(known.get(evidence[field])).includes(quote)) return 'stale';
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
    // Prose: `trimToClause` ends an over-cap stage on a sentence/word, since a hard clip reads as an authoring gap
    // (see `seriesCharacterArc.js`).
    stage[field] = trimToClause(raw[field], CHARACTER_EVOLUTION_LIMITS[field]);
    if (stage[field]) authored = true;
  }
  stage.evidence = sanitizeEvolutionEvidence(raw.evidence);
  // A stage with no prose and no anchor is an empty marker (mirrors `sanitizeTransition`).
  return authored || stage.evidence ? stage : null;
}

// Stored in canonical sequence order, deduplicated by `stageId` (last write wins); arbitrary re-sorting would break byte-stability.
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
 * `outcome` is the DECLARATION that keeps a deliberate flat or tragic arc from reading as a defect; an unknown
 * value is rejected, not coerced (which would fabricate a declaration). It is nullable on purpose: authors fill
 * stages before knowing how the story lands, and both hosts carry the lens in a wholesale-replaced field, so
 * refusing an undeclared lens would delete authored prose on a partial save. `isDeclaredEvolution` is the
 * downstream gate; an undeclared lens is incomplete, never a declared flat arc.
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
 * True only when the author has DECLARED how the arc lands; a declared flat or tragic-refusal arc is first-class,
 * an undeclared one is unfinished planning.
 */
export const isDeclaredEvolution = (evolution) => (
  Boolean(evolution) && EVOLUTION_OUTCOMES.includes(evolution.outcome)
);

/**
 * Sanitize a per-character lens LIST (`loom.seriesPlan.characterEvolutions[]`).
 * Entries are `{ characterId, characterName, evolution }`; entries with no identity or no lens are dropped and the
 * list dedupes by character identity as `sanitizeCharacterArcList` does (last write wins). Returns [] for a
 * non-array so a pre-lens plan migrates forward. The pipeline host needs no equivalent: its lens nests in
 * `series.characterArcs[]`.
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
    // Identity and cap are settled BEFORE the per-entry walk: peer payloads skip the route's `.max()`, so a
    // 10k-entry list must not pay stage trimming per entry only to be dropped at the cap.
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

// Exported so `client/src/lib/characterEvolution.js` renders the same words the review prompts do.
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
  for (const [field, label] of [['transitionId', 'transition'], ['episodeId', 'episode'], ['sceneKey', 'scene'], ['segmentId', 'segment']]) {
    if (evidence[field]) bits.push(`${label} ${evidence[field]}`);
  }
  if (evidence.anchorQuote) bits.push(`quote "${evidence.anchorQuote}"`);
  return bits.join(', ') || 'none';
};

/**
 * Render one lens as a compact prompt block, or `null` when there is nothing
 * to render, mirroring `renderCharacterArcsForPrompt`.
 *
 * `refs` is forwarded to `evolutionEvidenceStatus`; an anchor is annotated only when stale or resolved, so a
 * prompt never presents an unresolvable pointer as proof.
 */
export function renderCharacterEvolutionForPrompt(evolution, refs = {}) {
  if (!evolution || typeof evolution !== 'object') return null;
  const outcome = EVOLUTION_OUTCOMES.includes(evolution.outcome) ? evolution.outcome : 'undeclared';
  const note = isStr(evolution.outcomeNote) && evolution.outcomeNote ? ` — ${evolution.outcomeNote}` : '';
  // Materialize the ref sets ONCE, not per stage.
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
  // A declared outcome with no stages is still worth rendering (a review must not mistake it for a gap); neither means nothing.
  if (!stageLines.length && outcome === 'undeclared' && !note) return null;
  return [`declared outcome: ${outcome}${note}`, ...stageLines].join('\n');
}

/**
 * Render every authored lens in a per-character LIST as one prompt block, or
 * Both hosts keep a per-character list and need the same nesting, the same "null, not ''" contract (keeps a
 * consumer's `{{#characterEvolution*}}` section empty) and per-entry evidence resolution; only WHERE the ref sets
 * come from differs.

 * `refs` is one shared reference-set object (FableLoom: loom-wide ids) or a function called per entry (pipeline: a
 * lens resolves against ITS OWN arc's transition beats).
 */
export function renderCharacterEvolutionListForPrompt(list, refs = {}) {
  if (!Array.isArray(list)) return null;
  const refsFor = typeof refs === 'function' ? refs : () => refs;
  const blocks = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const lens = renderCharacterEvolutionForPrompt(entry.evolution, refsFor(entry));
    if (!lens) continue;
    const name = entry.characterName || '(unnamed character)';
    // Indent the lens body under its character, preserving the renderer's two-space stage nesting.
    blocks.push(`- ${name}\n${lens.split('\n').map((line) => `    ${line}`).join('\n')}`);
  }
  return blocks.length ? blocks.join('\n') : null;
}
