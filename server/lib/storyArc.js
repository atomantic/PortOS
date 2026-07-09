/**
 * Canonical Arc + Season shapes for the Pipeline Story Arc Planning feature.
 *
 * Sibling to `storyBible.js` — same role, different scope. Story bibles describe
 * the *characters, settings, and objects* that recur across an arc; this module
 * describes the *temporal spine*: the multi-season story arc and its season
 * breakdown. Both live on the series record.
 *
 * Shapes:
 *   series.arc       (optional) overall multi-season story spine
 *   series.seasons[] ordered list of seasons/volumes
 *   issue.seasonId   (optional pointer back to a season)
 *   issue.arcPosition (optional ordinal within the season — drives auto-sort)
 *
 * Used by `services/pipeline/series.js` (sanitize on load/save) and
 * `services/pipeline/seasons.js` (CRUD + child-issue reassignment on delete).
 */

import { randomUUID } from 'crypto';
import { isStr, trimTo, trimToClause } from './storyBible.js';
import { sanitizeCoverLike } from './renderSlot.js';

export const ARC_LIMITS = Object.freeze({
  LOGLINE_MAX: 500,
  SUMMARY_MAX: 8000,
  PROTAGONIST_ARC_MAX: 4000,
  THEME_MAX: 100,
  THEMES_PER_ARC_MAX: 20,
  // Season
  SEASON_TITLE_MAX: 200,
  SEASON_LOGLINE_MAX: 500,
  // A season synopsis covers a whole season's worth of episodes (8+ issues on a
  // multi-season series), so it needs the same room as the arc-level SUMMARY_MAX
  // (8000). The old 4000 cap clipped a full synopsis mid-sentence — and because
  // the arc-verify→resolve loop re-flags a mid-sentence truncation and the
  // resolver regenerates a >4000 synopsis that gets re-clipped, the loop could
  // never converge (it burned all its rounds and paused). See arc-verify
  // "truncated mid-sentence" finding, 2026-06-21.
  SEASON_SYNOPSIS_MAX: 8000,
  SEASON_ENDING_HOOK_MAX: 1000,
  SEASON_NUMBER_MAX: 99,
  SEASON_EPISODE_COUNT_MAX: 999,
  SEASONS_PER_SERIES_MAX: 50,
});

export const ARC_STATUSES = Object.freeze(['draft', 'verified']);
export const SEASON_STATUSES = Object.freeze(['draft', 'verified', 'in-production', 'complete']);

// Reader map — the audience-facing companion to the protagonist arc. Where
// `arc.protagonistArc` + `arc.shape` describe the *character's* emotional
// fortune, the reader map describes what the *reader/viewer* experiences as
// they move through the content: questions planted (hooks), their resolutions
// (payoffs), the felt emotional beats, and the cliffhangers between issues.
// Lives at `series.arc.readerMap`; built on top of the Vonnegut `shape`.
export const READER_MAP_LIMITS = Object.freeze({
  LABEL_MAX: 200,
  NOTE_MAX: 1000,
  HOOKS_MAX: 60,
  PAYOFFS_MAX: 60,
  BEATS_MAX: 200,
  CLIFFHANGERS_MAX: 60,
  ARC_POSITION_MAX: 9999,
  ISSUE_BOUNDARY_MAX: 9999,
});
export const READER_MAP_BEAT_KINDS = Object.freeze(['hook', 'reveal', 'payoff', 'emotional', 'cliffhanger']);
export const READER_MAP_STATUSES = Object.freeze(['draft', 'verified']);

// Ticking clock — the known future event the reader is building toward (a
// deadline, a prophecy's hour, an incoming storm, "what is the story building
// up to"). Where `readerMap.cliffhangers` are local issue-boundary tugs, the
// ticking clock is a *first-class arc concept*: a single countdown planted
// early, reminded through the middle, and paid off at a due position. Lives at
// `series.arc.tickingClock` (a singular object, not a list).
export const TICKING_CLOCK_LIMITS = Object.freeze({
  LABEL_MAX: 200,
  STAKES_MAX: 1000,
  REMINDER_NOTE_MAX: 500,
  REMINDERS_MAX: 40,
  ARC_POSITION_MAX: 9999,
  ISSUE_MAX: 9999,
});
export const TICKING_CLOCK_KINDS = Object.freeze(['deadline', 'event', 'countdown', 'prophecy', 'bomb', 'custom']);

