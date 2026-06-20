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
 *     status,            // 'draft' | 'verified'
 *   }
 *
 * `transitions[].kind` is one of TRANSITION_KINDS — the genre of change beat.
 *
 * Used by `services/pipeline/series.js` (sanitize on load/save) and the
 * `arc.transitions` editorial check in `lib/editorial/checkRegistry.js`.
 */

import { randomUUID } from 'crypto';
import { isStr, trimTo } from './storyBible.js';

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
  ISSUE_MAX: 9999,
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

const CHARACTER_ID_RE = /^chr-[a-zA-Z0-9-]+$/;
const TRANSITION_ID_PREFIX = 'trn-';
const TRANSITION_ID_RE = /^trn-[a-zA-Z0-9-]+$/;

const ensureTransitionId = (raw) =>
  (isStr(raw) && TRANSITION_ID_RE.test(raw) ? raw : `${TRANSITION_ID_PREFIX}${randomUUID()}`);

// Optional non-negative integer (e.g. an issue number). Absent / non-finite →
// null so the caller can distinguish "no issue pinned" from issue 0.
const optInt = (raw, max) =>
  (Number.isFinite(raw) ? Math.max(0, Math.min(max, Math.floor(raw))) : null);

/**
 * Sanitize one transition beat. Returns `null` when it carries no identifying
 * content (no label, no note, no kind survives) so `cleanTransitions` drops it.
 * A known `kind` is required — it's what places the beat on the timeline.
 */
export function sanitizeTransition(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = TRANSITION_KINDS.includes(raw.kind) ? raw.kind : null;
  if (!kind) return null;
  const label = trimTo(raw.label, CHARACTER_ARC_LIMITS.TRANSITION_LABEL_MAX);
  const note = trimTo(raw.note, CHARACTER_ARC_LIMITS.TRANSITION_NOTE_MAX);
  // A kind with neither a label nor a note is an empty marker with nothing to
  // render or reason about — drop it (mirrors sanitizeReaderBeat's intent).
  if (!label && !note) return null;
  return {
    id: ensureTransitionId(raw.id),
    kind,
    label,
    atIssue: optInt(raw.atIssue, CHARACTER_ARC_LIMITS.ISSUE_MAX),
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
  const characterId = isStr(raw.characterId) && CHARACTER_ID_RE.test(raw.characterId) ? raw.characterId : '';
  const characterName = trimTo(raw.characterName, CHARACTER_ARC_LIMITS.CHARACTER_NAME_MAX);
  const want = trimTo(raw.want, CHARACTER_ARC_LIMITS.WANT_MAX);
  const need = trimTo(raw.need, CHARACTER_ARC_LIMITS.NEED_MAX);
  const startState = trimTo(raw.startState, CHARACTER_ARC_LIMITS.START_STATE_MAX);
  const endState = trimTo(raw.endState, CHARACTER_ARC_LIMITS.END_STATE_MAX);
  const transitions = cleanTransitions(raw.transitions);
  // Without a character pointer/name there's nothing to attach the arc to, and
  // without any authored field or transition there's nothing to render — either
  // way it's indistinguishable from "no arc".
  if (!characterId && !characterName) return null;
  if (!want && !need && !startState && !endState && transitions.length === 0) return null;
  const status = CHARACTER_ARC_STATUSES.includes(raw.status) ? raw.status : 'draft';
  return { characterId, characterName, want, need, startState, endState, transitions, status };
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
    // Identity key: the canon pointer wins; fall back to the case-folded name so
    // a name-only arc still de-dupes against itself.
    const key = arc.characterId || `name:${arc.characterName.trim().toLowerCase()}`;
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
