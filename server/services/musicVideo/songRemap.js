/**
 * Revising a project's song: carry the video across to the new master.
 *
 * Pure helpers, no I/O. `diffLyricLines` compares the old and new lyric sheets
 * line by line so an unchanged line keeps its cue id (storyboard shots link
 * cues by id). Once the new song is aligned, `remapSongTimeline` moves every
 * timed shot from the old song's timeline to the new one through the lines
 * both songs share, and says which shots kept their lyrics, which changed,
 * which are new and which lost every line they carried.
 */

import { randomUUID } from 'crypto';
import { lyricTokens } from './timedText.js';

const EPS = 1e-6;
const round3 = (n) => Math.round(n * 1000) / 1000;
const isTime = (v) => typeof v === 'number' && Number.isFinite(v);
// A changed line still shares at least this much of its words with the line it replaces.
const CHANGED_LINE_SIMILARITY = 0.5;
// A shot shorter than this after an insertion is carved out of it is not worth keeping split.
const MIN_SHOT_SEC = 0.5;
const DEFAULT_NEW_SHOT_SEC = 8;
const LYRIC_TEXT_MAX = 2000;

const lineKey = (text) => lyricTokens(text).map((t) => t.key).join(' ');

function similarity(a, b) {
  const left = lyricTokens(a).map((t) => t.key);
  const right = lyricTokens(b).map((t) => t.key);
  if (!left.length || !right.length) return 0;
  const pool = [...right];
  let shared = 0;
  for (const word of left) {
    const at = pool.indexOf(word);
    if (at >= 0) { shared += 1; pool.splice(at, 1); }
  }
  return (2 * shared) / (left.length + right.length);
}

/** Longest common subsequence of two key lists, as matched index pairs in order. */
function lcsPairs(a, b) {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const table = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = a[i] && a[i] === b[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] && a[i] === b[j]) { pairs.push([i, j]); i++; j++; } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i++; else j++;
  }
  return pairs;
}

/**
 * Compare the project's current lyric lines with the revised song's lines.
 * Returns the new cue list (unchanged and lightly reworded lines keep the old
 * cue id; new lines get a fresh one), each new cue's status by id, the old
 * lines that were cut, and the counts.
 * @param {Array<{id:string,text:string}>} oldCues
 * @param {Array<{text:string}>} newCues — parsed, not yet id'd
 */
export function diffLyricLines(oldCues, newCues) {
  const before = (oldCues || []).filter((c) => c && typeof c.text === 'string');
  const after = (newCues || []).filter((c) => c && typeof c.text === 'string');
  const pairs = lcsPairs(before.map((c) => lineKey(c.text)), after.map((c) => lineKey(c.text)));
  const oldFor = new Array(after.length).fill(null);
  const status = new Array(after.length).fill('added');
  const used = new Set();
  const take = (oldIndex, newIndex, kind) => { oldFor[newIndex] = oldIndex; status[newIndex] = kind; used.add(oldIndex); };
  for (const [i, j] of pairs) take(i, j, 'kept');
  // Inside each gap between matched lines, pair a reworded line with the old
  // line it replaced, in order, so its shot keeps reading as the same moment.
  const bounds = [[-1, -1], ...pairs, [before.length, after.length]];
  for (let k = 0; k < bounds.length - 1; k++) {
    let cursor = bounds[k][0] + 1;
    for (let j = bounds[k][1] + 1; j < bounds[k + 1][1]; j++) {
      let best = -1;
      let bestScore = CHANGED_LINE_SIMILARITY - EPS;
      for (let i = cursor; i < bounds[k + 1][0]; i++) {
        const score = similarity(before[i].text, after[j].text);
        if (score > bestScore) { best = i; bestScore = score; }
      }
      if (best >= 0) { take(best, j, 'changed'); cursor = best + 1; }
    }
  }
  const cueStatus = {};
  const changedFrom = {};
  const cues = after.map((cue, j) => {
    const old = oldFor[j] == null ? null : before[oldFor[j]];
    const id = old?.id || `lc-${randomUUID()}`;
    cueStatus[id] = status[j];
    if (status[j] === 'changed') changedFrom[id] = old.text;
    const { startSec: _s, endSec: _e, words: _w, matched: _m, ...rest } = cue;
    return { ...rest, id };
  });
  const removed = before.filter((_, i) => !used.has(i)).map(({ id, text, startSec, endSec }) => ({ id, text, startSec: startSec ?? null, endSec: endSec ?? null }));
  const counts = { kept: 0, changed: 0, added: 0, removed: removed.length };
  for (const kind of status) counts[kind] += 1;
  return { cues, cueStatus, changedFrom, removed, counts };
}

