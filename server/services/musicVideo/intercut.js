/**
 * Music Video — intercut edit pass (#9290).
 *
 * The shot plan ties every cut to one generated clip, so cutting faster used
 * to mean paying for more clips. A reference analysis of a viral AI music
 * video (#9289) found ~2.6x our cut rate from ~the same per-frame motion: its
 * pace comes from the EDIT — shots of 1–4 beats in high-energy sections,
 * cuts on sung words, and A/B intercuts that reuse footage.
 *
 * This pass re-cuts the resolved clip list at render time without generating
 * anything:
 *
 *   - each section gets a target shot length from its energy rank (the
 *     loudest quarter of the song cuts every 2 beats, the quietest every 8);
 *   - a footage or still shot longer than ~1.3 targets is split; a cut prefers a sung
 *     word's onset (snapped to the half-beat grid when close), else the
 *     half-beat nearest the target;
 *   - pieces alternate between the host shot — which keeps its continuous
 *     time, so a lip-synced performance stays in sync — and a partner cutaway
 *     from the same section (else the nearest one), played from the part of
 *     its take the edit never showed (its tail after its own out-point);
 *   - performance clips are never partners: a sung take only matches the song
 *     at its own time. Stills and cards pass through untouched.
 *
 * Pure and deterministic. Every piece reads inside its source (a looping
 * source may wrap); the output tiles exactly the same timeline as the input.
 */

const EPS = 1e-6;
const MIN_PIECE_SEC = 0.4;
const WORD_SNAP_SEC = 0.08;
// Energy rank (0 = quietest section, 1 = loudest) → shot length in beats.
const TIERS = Object.freeze([[0.75, 2], [0.4, 3], [0.15, 4], [0, 8]]);

const round3 = (n) => Math.round(n * 1000) / 1000;
const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/** Seconds per beat: the analysis BPM, else the median beat gap; null without either. */
function beatPeriod(bpm, beats) {
  if (finite(bpm) && bpm > 0) return 60 / bpm;
  const gaps = [];
  for (let i = 1; i < beats.length; i += 1) if (beats[i] > beats[i - 1]) gaps.push(beats[i] - beats[i - 1]);
  if (!gaps.length) return null;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/** Each section's energy as a 0..1 rank among the song's sections. */
function sectionRanks(sections) {
  const valid = sections.filter((s) => finite(s?.startSec) && finite(s?.endSec) && s.endSec > s.startSec);
  const energies = valid.map((s) => (finite(s.energy) ? s.energy : 0));
  const sorted = [...energies].sort((a, b) => a - b);
  return valid.map((s, i) => {
    const e = energies[i];
    const below = sorted.filter((x) => x < e).length;
    return { startSec: s.startSec, endSec: s.endSec, rank: sorted.length > 1 ? below / (sorted.length - 1) : 0.5, index: i };
  });
}

const tierBeats = (rank) => TIERS.find(([min]) => rank >= min - EPS)[1];

function sectionAt(ranked, t) {
  return ranked.find((s) => t >= s.startSec - EPS && t < s.endSec - EPS) || ranked[ranked.length - 1] || null;
}

/**
 * Cut times strictly inside (t0, t1) for a target piece length: word onsets
 * (snapped to the half-beat grid when within WORD_SNAP_SEC) are preferred
 * within half a beat of the ideal cut; otherwise the half-beat nearest it.
 */
function cutTimes(t0, t1, target, halfGrid, onsets, period) {
  const cuts = [];
  const minPiece = Math.max(MIN_PIECE_SEC, period * 0.75);
  let from = t0;
  while (t1 - from > target * 1.3) {
    const ideal = from + target;
    const window = period / 2;
    const ok = (t) => t - from >= minPiece - EPS && t1 - t >= minPiece - EPS;
    let pick = null;
    let best = Infinity;
    for (const w of onsets) {
      if (w < ideal - window || w > ideal + window || !ok(w)) continue;
      const snapped = nearest(halfGrid, w);
      const at = snapped != null && Math.abs(snapped - w) <= WORD_SNAP_SEC ? snapped : w;
      if (ok(at) && Math.abs(at - ideal) < best) { best = Math.abs(at - ideal); pick = at; }
    }
    if (pick == null) {
      const g = nearest(halfGrid, ideal);
      pick = g != null && Math.abs(g - ideal) <= window && ok(g) ? g : ideal;
      if (!ok(pick)) break;
    }
    cuts.push(round3(pick));
    from = pick;
  }
  return cuts;
}

function nearest(sorted, t) {
  if (!sorted.length) return null;
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < t) lo = mid + 1; else hi = mid;
  }
  const a = sorted[lo];
  const b = lo > 0 ? sorted[lo - 1] : a;
  return Math.abs(a - t) <= Math.abs(b - t) ? a : b;
}

