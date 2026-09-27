/**
 * Music Video — deterministic shot plan (#8964).
 *
 * The planner used to seed ONE scene per analyzed section, so a 30s verse
 * became one 30s scene that the renderer then filled by looping a 6–10s
 * generated clip. This module instead tiles every section with several
 * bounded shots:
 *
 *   - no shot is longer than the pacing ceiling (by default the renderer's
 *     clip capacity), so each shot can be covered by ONE generated clip;
 *   - no shot is shorter than the pacing floor (a section shorter than the
 *     floor stays a single shot);
 *   - the very first shot is capped at the opening-hook length;
 *   - cuts prefer, in order: a timed lyric-line / phrase boundary (snapped to
 *     the beat grid when one is close), a downbeat, a beat — picking the
 *     candidate nearest an even split of what remains, so pacing stays even;
 *   - shots inside a section tile it exactly (no gap, no overlap), so the plan
 *     covers the same timeline the sections did.
 *
 * Every shot keeps its section identity (`sectionIndex` + `sectionLabel`) and
 * carries the lyric lines and phrase intent it spans, which the prompt seeder
 * reads. An instrumental stretch carries `lyricText: null` — nothing is
 * invented. Pure and deterministic: same inputs → same plan.
 */

import { snapSectionsToGrid } from './audioAnalysis.js';

const EPS = 1e-6;
const SECTION_LABEL_MAX = 120;
const LYRIC_TEXT_MAX = 2000;
// A lyric/phrase boundary within this distance of a grid point cuts ON the grid
// point: sung phrasing drifts a little off the beat, the picture should not.
const BOUNDARY_SNAP_SEC = 0.2;
// An untimed-end cue lasts until the next cue, capped here.
const OPEN_CUE_MAX_SEC = 8;
// Grok renders fixed 6s/10s clips; a local model's default render is ~5s
// (121 frames at 24fps). A project pacing ceiling overrides either.
export const DEFAULT_LOCAL_CLIP_CAPACITY_SEC = 5;
const DEFAULT_MIN_SHOT_SEC = 2;
const DEFAULT_HOOK_SEC = 3;

const round3 = (n) => Math.round(n * 1000) / 1000;
const sortedGrid = (list) => (Array.isArray(list) ? list : [])
  .filter((t) => typeof t === 'number' && Number.isFinite(t) && t >= 0)
  .sort((a, b) => a - b);

/** Seconds of footage one generated clip provides for the project's renderer. */
export function resolveClipCapacitySec(videoSettings) {
  if (videoSettings?.backend === 'grok') return videoSettings.grokDuration === 6 ? 6 : 10;
  return DEFAULT_LOCAL_CLIP_CAPACITY_SEC;
}

/**
 * Resolve the effective pacing range. The floor is held at or below half the
 * ceiling so any span longer than the ceiling can always be tiled within
 * [floor, ceiling]; the hook is clamped into the same range.
 */
export function resolvePacing(pacing, clipCapacitySec) {
  const maxShotSec = Math.max(1, pacing?.maxShotSec ?? clipCapacitySec);
  const minShotSec = Math.min(pacing?.minShotSec ?? DEFAULT_MIN_SHOT_SEC, maxShotSec / 2);
  const hookSec = Math.min(maxShotSec, Math.max(minShotSec, pacing?.hookSec ?? DEFAULT_HOOK_SEC));
  return { minShotSec, maxShotSec, hookSec };
}

/** Timed cues sorted by start, each with a resolved end (explicit, next cue, or capped open end). */
export function timedCues(cues) {
  const timed = (Array.isArray(cues) ? cues : [])
    .filter((c) => c && typeof c.text === 'string' && c.text.trim() && typeof c.startSec === 'number')
    .slice()
    .sort((a, b) => a.startSec - b.startSec);
  return timed.map((c, i) => {
    const next = timed[i + 1];
    const openEnd = Math.min(c.startSec + OPEN_CUE_MAX_SEC, next ? next.startSec : Infinity);
    const endSec = typeof c.endSec === 'number' && c.endSec > c.startSec ? c.endSec : openEnd;
    return { text: c.text.trim(), startSec: c.startSec, endSec };
  });
}