// Foreshadowing ledger — the authored plant → reinforce → payoff record the
// arc-overview stage emits (#2172). Where `readerMap.hooks`/`payoffs` are the
// reader-experience questions/answers and `tickingClock` is a single named
// countdown, the foreshadowing ledger is a LIST of individual seeds: for each,
// the issue it's planted in, the issues that reinforce it, and the issue it
// pays off in. The `chekhov.setups-payoffs` editorial check consumes this
// ledger so it reconciles the prose against author-declared plants instead of
// inferring every setup from scratch. Lives at `series.arc.foreshadowing`.
export const FORESHADOW_LIMITS = Object.freeze({
  LABEL_MAX: 200,
  NOTE_MAX: 1000,
  ENTRIES_MAX: 60,
  REINFORCE_MAX: 20,
  ISSUE_MAX: 9999,
});

// Per-episode arc roles produced by the season-episodes generator and
// persisted on the issue so downstream stages (idea-expansion in particular)
// know whether they're writing a pilot vs. midpoint vs. finale episode.
export const ARC_ROLES = Object.freeze(['pilot', 'complication', 'midpoint', 'b-plot', 'all-is-lost', 'finale']);

// Kurt Vonnegut's eight story shapes. The client owns the sparkline rendering
// but the points + descriptions live here too so prompt contexts have a
// consistent, deterministic story of what each shape *means* in terms of the
// protagonist's emotional fortune across the arc.
//
// Keep `points` arrays in sync with `client/src/components/pipeline/StoryShapes.jsx`
// — the unit test `storyArc.test.js` asserts they remain identical.
export const ARC_SHAPES = Object.freeze([
  {
    id: 'rags-to-riches',
    label: 'Rags to Riches',
    description: 'Steady monotonic rise from misfortune to triumph.',
    points: [-1, -0.7, -0.4, -0.1, 0.3, 0.7, 1],
    guidance: 'The protagonist\'s fortune climbs monotonically across the arc. Every volume must end better than it began. Setbacks happen but never reverse the overall climb. Open in a low/constrained state; finale lands in unambiguous triumph.',
  },
  {
    id: 'tragedy',
    label: 'Tragedy',
    description: 'Steady fall from good fortune to ruin.',
    points: [1, 0.7, 0.4, 0.1, -0.3, -0.7, -1],
    guidance: 'The protagonist\'s fortune falls monotonically across the arc. Open in a high/privileged state; each volume erodes it further. Brief upticks are allowed but never recover the loss. Finale lands in unambiguous ruin or loss.',
  },
  {
    id: 'man-in-hole',
    label: 'Man in Hole',
    description: 'Falls into trouble, climbs out better than before.',
    points: [0.4, 0, -0.6, -1, -0.5, 0.3, 0.9],
    guidance: 'Open near baseline-good. Plunge to the arc\'s nadir around the midpoint (Volume 2 of 3, midseason of a 1-volume run). Climb out steadily; finale lands higher than the opening. The protagonist is changed by what they survived.',
  },
  {
    id: 'icarus',
    label: 'Icarus',
    description: 'Soars high, then crashes.',
    points: [-0.4, 0.2, 0.7, 1, 0.5, -0.2, -1],
    guidance: 'Rise sharply through the first half of the arc to a peak near the midpoint, then fall just as sharply. Finale lands lower than the opening. The crash should feel earned by the over-reach, not arbitrary.',
  },
  {
    id: 'cinderella',
    label: 'Cinderella',
    description: 'Rises, suffers a setback, soars to the highest peak.',
    points: [-0.7, -0.3, 0.2, 0.5, -0.3, 0.4, 1],
    guidance: 'Open low. Rise through the first half to a modest high, then suffer a sharp reversal around two-thirds in (the "all is lost" beat). Recovery in the final stretch reaches a higher peak than the first rise. Finale is unambiguous triumph.',
  },
  {
    id: 'oedipus',
    label: 'Oedipus',
    description: 'Falls, briefly recovers, falls again to the worst.',
    points: [0.3, -0.2, -0.7, 0.2, 0.5, 0, -1],
    guidance: 'Open near baseline. Fall to a first low in the first third, recover apparently in the middle, then fall further to the arc\'s nadir at the finale. The second fall must reframe the apparent recovery as illusion or trap.',
  },
  {
    id: 'boy-meets-girl',
    label: 'Boy Meets Girl',
    description: 'Gets the thing, loses it, gets it back for good.',
    points: [0, 0.6, 0.9, 0.2, -0.5, 0.3, 0.9],
    guidance: 'Open at baseline. Get the thing (relationship, goal, identity) early; lose it around two-thirds in; reclaim it permanently by the finale. Three-act emotional rhythm: gain, loss, restored gain. Finale is unambiguous reunion or restoration.',
  },
  {
    id: 'creation-story',
    label: 'Creation Story',
    description: 'Stepped ascent — each plateau is a new world.',
    points: [-1, -1, -0.4, -0.4, 0.3, 0.3, 1],
    guidance: 'Stepped monotonic ascent. Each volume ends at a *new plateau* — qualitatively different from the previous, not just incrementally better. Plateaus matter as much as the climbs; finale is the highest plateau.',
  },
]);