/** The old timeline's lines and shots, captured before the new song replaces them. */
export function songBaseline(project) {
  const cues = (project.lyricCues || []).map(({ id, text, startSec, endSec }) => ({ id, text, startSec: startSec ?? null, endSec: endSec ?? null }));
  const scenes = (project.scenes || []).map(({ sceneId, startSec, endSec, lyricText }) => ({ sceneId, startSec: startSec ?? null, endSec: endSec ?? null, lyricText: lyricText ?? null }));
  const ends = [...cues, ...scenes].map((e) => e.endSec).filter(isTime);
  const durationSec = isTime(project.audioAnalysis?.durationSec) ? project.audioAnalysis.durationSec : (ends.length ? Math.max(...ends) : null);
  return { durationSec, cues, scenes };
}

/** Longest run of anchors rising in old time and never falling in new time (a cut line closes its gap). */
function monotoneAnchors(anchors) {
  const sorted = [...anchors].sort((a, b) => a.old - b.old || a.next - b.next);
  const tails = [];
  const prev = new Array(sorted.length).fill(-1);
  for (let i = 0; i < sorted.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const t = sorted[tails[mid]];
      if (t.next <= sorted[i].next + EPS && t.old < sorted[i].old - EPS) lo = mid + 1; else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const out = [];
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) out.unshift(sorted[i]);
  return out;
}

/**
 * A monotone old-time → new-time map through the line boundaries both songs
 * share. Outside the anchors the offset of the nearest anchor carries on.
 */
function buildTimeMap(anchors, { oldDurationSec = null, newDurationSec = null } = {}) {
  const points = monotoneAnchors([{ old: 0, next: 0 }, ...anchors.filter((a) => isTime(a.old) && isTime(a.next))]);
  if (isTime(oldDurationSec) && isTime(newDurationSec)) {
    const last = points[points.length - 1];
    if (oldDurationSec > last.old + EPS && newDurationSec > last.next + EPS) points.push({ old: oldDurationSec, next: newDurationSec });
  }
  const clamp = (t) => (isTime(newDurationSec) ? Math.min(Math.max(t, 0), newDurationSec) : Math.max(t, 0));
  return (t) => {
    if (!isTime(t)) return null;
    let i = 0;
    while (i < points.length - 1 && points[i + 1].old <= t) i++;
    const a = points[i];
    const b = points[i + 1];
    if (!b || b.old - a.old < EPS) return round3(clamp(t - a.old + a.next));
    return round3(clamp(a.next + ((t - a.old) * (b.next - a.next)) / (b.old - a.old)));
  };
}

// Same membership rule as the shot planner (shotPlan.js lyricsFor): a line
// belongs to a shot when half the line, or half a second of it, plays there.
function cuesIn(cues, startSec, endSec) {
  return cues.filter((c) => {
    if (!isTime(c.startSec) || !isTime(c.endSec)) return false;
    const overlap = Math.min(endSec, c.endSec) - Math.max(startSec, c.startSec);
    return overlap > EPS && (overlap >= 0.5 || overlap >= (c.endSec - c.startSec) / 2);
  });
}

const lyricTextOf = (cues) => (cues.length ? cues.map((c) => c.text).join(' / ').slice(0, LYRIC_TEXT_MAX) : null);