function timedPhrases(phrases) {
  return (Array.isArray(phrases) ? phrases : [])
    .filter((p) => p && typeof p.startSec === 'number' && typeof p.endSec === 'number' && p.endSec > p.startSec);
}

function nearestWithin(grid, t, tol) {
  let best = null;
  for (const g of grid) {
    if (Math.abs(g - t) <= tol && (best == null || Math.abs(g - t) < Math.abs(best - t))) best = g;
  }
  return best;
}

/**
 * Tier-ordered cut candidates: 0 = lyric/phrase boundary, 1 = downbeat, 2 = beat.
 * A boundary near a grid point is moved onto it (and counts as on-grid).
 */
function buildCandidates({ cues, phrases, beats, downbeats }) {
  const grid = [...downbeats, ...beats];
  const out = [];
  const boundaries = [
    ...cues.map((c) => c.startSec),
    ...phrases.flatMap((p) => [p.startSec, p.endSec]),
  ];
  for (const b of boundaries) {
    const snapped = nearestWithin(grid, b, BOUNDARY_SNAP_SEC);
    out.push({ t: snapped ?? b, tier: 0, onGrid: snapped != null });
  }
  for (const t of downbeats) out.push({ t, tier: 1, onGrid: true });
  for (const t of beats) out.push({ t, tier: 2, onGrid: true });
  return out;
}

/**
 * Split one section span into contiguous shot spans. Returns
 * `[{ startSec, endSec, cutOnGrid }]` where `cutOnGrid` says whether the
 * shot's END is an interior cut that landed on the grid (the section's own
 * edges are judged by the caller).
 */
function splitSpan(startSec, endSec, { minShotSec, maxShotSec, firstMaxSec, candidates, hasGrid }) {
  const shots = [];
  let cursor = startSec;
  let localMax = firstMaxSec ?? maxShotSec;
  while (endSec - cursor > localMax + EPS) {
    const remaining = endSec - cursor;
    const lo = cursor + minShotSec;
    const hi = Math.min(cursor + localMax, endSec - minShotSec);
    if (hi < lo - EPS) {
      // Only the hook can make the window empty (a ceiling below 2× floor is
      // excluded by resolvePacing): drop the hook cap rather than violate the floor.
      if (localMax < maxShotSec) { localMax = maxShotSec; continue; }
      break;
    }
    const pieces = Math.max(2, Math.ceil(remaining / maxShotSec));
    const ideal = Math.min(hi, Math.max(lo, cursor + Math.min(localMax, remaining / pieces)));
    let pick = null;
    for (let tier = 0; tier <= 2 && !pick; tier++) {
      for (const c of candidates) {
        if (c.tier !== tier || c.t < lo - EPS || c.t > hi + EPS) continue;
        if (!pick || Math.abs(c.t - ideal) < Math.abs(pick.t - ideal) - EPS) pick = c;
      }
    }
    const cut = pick ? round3(pick.t) : round3(ideal);
    shots.push({ startSec: cursor, endSec: cut, cutOnGrid: pick ? pick.onGrid : !hasGrid });
    cursor = cut;
    localMax = maxShotSec;
  }
  shots.push({ startSec: cursor, endSec: endSec, cutOnGrid: null });
  return shots;
}