export const ARC_SHAPE_IDS = Object.freeze(ARC_SHAPES.map((s) => s.id));

const ARC_SHAPES_BY_ID = new Map(ARC_SHAPES.map((s) => [s.id, s]));

export function getArcShape(id) {
  return ARC_SHAPES_BY_ID.get(id) || null;
}

/**
 * Convert the 7-point fortune curve to a human label at a given normalized
 * position (0..1). The LLM gets words it can reason about — "low", "rising",
 * "peak" — instead of a raw float that doesn't translate into beats.
 */
function describeFortuneLevel(v) {
  if (v >= 0.75) return 'peak / triumphant';
  if (v >= 0.35) return 'high / favorable';
  if (v >= -0.15) return 'near baseline';
  if (v >= -0.55) return 'low / strained';
  return 'nadir / ruinous';
}

function describeFortuneMovement(prev, curr) {
  const delta = curr - prev;
  if (delta >= 0.4) return 'sharp climb';
  if (delta >= 0.12) return 'steady climb';
  if (delta <= -0.4) return 'sharp fall';
  if (delta <= -0.12) return 'steady fall';
  return 'plateau';
}

// Sample the 7-point series at a normalized index (0..n-1, fractional allowed)
// with linear interpolation. Returns 0 when the shape is unknown so callers
// get a defined number even off the happy path.
function sampleShapePoints(points, idx) {
  if (!Array.isArray(points) || points.length === 0) return 0;
  const clamped = Math.max(0, Math.min(points.length - 1, idx));
  const lo = Math.floor(clamped);
  const hi = Math.min(points.length - 1, lo + 1);
  const t = clamped - lo;
  return points[lo] * (1 - t) + points[hi] * t;
}

/**
 * Describe one season's expected emotional position within an arc shape.
 * Returns null when shape is unknown or totals are invalid — the prompt
 * builder then renders a "no shape selected" fallback.
 *
 * `seasonNumber` and `totalSeasons` are 1-based; `seasonNumber=1, totalSeasons=3`
 * maps to ~point[1] in a 7-point series, etc.
 */
export function describeArcShapePositionForSeason(shapeId, seasonNumber, totalSeasons) {
  const shape = getArcShape(shapeId);
  if (!shape) return null;
  if (!Number.isFinite(totalSeasons) || !Number.isFinite(seasonNumber)) return null;
  const n = Math.floor(totalSeasons);
  const k = Math.floor(seasonNumber);
  if (n < 1 || k < 1 || k > n) return null;
  const pts = shape.points;
  // Map season index → point index. Season 1 of 1 hits the midpoint; season 1
  // of N hits the start, season N of N hits the end.
  const normalized = n === 1 ? (pts.length - 1) / 2 : ((k - 1) / (n - 1)) * (pts.length - 1);
  const curr = sampleShapePoints(pts, normalized);
  const prev = k > 1 ? sampleShapePoints(pts, ((k - 2) / (n - 1)) * (pts.length - 1)) : null;
  const level = describeFortuneLevel(curr);
  const movement = prev == null ? 'opening position' : describeFortuneMovement(prev, curr);
  return {
    level,
    movement,
    fortune: Number(curr.toFixed(2)),
    summary: `Volume ${k} of ${n} in a "${shape.label}" arc — emotional fortune should sit at ${level} (${movement}).`,
  };
}