/** Consecutive runs of new lines, in lyric order, as `{ cues, startSec, endSec }`. */
function addedRuns(cues, cueStatus) {
  const runs = [];
  let run = null;
  for (const cue of cues) {
    const added = cueStatus[cue.id] === 'added' && isTime(cue.startSec) && isTime(cue.endSec);
    if (added) {
      if (!run) { run = { cues: [] }; runs.push(run); }
      run.cues.push(cue);
    } else run = null;
  }
  return runs.map((r) => ({ cues: r.cues, startSec: r.cues[0].startSec, endSec: r.cues[r.cues.length - 1].endSec }));
}

/** Split an inserted run into shots of at most `maxSec`, cutting on line boundaries. */
function splitRun(run, maxSec) {
  const shots = [];
  let current = null;
  for (const cue of run.cues) {
    if (current && cue.endSec - current.startSec > maxSec) current = null;
    if (!current) { current = { startSec: cue.startSec, endSec: cue.endSec, cues: [] }; shots.push(current); }
    current.cues.push(cue);
    current.endSec = cue.endSec;
  }
  return shots;
}

/**
 * Move the board to the new song once its lyrics are aligned.
 * @param {object} project — the project on the new song (aligned cues, fresh analysis)
 * @param {object} revision — its song revision (`baseline`, `cueStatus`, `changedFrom`)
 * @returns {{ scenes: object[], newScenes: object[], storyboard: object[]|null, sceneReview: object, counts: object }}
 *   `scenes` is the remapped existing board (same ids and order), `newScenes`
 *   the inputs for shots the inserted lines need, `sceneReview` each shot's
 *   status by id (`kept` | `changed` | `new` | `removed`).
 */