function overlapSec(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

// A line belongs to a shot when a meaningful part of it plays inside the shot:
// at least half the line, or half a second of it.
function lyricsFor(cues, startSec, endSec) {
  const lines = cues.filter((c) => {
    const overlap = overlapSec(startSec, endSec, c.startSec, c.endSec);
    return overlap > EPS && (overlap >= 0.5 || overlap >= (c.endSec - c.startSec) / 2);
  }).map((c) => c.text);
  return lines.length > 0 ? lines.join(' / ').slice(0, LYRIC_TEXT_MAX) : null;
}

function phraseFor(phrases, startSec, endSec) {
  let best = null;
  let bestOverlap = 0;
  for (const p of phrases) {
    const overlap = overlapSec(startSec, endSec, p.startSec, p.endSec);
    if (overlap > bestOverlap + EPS) { best = p; bestOverlap = overlap; }
  }
  return best;
}

/**
 * Plan the shot list for a project.
 *
 * @param {Array<object>} sections — already filtered via planner.validSections
 * @param {object} options
 * @param {number[]} [options.beats]
 * @param {number[]} [options.downbeats]
 * @param {Array<object>} [options.lyricCues]
 * @param {Array<object>} [options.phrases]
 * @param {object} [options.pacing] — the project's `pacing` (nullable)
 * @param {number} [options.clipCapacitySec]
 * @param {number} [options.toleranceSec] / [options.minSceneSec] — section-snap overrides (tests)
 * @returns {{ shots: Array<object>, pacing: object }}
 *   each shot: `{ sectionIndex, sectionLabel, sectionEnergy, shotIndex, shotCount,
 *   startSec, endSec, beatAligned, lyricText, phraseLabel, visualIntent, hook }`
 */
export function planShots(sections, {
  beats = [], downbeats = [], lyricCues = [], phrases = [], pacing = null,
  clipCapacitySec = DEFAULT_LOCAL_CLIP_CAPACITY_SEC, toleranceSec, minSceneSec,
} = {}) {
  const beatGrid = sortedGrid(beats);
  const downbeatGrid = sortedGrid(downbeats);
  const hasGrid = beatGrid.length > 0 || downbeatGrid.length > 0;
  const resolved = resolvePacing(pacing, clipCapacitySec);
  const cues = timedCues(lyricCues);
  const marks = timedPhrases(phrases);
  const candidates = buildCandidates({ cues, phrases: marks, beats: beatGrid, downbeats: downbeatGrid });

  const { sections: snapped, beatAligned } = snapSectionsToGrid(sections, {
    downbeats: downbeatGrid, beats: beatGrid,
    ...(toleranceSec != null ? { toleranceSec } : {}),
    ...(minSceneSec != null ? { minSceneSec } : {}),
  });

  const shots = [];
  snapped.forEach((section, sectionIndex) => {
    const label = typeof section.label === 'string' ? section.label.slice(0, SECTION_LABEL_MAX) : '';
    const spans = splitSpan(section.startSec, section.endSec, {
      ...resolved,
      firstMaxSec: sectionIndex === 0 ? resolved.hookSec : null,
      candidates,
      hasGrid,
    });
    spans.forEach((span, shotIndex) => {
      // The section's own edges carry snapSectionsToGrid's verdict; an interior
      // edge carries whether its cut landed on the grid.
      const startOk = shotIndex === 0 ? beatAligned[sectionIndex] : spans[shotIndex - 1].cutOnGrid;
      const endOk = shotIndex === spans.length - 1 ? beatAligned[sectionIndex] : span.cutOnGrid;
      const phrase = phraseFor(marks, span.startSec, span.endSec);
      shots.push({
        sectionIndex,
        sectionLabel: label || null,
        sectionEnergy: typeof section.energy === 'number' ? section.energy : null,
        shotIndex,
        shotCount: spans.length,
        startSec: round3(span.startSec),
        endSec: round3(span.endSec),
        beatAligned: !!(startOk && endOk),
        lyricText: lyricsFor(cues, span.startSec, span.endSec),
        phraseLabel: phrase?.label || null,
        visualIntent: phrase?.intent || null,
        hook: sectionIndex === 0 && shotIndex === 0,
      });
    });
  });
  return { shots, pacing: resolved };
}