/**
 * Block of arc-level shape guidance for prompt contexts. Returns a multi-line
 * string when the series has a picked shape, or null when it doesn't — the
 * prompt template treats null as "no shape selected; propose one if helpful."
 */
export function renderArcShapeGuidance(shapeId) {
  const shape = getArcShape(shapeId);
  if (!shape) return null;
  return `Picked story shape: **${shape.label}** (${shape.id}). ${shape.description}\n\nShape guidance: ${shape.guidance}`;
}

// Convenience for prompt contexts that only need the one-line position summary
// (not the full {level, movement, fortune} object). Returns null when shape /
// season / totals are missing, so callers can OR-fallback to a context-
// specific "no shape" string while keeping that fallback text at the call site.
export function renderArcShapePositionSummary(shapeId, seasonNumber, totalSeasons) {
  const position = describeArcShapePositionForSeason(shapeId, seasonNumber, totalSeasons);
  return position ? position.summary : null;
}

const SEASON_ID_PREFIX = 'sea-';
// `id` of an existing season as written by us. Used by `sanitizeSeason` so
// callers (route patch handlers, season service) accept either an id we
// generated or an opaque id from an imported series file.
const SEASON_ID_RE = /^sea-[a-zA-Z0-9-]+$/;

const nowIso = () => new Date().toISOString();

function ensureSeasonId(raw) {
  if (isStr(raw) && SEASON_ID_RE.test(raw)) return raw;
  return `${SEASON_ID_PREFIX}${randomUUID()}`;
}

export function cleanThemes(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const v of raw) {
    const s = trimTo(v, ARC_LIMITS.THEME_MAX);
    if (s) out.push(s);
    if (out.length >= ARC_LIMITS.THEMES_PER_ARC_MAX) break;
  }
  return out;
}

// Reader-map entry ids are minted as `rm-<uuid>` so payoffs can reference the
// hook they resolve (`resolvesHookId`) and the client can key list rows.
const RM_ID_RE = /^rm-[a-zA-Z0-9-]+$/;
const ensureRmId = (raw) => (isStr(raw) && RM_ID_RE.test(raw) ? raw : `rm-${randomUUID()}`);

// Optional non-negative integer position. Absent / non-finite → null so the
// caller can distinguish "no position pinned" from position 0.
const optPosition = (raw, max) => (Number.isFinite(raw) ? Math.max(0, Math.min(max, Math.floor(raw))) : null);

// Clamp a beat's reader-intensity to [0,1]; non-finite → null (unspecified).
const clampIntensity = (raw) => (Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : null);

function sanitizeReaderHook(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const label = trimTo(raw.label, READER_MAP_LIMITS.LABEL_MAX);
  const note = trimTo(raw.note, READER_MAP_LIMITS.NOTE_MAX);
  if (!label && !note) return null;
  return { id: ensureRmId(raw.id), label, atArcPosition: optPosition(raw.atArcPosition, READER_MAP_LIMITS.ARC_POSITION_MAX), note };
}

function sanitizeReaderPayoff(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const label = trimTo(raw.label, READER_MAP_LIMITS.LABEL_MAX);
  const note = trimTo(raw.note, READER_MAP_LIMITS.NOTE_MAX);
  if (!label && !note) return null;
  return {
    id: ensureRmId(raw.id),
    label,
    atArcPosition: optPosition(raw.atArcPosition, READER_MAP_LIMITS.ARC_POSITION_MAX),
    resolvesHookId: isStr(raw.resolvesHookId) && RM_ID_RE.test(raw.resolvesHookId) ? raw.resolvesHookId : null,
    note,
  };
}

function sanitizeReaderBeat(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // Unknown `kind` drops the whole beat — a beat with no classified kind can't
  // be placed on the reader-map timeline meaningfully.
  const kind = READER_MAP_BEAT_KINDS.includes(raw.kind) ? raw.kind : null;
  if (!kind) return null;
  return {
    id: ensureRmId(raw.id),
    kind,
    atArcPosition: optPosition(raw.atArcPosition, READER_MAP_LIMITS.ARC_POSITION_MAX),
    intensity: clampIntensity(raw.intensity),
    note: trimTo(raw.note, READER_MAP_LIMITS.NOTE_MAX),
  };
}