export function remapSongTimeline(project, revision) {
  const baseline = revision.baseline || { cues: [], scenes: [], durationSec: null };
  const cueStatus = revision.cueStatus || {};
  const newCues = (project.lyricCues || []).filter((c) => isTime(c.startSec) && isTime(c.endSec));
  const newById = new Map(newCues.map((c) => [c.id, c]));
  const newDurationSec = isTime(project.audioAnalysis?.durationSec) ? project.audioAnalysis.durationSec : null;
  const anchorsFor = (kinds) => baseline.cues.flatMap((old) => {
    const next = newById.get(old.id);
    if (!next || !kinds.includes(cueStatus[old.id]) || !isTime(old.startSec) || !isTime(old.endSec)) return [];
    return [{ old: old.startSec, next: next.startSec }, { old: old.endSec, next: next.endSec }];
  });
  // A reworded line is still sung at the same moment, so it anchors too; one that moved is dropped as non-monotone.
  const map = buildTimeMap(anchorsFor(['kept', 'changed']), { oldDurationSec: baseline.durationSec, newDurationSec });
  const oldTimed = baseline.cues.filter((c) => isTime(c.startSec) && isTime(c.endSec));
  const oldScene = new Map(baseline.scenes.map((s) => [s.sceneId, s]));

  const sceneReview = {};
  const touched = new Set();
  const scenes = (project.scenes || []).map((scene) => {
    const old = oldScene.get(scene.sceneId);
    if (!old || !isTime(old.startSec) || !isTime(old.endSec)) return scene;
    const startSec = map(old.startSec);
    const endSec = Math.max(startSec, map(old.endSec));
    const before = cuesIn(oldTimed, old.startSec, old.endSec);
    const after = cuesIn(newCues, startSec, endSec);
    const fates = before.map((c) => (newById.has(c.id) ? cueStatus[c.id] : 'removed'));
    const gained = after.some((c) => cueStatus[c.id] === 'added');
    const reworded = fates.some((f) => f !== 'kept');
    let status = 'kept';
    if (before.length && fates.every((f) => f === 'removed') && !after.length) status = 'removed';
    else if (reworded || gained) status = 'changed';
    sceneReview[scene.sceneId] = { status, previousLyricText: old.lyricText ?? null, hadRemovedLines: fates.includes('removed') };
    if (reworded) touched.add(scene.sceneId);
    return { ...scene, startSec, endSec, ...(status === 'changed' ? { lyricText: lyricTextOf(after) } : {}) };
  });

  // Inserted lines: a run no shot covers gets its own shots; a run a shot was
  // only stretched across (it lost no lines) is carved out of that shot.
  const maxSec = project.pacing?.maxShotSec || DEFAULT_NEW_SHOT_SEC;
  const newScenes = [];
  for (const run of addedRuns(project.lyricCues || [], cueStatus)) {
    const covering = scenes.filter((s) => sceneReview[s.sceneId] && isTime(s.startSec) && s.endSec - run.startSec > EPS && run.endSec - s.startSec > EPS);
    if (covering.some((s) => sceneReview[s.sceneId].hadRemovedLines)) continue; // a rewrite: its shots are re-planned
    let gap = { startSec: run.startSec, endSec: run.endSec };
    let carved = true;
    for (const s of covering) {
      const keepBefore = run.startSec - s.startSec;
      const keepAfter = s.endSec - run.endSec;
      // Leave the shot the side that holds its own lines; the rest goes to the insert.
      const ownLines = cuesIn(newCues, s.startSec, s.endSec).filter((c) => cueStatus[c.id] !== 'added');
      const linesBefore = ownLines.some((c) => c.endSec <= run.startSec + EPS);
      const side = keepBefore >= MIN_SHOT_SEC && (linesBefore || keepAfter < MIN_SHOT_SEC) ? 'before' : keepAfter >= MIN_SHOT_SEC ? 'after' : null;
      if (!side) { carved = false; continue; }
      const index = scenes.indexOf(s);
      if (side === 'before') {
        gap = { startSec: Math.min(gap.startSec, run.startSec), endSec: Math.max(gap.endSec, s.endSec) };
        scenes[index] = { ...s, endSec: run.startSec };
      } else {
        gap = { startSec: Math.min(gap.startSec, s.startSec), endSec: Math.max(gap.endSec, run.endSec) };
        scenes[index] = { ...s, startSec: run.endSec };
      }
      const left = scenes[index];
      const lines = cuesIn(newCues, left.startSec, left.endSec);
      const status = touched.has(s.sceneId) || lines.some((c) => cueStatus[c.id] !== 'kept') ? 'changed' : 'kept';
      sceneReview[s.sceneId] = { ...sceneReview[s.sceneId], status };
      scenes[index] = { ...left, lyricText: status === 'changed' ? lyricTextOf(lines) : (oldScene.get(s.sceneId).lyricText ?? null) };
    }
    if (!carved) continue; // too short to split: the shot it sits in is marked changed above
    const pieces = splitRun(run, maxSec);
    pieces[0].startSec = gap.startSec;
    pieces[pieces.length - 1].endSec = gap.endSec;
    for (const piece of pieces) {
      newScenes.push({ label: `New: ${piece.cues[0].text}`.slice(0, 120), startSec: round3(piece.startSec), endSec: round3(piece.endSec), lyricText: lyricTextOf(piece.cues), prompt: '' });
    }
  }

  const counts = { kept: 0, changed: 0, new: newScenes.length, removed: 0 };
  for (const entry of Object.values(sceneReview)) counts[entry.status] += 1;
  return { scenes, newScenes, sceneReview, counts, map };
}

/**
 * The saved storyboard shots on the new timeline: a shot bound to a scene
 * takes its scene's new span, any other shot moves through the time map, and
 * each shot's lyric cue ids are re-read from the new song.
 */
export function remapStoryboardShots(storyboard, { scenes, cues, map }) {
  if (!Array.isArray(storyboard)) return storyboard;
  const byId = new Map(scenes.map((s) => [s.sceneId, s]));
  return storyboard.map((shot) => {
    const scene = shot.sceneId ? byId.get(shot.sceneId) : null;
    const startSec = scene && isTime(scene.startSec) ? scene.startSec : map(shot.startSec);
    const endSec = scene && isTime(scene.endSec) ? scene.endSec : map(shot.endSec);
    if (!isTime(startSec) || !isTime(endSec)) return shot;
    return { ...shot, startSec, endSec: Math.max(startSec, endSec), lyricCueIds: cuesIn(cues, startSec, endSec).map((c) => c.id) };
  });
}