/**
 * Re-cut `clips` (the snapped, coverage-checked render list, in timeline
 * order). `scenes` supply each clip's shot mode; `sections` (with `energy`),
 * `beats`/`bpm` and sung `words` (`[{ startSec }]`) drive the pacing.
 * Returns a new clip list; the input is returned as-is when there is no beat
 * grid to cut on.
 */
export function intercutClips(clips, { scenes = [], sections = [], beats = [], bpm = null, words = [] } = {}) {
  const list = Array.isArray(clips) ? clips : [];
  const grid = (Array.isArray(beats) ? beats : []).filter(finite).sort((a, b) => a - b);
  const period = beatPeriod(bpm, grid);
  const ranked = sectionRanks(Array.isArray(sections) ? sections : []);
  if (!period || !grid.length || !ranked.length || !list.length) return list;
  const halfGrid = [];
  for (let i = 0; i < grid.length; i += 1) {
    halfGrid.push(grid[i]);
    halfGrid.push(grid[i] + (i + 1 < grid.length ? (grid[i + 1] - grid[i]) / 2 : period / 2));
  }
  const onsets = (Array.isArray(words) ? words : []).map((w) => w?.startSec).filter(finite).sort((a, b) => a - b);
  const modes = new Map((Array.isArray(scenes) ? scenes : []).map((s) => [s?.sceneId, s?.shotMode]));

  // Place every clip on the timeline.
  let cursor = 0;
  const placed = list.map((clip) => {
    const span = clip.outSec - clip.inSec;
    const entry = { clip, t0: cursor, t1: cursor + span, section: sectionAt(ranked, cursor + span / 2) };
    cursor += span;
    return entry;
  });

  // Partner cutaways: footage that is not a sung performance, each with a
  // read head starting after the part the edit already shows.
  const partners = placed
    .filter(({ clip }) => !clip.layer && clip.videoPath && modes.get(clip.sceneId) !== 'performance' && finite(clip.sourceSec) && clip.sourceSec > MIN_PIECE_SEC)
    .map((p) => ({ ...p, head: p.clip.outSec, start: p.clip.inSec, end: p.clip.inSec + p.clip.sourceSec }));

  function takePartner(host, len) {
    const pool = partners.filter((p) => p.clip.sceneId !== host.clip.sceneId && p.clip.videoPath !== host.clip.videoPath && p.end - p.start >= len - EPS);
    if (!pool.length) return null;
    const sameSection = pool.filter((p) => p.section?.index === host.section?.index);
    const candidates = sameSection.length ? sameSection : pool;
    // Nearest in time, then the one with the most unshown footage left.
    candidates.sort((a, b) => Math.abs(a.t0 - host.t0) - Math.abs(b.t0 - host.t0) || (b.end - b.head) - (a.end - a.head));
    const p = candidates[0];
    if (p.head + len > p.end + EPS) p.head = p.start; // wrap: reuse from the take's start
    const inSec = round3(p.head);
    p.head = inSec + len;
    return { ...p.clip, inSec, outSec: round3(inSec + len), duration: round3(len), loop: false, sourceSec: round3(p.end - inSec), intercutOf: host.clip.sceneId };
  }

  const out = [];
  for (const host of placed) {
    const { clip, t0, t1, section } = host;
    const still = clip.layer === 'still';
    if ((clip.layer && !still) || (!still && !clip.videoPath) || !section) { out.push(clip); continue; }
    const target = tierBeats(section.rank) * period;
    const cuts = cutTimes(t0, t1, target, halfGrid, onsets, period);
    if (!cuts.length) { out.push(clip); continue; }
    const bounds = [t0, ...cuts, t1];
    for (let k = 0; k < bounds.length - 1; k += 1) {
      const a = bounds[k];
      const len = round3(bounds[k + 1] - a);
      const partner = k % 2 === 1 ? takePartner(host, len) : null;
      if (partner) { out.push(partner); continue; }
      if (still) { out.push({ ...clip, inSec: 0, outSec: len, duration: len, sourceSec: len }); continue; }
      // The host keeps its own continuous time (a performance stays in sync).
      const inSec = round3(clip.inSec + (a - t0));
      out.push({ ...clip, inSec, outSec: round3(inSec + len), duration: len, ...(clip.loop === false ? { sourceSec: round3(clip.inSec + (clip.sourceSec ?? clip.duration) - inSec) } : {}) });
    }
  }
  return out;
}
