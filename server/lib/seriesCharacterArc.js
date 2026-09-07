/**
 * Per-character story arcs for a series (#1293).
 *
 * Sibling to `storyArc.js` — that module owns the *series-level* temporal spine
 * (the multi-season arc + the protagonist's single emotional fortune curve);
 * this one owns the *per-character* arcs: each cast member's want/need, their
 * start → end transformation, and the explicit transition beats where they
 * actually change (a decision, a realization, a point of no return).
 *
 * Where today arc lives only at the series level (`storyArc.js` protagonistArc,
 * readerMap beats) and `editorialAnalysis.js` *detects* a coarse per-character
 * arc direction (rising/falling/flat/complex), this is the AUTHORED model the
 * writer maintains and the `arc.transitions` editorial check reconciles detected
 * change moments against.
 *
 * Shape (lives at `series.characterArcs[]`):
 *   {
 *     characterId,       // 'chr-<uuid>' pointer into the linked universe cast (or '')
 *     characterName,     // denormalized display name (canon name may rename)
 *     want,              // the external goal the character pursues
 *     need,              // the internal lesson/change they actually require
 *     startState,        // who they are at the opening
 *     endState,          // who they are at the close
 *     transitions: [{ id, atIssue, atSceneAnchor, label, kind, note }],
 *     evolution,         // the optional five-stage lens, absent when unset (#6440)
 *     status,            // 'draft' | 'verified'
 *   }
 *
 * `transitions[].kind` is one of TRANSITION_KINDS — the genre of change beat.
 *
 * Used by `services/pipeline/series.js` (sanitize on load/save) and the
 * `arc.transitions` editorial check in `lib/editorial/checkRegistry.js`.
 */

import { randomUUID } from 'crypto';
import { BIBLE_LIMITS } from './bibleLimits.js';
import {
  characterIdentityKey,
  isCanonCharacterId,
  isStoryBeatId,
  optIssueNumber,
  sanitizeCharacterEvolution,
} from './characterEvolution.js';
import { trimTo, trimToClause } from './textUtils.js';

export const CHARACTER_ARC_LIMITS = Object.freeze({
  CHARACTER_NAME_MAX: 200,
  WANT_MAX: 1000,
  NEED_MAX: 1000,
  START_STATE_MAX: 1000,
  END_STATE_MAX: 1000,
  TRANSITION_LABEL_MAX: 200,
  TRANSITION_NOTE_MAX: 1000,
  TRANSITION_ANCHOR_MAX: 300,
  TRANSITIONS_PER_ARC_MAX: 40,
  // Shared with the evolution lens's own issue anchor, so the two anchor
  // vocabularies cannot drift apart (`characterEvolution.js` reads the same
  // constant).
  ISSUE_MAX: BIBLE_LIMITS.STORY_ISSUE_NUMBER_MAX,
  ARCS_PER_SERIES_MAX: 60,
});

export const CHARACTER_ARC_STATUSES = Object.freeze(['draft', 'verified']);

// The genre of change beat. `decision` (an active choice), `realization` (an
// internal understanding), `point-of-no-return` (an irreversible commitment),
// `relapse` (a backslide into the old self), `sacrifice` (giving up the want to
// honor the need). An unknown kind drops the transition — a beat with no
// classified kind can't be placed on the transition timeline meaningfully.
export const TRANSITION_KINDS = Object.freeze([
  'decision',
  'realization',
  'point-of-no-return',
  'relapse',
  'sacrifice',
]);

const TRANSITION_ID_PREFIX = 'trn-';

// The canon id shapes, the issue clamp and the identity key are shared with the
// evolution lens (`characterEvolution.js`, which this module already imports)
// so the two per-character story lists cannot drift on what counts as a valid
// pointer or as the same character.
const ensureTransitionId = (raw) =>
  (isStoryBeatId(raw) ? raw : `${TRANSITION_ID_PREFIX}${randomUUID()}`);

/**
 * Sanitize one transition beat. Returns `null` when it carries no identifying
 * content (no label, no note, no kind survives) so `cleanTransitions` drops it.
 * A known `kind` is required — it's what places the beat on the timeline.
 */
export function sanitizeTransition(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = TRANSITION_KINDS.includes(raw.kind) ? raw.kind : null;
  if (!kind) return null;
  // Prose, not identifiers: `trimToClause` so an over-cap beat ends on a sentence
  // (or at worst a whole word) instead of mid-word. The route schema 400s an
  // over-cap label, but the arc auto-resolve path writes through the service
  // sanitizer directly — a hard clip there hands the next verify round a beat that
  // stops mid-thought ("…the four-minute crossing e"), which reads as an authoring
  // gap and keeps the verify→resolve loop from converging. See trimToClause's own
  // note on that loop in storyBible.js.
  const label = trimToClause(raw.label, CHARACTER_ARC_LIMITS.TRANSITION_LABEL_MAX);
  const note = trimToClause(raw.note, CHARACTER_ARC_LIMITS.TRANSITION_NOTE_MAX);
  // A kind with neither a label nor a note is an empty marker with nothing to
  // render or reason about — drop it (mirrors sanitizeReaderBeat's intent).
  if (!label && !note) return null;
  return {
    id: ensureTransitionId(raw.id),
    kind,
    label,
    atIssue: optIssueNumber(raw.atIssue, CHARACTER_ARC_LIMITS.ISSUE_MAX),
    atSceneAnchor: trimTo(raw.atSceneAnchor, CHARACTER_ARC_LIMITS.TRANSITION_ANCHOR_MAX),
    note,
  };
}