function sanitizeReaderCliffhanger(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const note = trimTo(raw.note, READER_MAP_LIMITS.NOTE_MAX);
  const atIssueBoundary = optPosition(raw.atIssueBoundary, READER_MAP_LIMITS.ISSUE_BOUNDARY_MAX);
  if (!note && atIssueBoundary == null) return null;
  return { id: ensureRmId(raw.id), atIssueBoundary, note };
}

function cleanReaderMapList(rawList, fn, cap) {
  if (!Array.isArray(rawList)) return [];
  const out = [];
  for (const raw of rawList) {
    const v = fn(raw);
    if (v) out.push(v);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Sanitize the optional `series.arc.readerMap` field. Returns `null` when the
 * map carries no identifying content (all four lists empty) so callers store
 * `null` to mean "no reader map yet" — mirroring `sanitizeArc`. Drops malformed
 * entries, caps each list, coerces ids to `rm-<uuid>`, clamps `intensity` to
 * [0,1], and drops beats with an unknown `kind`.
 */
export function sanitizeReaderMap(raw) {
  if (raw == null || typeof raw !== 'object') return null;
  const hooks = cleanReaderMapList(raw.hooks, sanitizeReaderHook, READER_MAP_LIMITS.HOOKS_MAX);
  const payoffs = cleanReaderMapList(raw.payoffs, sanitizeReaderPayoff, READER_MAP_LIMITS.PAYOFFS_MAX);
  const beats = cleanReaderMapList(raw.beats, sanitizeReaderBeat, READER_MAP_LIMITS.BEATS_MAX);
  const cliffhangers = cleanReaderMapList(raw.cliffhangers, sanitizeReaderCliffhanger, READER_MAP_LIMITS.CLIFFHANGERS_MAX);
  if (hooks.length === 0 && payoffs.length === 0 && beats.length === 0 && cliffhangers.length === 0) return null;
  const status = READER_MAP_STATUSES.includes(raw.status) ? raw.status : 'draft';
  return { hooks, payoffs, beats, cliffhangers, status };
}

// One reminder beat that keeps the countdown alive in the reader's mind.
// Reuses the `rm-<uuid>` id minter (reminders are reader-map-flavored entries)
// so the client has a stable list key. Dropped when it carries no note and no
// issue pointer — an empty reminder has nothing to render or reason about.
function sanitizeTickingClockReminder(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const note = trimTo(raw.note, TICKING_CLOCK_LIMITS.REMINDER_NOTE_MAX);
  const atIssue = optPosition(raw.atIssue, TICKING_CLOCK_LIMITS.ISSUE_MAX);
  if (!note && atIssue == null) return null;
  return { id: ensureRmId(raw.id), atIssue, note };
}

/**
 * Sanitize the optional singular `series.arc.tickingClock`. Returns `null` when
 * the clock carries no identifying content (disabled, no label/stakes/positions
 * and no reminders) so callers store `null` to mean "no ticking clock" —
 * mirroring `sanitizeReaderMap`. An explicit `enabled: true` is identifying
 * content on its own (the author declared the story *has* a countdown), so a
 * toggled-on-but-otherwise-blank clock survives. Unknown `kind` falls back to
 * `custom` rather than dropping the clock.
 */
export function sanitizeTickingClock(raw) {
  if (raw == null || typeof raw !== 'object') return null;
  const label = trimTo(raw.label, TICKING_CLOCK_LIMITS.LABEL_MAX);
  const stakes = trimTo(raw.stakes, TICKING_CLOCK_LIMITS.STAKES_MAX);
  const kind = TICKING_CLOCK_KINDS.includes(raw.kind) ? raw.kind : 'custom';
  const plantedAtArcPosition = optPosition(raw.plantedAtArcPosition, TICKING_CLOCK_LIMITS.ARC_POSITION_MAX);
  const dueAtArcPosition = optPosition(raw.dueAtArcPosition, TICKING_CLOCK_LIMITS.ARC_POSITION_MAX);
  const reminders = cleanReaderMapList(raw.reminders, sanitizeTickingClockReminder, TICKING_CLOCK_LIMITS.REMINDERS_MAX);
  const enabled = raw.enabled === true;
  if (!enabled && !label && !stakes && plantedAtArcPosition == null && dueAtArcPosition == null && reminders.length === 0) {
    return null;
  }
  return { enabled, label, kind, plantedAtArcPosition, dueAtArcPosition, stakes, reminders };
}

/**
 * Block of ticking-clock guidance for prompt contexts. Returns a single-line
 * string only when the clock is *enabled* (a disabled draft clock must not
 * steer generation), or null otherwise. The arc-level call sites OR-fold it
 * into the existing `shapeGuidance` block so no stage-prompt template needs a
 * new variable (and thus no migration); the per-issue idea stage instead
 * surfaces it as its own `{{tickingClock}}` template variable, which DID need a
 * migration (098, #1356). Mirrors `renderArcShapeGuidance`.
 */
export function renderTickingClock(clock) {
  if (!clock || clock.enabled !== true) return null;
  const parts = [`Ticking clock / countdown the reader is anticipating: **${clock.label || '(unnamed countdown)'}** (${clock.kind || 'custom'}).`];
  if (clock.stakes) parts.push(`Stakes if it runs out: ${clock.stakes}.`);
  const span = [];
  if (clock.plantedAtArcPosition != null) span.push(`planted at arc position ${clock.plantedAtArcPosition}`);
  if (clock.dueAtArcPosition != null) span.push(`due at arc position ${clock.dueAtArcPosition}`);
  if (span.length) parts.push(`Timing: ${span.join(', ')}.`);
  if (Array.isArray(clock.reminders) && clock.reminders.length) {
    const notes = clock.reminders.map((r) => r.note || `(issue ${r.atIssue ?? '?'})`).join('; ');
    parts.push(`Reminder beats keeping it in the reader's mind: ${notes}.`);
  }
  parts.push('Reinforce this countdown: plant it early, remind the reader through the middle, and pay it off at the due position.');
  return parts.join(' ');
}

// Foreshadowing-ledger entry ids are minted as `fs-<uuid>` so the client can
// key list rows and a payoff can be traced back to its seed. Accepts an
// opaque imported id that already matches the shape.
const FS_ID_RE = /^fs-[a-zA-Z0-9-]+$/;
const ensureFsId = (raw) => (isStr(raw) && FS_ID_RE.test(raw) ? raw : `fs-${randomUUID()}`);

// Clean a list of issue-number positions (the reinforce beats): coerce each to
// a non-negative int within range, drop non-finite entries, dedupe, sort
// ascending, and cap. An empty/invalid input yields [].
function cleanReinforceIssues(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  for (const v of raw) {
    const n = optPosition(v, FORESHADOW_LIMITS.ISSUE_MAX);
    if (n != null) seen.add(n);
    if (seen.size >= FORESHADOW_LIMITS.REINFORCE_MAX) break;
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * Sanitize one foreshadowing-ledger entry. Returns `null` when the entry
 * carries no identifying content (no label/note and no plant/payoff position)
 * so an empty row from the LLM is dropped. The plant-to-payoff distance rule
 * (>= 3 issues) is a generation instruction enforced in the arc-overview prompt,
 * not here — the sanitizer stores the ledger faithfully as authored.
 */
export function sanitizeForeshadowingEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const label = trimTo(raw.label, FORESHADOW_LIMITS.LABEL_MAX);
  const note = trimTo(raw.note, FORESHADOW_LIMITS.NOTE_MAX);
  const plantIssue = optPosition(raw.plantIssue, FORESHADOW_LIMITS.ISSUE_MAX);
  const payoffIssue = optPosition(raw.payoffIssue, FORESHADOW_LIMITS.ISSUE_MAX);
  if (!label && !note && plantIssue == null && payoffIssue == null) return null;
  const reinforceIssues = cleanReinforceIssues(raw.reinforceIssues);
  return { id: ensureFsId(raw.id), label, plantIssue, reinforceIssues, payoffIssue, note };
}

/**
 * Sanitize the optional `series.arc.foreshadowing` ledger. Always returns an
 * array (empty when nothing is authored) — mirroring `themes`, which is also a
 * plain always-array field on the arc. Drops malformed/empty entries and caps
 * the list.
 */
export function sanitizeForeshadowing(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    const v = sanitizeForeshadowingEntry(entry);
    if (v) out.push(v);
    if (out.length >= FORESHADOW_LIMITS.ENTRIES_MAX) break;
  }
  return out;
}

/**
 * Sanitize the optional `series.arc` field. Returns `null` if the input is
 * empty (no identifying fields) — callers store `null` to mean "no arc yet."
 * Anything else round-trips through the canonical shape with explicit
 * type-safe defaults so a partial-shape payload from the LLM (or an old
 * series.json) never crashes downstream readers.
 */
export function sanitizeArc(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object') return null;
  // Prose fields use the boundary-aware cap so an over-cap value never clips
  // mid-word (which arc-verify flags as a truncation it can't converge on).
  const logline = trimToClause(raw.logline, ARC_LIMITS.LOGLINE_MAX);
  const summary = trimToClause(raw.summary, ARC_LIMITS.SUMMARY_MAX);
  const protagonistArc = trimToClause(raw.protagonistArc, ARC_LIMITS.PROTAGONIST_ARC_MAX);
  const themes = cleanThemes(raw.themes);
  // An arc with zero identifying content is indistinguishable from "no arc"
  // — store null so the UI can render the empty state instead of a blank
  // expanded panel. This also keeps the JSON tighter on disk. A picked
  // `shape` counts as identifying content: it's an explicit narrative
  // decision the user made at create time and shouldn't silently vanish.
  const shape = isStr(raw.shape) && ARC_SHAPE_IDS.includes(raw.shape) ? raw.shape : null;
  // The reader map is identifying content too — an arc that has only a reader
  // map (e.g. the Story Builder generated it before any logline) must survive.
  const readerMap = sanitizeReaderMap(raw.readerMap);
  // The ticking clock is identifying content as well — an arc whose only
  // authored decision is "this story has a countdown" must round-trip.
  const tickingClock = sanitizeTickingClock(raw.tickingClock);
  // The foreshadowing ledger is identifying content too — an arc whose only
  // authored content is a set of planted seeds must survive.
  const foreshadowing = sanitizeForeshadowing(raw.foreshadowing);
  if (!logline && !summary && !protagonistArc && themes.length === 0 && !shape && !readerMap && !tickingClock && foreshadowing.length === 0) return null;
  const status = ARC_STATUSES.includes(raw.status) ? raw.status : 'draft';
  return { logline, summary, protagonistArc, themes, shape, readerMap, tickingClock, foreshadowing, status };
}

/**
 * Sanitize one season. Returns `null` if the season has no identifying content
 * (no title and no number > 0) — `sanitizeSeasonList` then drops it on the
 * floor. `preserveTimestamps: false` forces a fresh `updatedAt` (used when a
 * patch lands on an existing season).
 */
export function sanitizeSeason(raw, { preserveTimestamps = true } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const title = trimTo(raw.title, ARC_LIMITS.SEASON_TITLE_MAX);
  const number = Number.isFinite(raw.number)
    ? Math.max(0, Math.min(ARC_LIMITS.SEASON_NUMBER_MAX, Math.floor(raw.number)))
    : 0;
  // A season with neither a title nor a positive number is unaddressable —
  // there's nothing for the UI to render and nothing for an issue's
  // `seasonId` pointer to match against meaningfully.
  if (!title && number <= 0) return null;
  const episodeCountTarget = Number.isFinite(raw.episodeCountTarget)
    ? Math.max(0, Math.min(ARC_LIMITS.SEASON_EPISODE_COUNT_MAX, Math.floor(raw.episodeCountTarget)))
    : 0;
  const status = SEASON_STATUSES.includes(raw.status) ? raw.status : 'draft';
  const created = preserveTimestamps && isStr(raw.createdAt) ? raw.createdAt : nowIso();
  const updated = preserveTimestamps && isStr(raw.updatedAt) ? raw.updatedAt : nowIso();
  return {
    id: ensureSeasonId(raw.id),
    number,
    title,
    // Prose fields use the boundary-aware cap (trimToClause) so an over-cap
    // value clips on a sentence/word boundary instead of mid-word — otherwise a
    // hard clip reads as "truncated mid-sentence" to arc-verify, which then
    // can't converge (the resolver regenerates an over-cap value that's
    // re-clipped the same way every round). See arc-verify truncation findings,
    // 2026-06-21.
    logline: trimToClause(raw.logline, ARC_LIMITS.SEASON_LOGLINE_MAX),
    synopsis: trimToClause(raw.synopsis, ARC_LIMITS.SEASON_SYNOPSIS_MAX),
    episodeCountTarget,
    themes: cleanThemes(raw.themes),
    endingHook: trimToClause(raw.endingHook, ARC_LIMITS.SEASON_ENDING_HOOK_MAX),
    // Volume (season) cover + back cover. Same script + proof + final
    // slot shape as an issue cover; rendered by enqueueVolumeCover and
    // assembled into the volume PDF as the trade-paperback bookends.
    // Both default to null; the season-cover render route writes them.
    cover: sanitizeCoverLike(raw.cover),
    backCover: sanitizeCoverLike(raw.backCover),
    status,
    // Per-season editorial lock. When true the season's metadata (title,
    // logline, synopsis, etc.) is frozen against rewriters: the
    // generateSeasonEpisodes LLM pass refuses to seed new issues, deleteSeason
    // refuses, and bulkReassignSeason refuses to move issues into or out of
    // it. Mirrors the binary semantics of `series.locked.arc`. Sibling to
    // `status` — `status` is descriptive (where am I in the workflow?) while
    // `locked` is enforcement (don't let LLM-driven jobs touch this).
    locked: raw.locked === true,
    createdAt: created,
    updatedAt: updated,
  };
}

/**
 * Sanitize the `series.seasons[]` field. Drops rejected entries, caps at
 * SEASONS_PER_SERIES_MAX, deduplicates ids (last-write-wins on collision),
 * and sorts by `number` ascending so consumers can render straight from the
 * array.
 *
 * LWW dedupe is silent — surfacing the collision matters because child issues
 * carry `seasonId` pointers, so a dropped duplicate leaves those issues
 * attached to the surviving season under the colliding id, which is rarely
 * what the producer (usually an LLM rewrite) intended. The helper warns on
 * duplicates with the offending ids so the responsible run is grep-able in
 * logs without crashing the persist path.
 */
export function sanitizeSeasonList(rawList, opts = {}) {
  if (!Array.isArray(rawList)) return [];
  const byId = new Map();
  const duplicateIds = [];
  for (const raw of rawList) {
    const s = sanitizeSeason(raw, opts);
    if (!s) continue;
    const atCap = byId.size >= ARC_LIMITS.SEASONS_PER_SERIES_MAX;
    if (byId.has(s.id)) {
      duplicateIds.push(s.id);
      // Within-cap duplicates still LWW; past-cap duplicates only warn so the
      // historical first-wins-past-cap outcome is preserved and the warning
      // is the only new signal.
      if (!atCap) byId.set(s.id, s);
      continue;
    }
    if (atCap) continue;
    byId.set(s.id, s);
  }
  if (duplicateIds.length) {
    const distinct = [...new Set(duplicateIds)];
    console.warn(
      `⚠️ sanitizeSeasonList collapsed ${duplicateIds.length} duplicate season entry/entries across ${distinct.length} colliding id(s): ${distinct.join(', ')} — child issues stay attached to the surviving entry`,
    );
  }
  return [...byId.values()].sort((a, b) => (a.number || 0) - (b.number || 0));
}

/**
 * Build a fresh season from a create payload. The route layer enforces a
 * minimum shape (title + number) via zod; this function fills in id,
 * timestamps, and the canonical defaults.
 */
export function buildSeason(input = {}) {
  const now = nowIso();
  return sanitizeSeason({
    id: `${SEASON_ID_PREFIX}${randomUUID()}`,
    number: input.number,
    title: input.title,
    logline: input.logline,
    synopsis: input.synopsis,
    episodeCountTarget: input.episodeCountTarget,
    themes: input.themes,
    endingHook: input.endingHook,
    status: input.status,
    createdAt: now,
    updatedAt: now,
  });
}