function cleanTransitions(rawList) {
  if (!Array.isArray(rawList)) return [];
  const out = [];
  for (const raw of rawList) {
    const t = sanitizeTransition(raw);
    if (t) out.push(t);
    if (out.length >= CHARACTER_ARC_LIMITS.TRANSITIONS_PER_ARC_MAX) break;
  }
  return out;
}

/**
 * Sanitize one per-character arc. Returns `null` when it carries no identifying
 * content (no character pointer/name and no authored fields) so
 * `sanitizeCharacterArcList` drops it — mirroring `sanitizeArc`/`sanitizeSeason`.
 * The `characterId` is preserved only when it matches the canon `chr-<uuid>`
 * shape; an opaque/blank id falls back to '' so a name-only arc still survives
 * (the cast link can be repaired later).
 */
export function sanitizeCharacterArc(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const characterId = isCanonCharacterId(raw.characterId) ? raw.characterId : '';
  const characterName = trimTo(raw.characterName, CHARACTER_ARC_LIMITS.CHARACTER_NAME_MAX);
  // want/need/startState/endState are LLM-authored prose rendered back into the
  // verify + resolve prompts — boundary-aware caps for the same reason as the
  // transition label/note above. `characterName` stays a hard trim: it's an
  // identity string matched against the canon cast, not a sentence.
  const want = trimToClause(raw.want, CHARACTER_ARC_LIMITS.WANT_MAX);
  const need = trimToClause(raw.need, CHARACTER_ARC_LIMITS.NEED_MAX);
  const startState = trimToClause(raw.startState, CHARACTER_ARC_LIMITS.START_STATE_MAX);
  const endState = trimToClause(raw.endState, CHARACTER_ARC_LIMITS.END_STATE_MAX);
  const transitions = cleanTransitions(raw.transitions);
  // The OPTIONAL five-stage evolution lens (#6440). The key is OMITTED (not
  // stored as null) when nothing is authored, so a pre-#6440 arc round-trips
  // byte-identical and nothing about the lens becomes a gate on a legacy
  // story — the same shape rule `sanitizeSeriesPlan` uses for the delivery
  // plan. Wire-gated (pipelineSeries schema v13).
  const evolution = sanitizeCharacterEvolution(raw.evolution);
  // Without a character pointer/name there's nothing to attach the arc to, and
  // without any authored field, transition or lens there's nothing to render —
  // either way it's indistinguishable from "no arc".
  if (!characterId && !characterName) return null;
  if (!want && !need && !startState && !endState && transitions.length === 0 && !evolution) return null;
  const status = CHARACTER_ARC_STATUSES.includes(raw.status) ? raw.status : 'draft';
  return {
    characterId, characterName, want, need, startState, endState, transitions,
    ...(evolution ? { evolution } : {}),
    status,
  };
}

/**
 * Sanitize the `series.characterArcs[]` field. Drops rejected entries, caps at
 * ARCS_PER_SERIES_MAX, and deduplicates by character identity (characterId when
 * present, else normalized characterName) so two arcs for the same character
 * collapse last-write-wins. Returns [] for a non-array so existing series.json
 * files migrate forward without a writer pass (first save backfills).
 */
export function sanitizeCharacterArcList(rawList) {
  if (!Array.isArray(rawList)) return [];
  const byKey = new Map();
  const order = [];
  for (const raw of rawList) {
    const arc = sanitizeCharacterArc(raw);
    if (!arc) continue;
    const key = characterIdentityKey(arc.characterId, arc.characterName);
    if (!byKey.has(key)) {
      if (byKey.size >= CHARACTER_ARC_LIMITS.ARCS_PER_SERIES_MAX) continue;
      order.push(key);
    }
    byKey.set(key, arc);
  }
  return order.map((k) => byKey.get(k));
}

/**
 * Render the authored per-character arcs as a compact prompt block for the
 * `arc.transitions` editorial check. Returns null when there are no authored
 * arcs so the check's prompt template can render a "no authored arcs — propose
 * them" fallback. Mirrors `renderArcShapeGuidance` / `renderTickingClock`.
 */
export function renderCharacterArcsForPrompt(arcs) {
  if (!Array.isArray(arcs) || arcs.length === 0) return null;
  const lines = [];
  for (const arc of arcs) {
    if (!arc || typeof arc !== 'object') continue;
    const name = arc.characterName || '(unnamed character)';
    const parts = [`- ${name}`];
    if (arc.want) parts.push(`wants: ${arc.want}`);
    if (arc.need) parts.push(`needs: ${arc.need}`);
    if (arc.startState) parts.push(`starts: ${arc.startState}`);
    if (arc.endState) parts.push(`ends: ${arc.endState}`);
    lines.push(parts.join('; '));
    const transitions = Array.isArray(arc.transitions) ? arc.transitions : [];
    for (const t of transitions) {
      if (!t || typeof t !== 'object') continue;
      const at = t.atIssue != null ? ` (issue ${t.atIssue})` : '';
      const label = t.label || t.note || '(unlabeled beat)';
      lines.push(`    • ${t.kind}${at}: ${label}`);
    }
  }
  return lines.length ? lines.join('\n') : null;
}

/**
 * Reference sets an evolution lens's evidence anchors resolve against on this
 * host — the arc's own authored transition beats. Hand it to
 * `evolutionEvidenceStatus` / `renderCharacterEvolutionForPrompt` so a stage
 * pointing at a since-deleted `trn-` beat reports `stale` instead of passing
 * as proof. Kept beside the arc because the arc owns the beats.
 */
export function characterArcEvidenceRefs(arc) {
  const transitions = Array.isArray(arc?.transitions) ? arc.transitions : [];
  return { transitionIds: new Set(transitions.map((t) => t?.id).filter(Boolean)) };
}
