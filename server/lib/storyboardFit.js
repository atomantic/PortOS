/**
 * Fit to song — places a storyboard's beats on a music video's analyzed song
 * and turns each panel into a shot. Shared by the Plan step's preview (in the
 * browser) and the write (on the server), so the shots written are the ones
 * previewed.
 *
 * Each beat keeps its share of the board's length (a panel's estimated
 * seconds, or the default hold), stretched over the whole song. A beat's start
 * then snaps to the nearest section start (one matching its musical role
 * first), else a sung line, else a downbeat, when one is close. A start the
 * director picked wins. Panels split their beat in proportion to their holds,
 * cuts on the beat grid. A beat with no panels still gets one shot from its
 * own words, so no beat is dropped; shots under the minimum length are named.
 * Beats marked before the song stay off it: each of their panels becomes a
 * shot before the song (`preMusic`) at its own hold, and the rest fill the song.
 *
 * Browser-safe: no node-only imports.
 */

import { lyricSectionSpans } from './lyricSectionSpans.js';
import { PRE_MUSIC_DURATION_RANGE } from './musicVideoColdOpen.js';
import { STORYBOARD_DEFAULT_HOLD_SEC, storyboardPreludeCount } from './storyboardSongBrief.js';
import { newStoryboardEntityId, STORYBOARD_MUSICAL_ROLE_LABELS } from './storyboardVocabulary.js';

export const STORYBOARD_FIT_MIN_SHOT_SEC = 2;

const LABEL_MAX = 120;
const TEXT_MAX = 2000;
const CUT_SNAP_SEC = 0.3;
const OPTIONS_MAX = 12;

const round = (t) => Math.round(t * 100) / 100;
const clip = (text, max) => String(text || '').trim().slice(0, max);
const holdSeconds = (panel) => (panel?.seconds > 0 ? panel.seconds : STORYBOARD_DEFAULT_HOLD_SEC);
const nearest = (list, at, within) => list.reduce((best, item) => {
  const gap = Math.abs(item.at - at);
  return gap <= within && (!best || gap < Math.abs(best.at - at)) ? item : best;
}, null);

// A gap shorter than this before the first sung section (or after the last)
// stays part of it rather than becoming its own Intro / Outro.
const LYRIC_EDGE_MIN_SEC = 1;

/**
 * The song's sections as the lyric sheet names and times them: one per
 * `[Verse]`/`[Chorus]` marker with a timed line, plus Intro / Outro for the
 * unsung stretches at either end. Null when the sheet has no timed sections,
 * so the audio analysis's own sections are used.
 */
function lyricSheetSections(project, end) {
  const spans = lyricSectionSpans(project?.lyricCues, project?.lyricMarkers)
    .map((span) => ({ label: span.label, startSec: Math.max(0, span.startSec), endSec: Math.min(end, span.endSec) }))
    .filter((span) => span.endSec > span.startSec);
  if (!spans.length) return null;
  if (spans[0].startSec < LYRIC_EDGE_MIN_SEC) spans[0].startSec = 0;
  else spans.unshift({ label: 'Intro', startSec: 0, endSec: spans[0].startSec });
  const last = spans.at(-1);
  if (end - last.endSec < LYRIC_EDGE_MIN_SEC) last.endSec = end;
  else spans.push({ label: 'Outro', startSec: last.endSec, endSec: end });
  return spans;
}

/**
 * The song a fit lands on, from a music video's analysis and timed lyric cues;
 * null before analysis. Sections follow the lyric sheet when it marks and times
 * them (the analysis's detected boundaries rarely match the written song),
 * else the analysis's.
 */
export function storyboardFitSong(project) {
  const analysis = project?.audioAnalysis;
  const detected = (analysis?.sections || []).filter((s) => Number.isFinite(s.startSec) && Number.isFinite(s.endSec));
  const end = Number.isFinite(analysis?.durationSec) && analysis.durationSec > 0 ? analysis.durationSec : detected.at(-1)?.endSec;
  if (!(end > 0)) return null;
  return {
    durationSec: end,
    sections: lyricSheetSections(project, end) || detected,
    downbeats: (analysis.downbeats || []).filter(Number.isFinite),
    beats: (analysis.beats || []).filter(Number.isFinite),
    lyricCues: (project.lyricCues || []).filter((cue) => Number.isFinite(cue?.startSec) && cue.text),
  };
}

/** Which analyzed section a time falls in (the last one starting at or before it). */
function sectionAt(sections, at) {
  let index = -1;
  sections.forEach((section, i) => { if (section.startSec <= at + 0.01) index = i; });
  return index < 0 ? (sections.length ? 0 : null) : index;
}

// What a shot drew from its panel; a later change to any of it marks the shot's panel changed.
const PANEL_REV_FIELDS = ['action', 'dialogue', 'framing', 'camera', 'castIds', 'environmentIds', 'objectIds'];
export function storyboardPanelRev(panel) {
  return storyboardRev(PANEL_REV_FIELDS.map((key) => panel[key] ?? null));
}

/** A short FNV-1a hash of JSON-able values, for telling whether copied fields changed. */
export function storyboardRev(values) {
  const text = JSON.stringify(values);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(36);
}

/**
 * A fitted shot's panel on the linked board: `current`, `changed` (edited
 * since the fit or the last Update) or `missing` (deleted, or another board
 * linked), with the panel, its beat and its number on the board. Null for a
 * shot not fitted from a panel.
 */
export function storyboardShotPanel(board, scene) {
  if (!scene?.panelId) return null;
  let number = 0;
  for (const [beatIndex, beat] of (board?.beats || []).entries()) {
    for (const panel of beat.panels) {
      number += 1;
      if (panel.id === scene.panelId) {
        const artChanged = storyboardPanelArt(panel) !== (scene.panelArt ?? null);
        const changed = artChanged || storyboardPanelRev(panel) !== scene.panelRev;
        return { state: changed ? 'changed' : 'current', artChanged, panel, beat, beatIndex, number };
      }
    }
  }
  return { state: 'missing', artChanged: false, panel: null, beat: null, beatIndex: null, number: null };
}

/**
 * A panel's selected art as a gallery image, the shot's frame reference (a
 * composition guide, never its start frame). A sketch take has no gallery file
 * and gives none.
 */
export function storyboardPanelArt(panel) {
  return panel?.takes?.find((take) => take.id === panel.selectedTakeId)?.image || null;
}

const roleMatches = (role, label) => {
  const name = STORYBOARD_MUSICAL_ROLE_LABELS[role];
  return !!name && String(label || '').toLowerCase().startsWith(name.toLowerCase());
};

// A panel before the song keeps its hold as its length, inside what a shot before the song allows.
const preludeSec = (panel) => round(Math.min(PRE_MUSIC_DURATION_RANGE.max, Math.max(PRE_MUSIC_DURATION_RANGE.min, holdSeconds(panel))));

/** The beats before the song: one shot before the song per panel, at its hold. */
function fitPrelude(beats) {
  const fitBeats = [];
  const shots = [];
  beats.forEach((beat, i) => {
    const title = clip(beat.title || STORYBOARD_MUSICAL_ROLE_LABELS[beat.musicalRole] || `Beat ${i + 1}`, LABEL_MAX);
    const panels = beat.panels.length ? beat.panels : [null];
    let durationSec = 0;
    panels.forEach((panel, p) => {
      const suffix = panels.length > 1 ? ` · ${p + 1}/${panels.length}` : '';
      const length = preludeSec(panel);
      durationSec += length;
      shots.push({
        beatId: beat.id,
        panelId: panel?.id || null,
        panelRev: panel ? storyboardPanelRev(panel) : null,
        panelArt: storyboardPanelArt(panel),
        label: `${title.slice(0, LABEL_MAX - suffix.length)}${suffix}`,
        sectionIndex: null,
        sectionLabel: null,
        preMusic: { durationSec: length },
        visualIntent: clip(panel ? panel.action : beat.what || beat.title, TEXT_MAX) || null,
      });
    });
    fitBeats.push({ beatId: beat.id, title, beforeSong: true, durationSec: round(durationSec), shots: panels.length, short: 0, noPanels: !beat.panels.length });
  });
  return { beats: fitBeats, shots };
}

/**
 * The fit: `beats` (each beat's place, section and length change, with the
 * starts the director can pick from; a beat before the song has
 * `beforeSong` and its `durationSec` instead) and `shots` (scene inputs in
 * play order, each carrying its `beatId` and `panelId`; the ones before the
 * song carry `preMusic` and no song time). `starts` maps a beat id to a
 * picked start time; a pick that would run time backwards is ignored.
 */
export function fitStoryboardToSong(board, song, options = {}) {
  if (!song || !board?.beats?.length) return { beats: [], shots: [] };
  const prelude = storyboardPreludeCount(board);
  const opening = fitPrelude(board.beats.slice(0, prelude));
  const fitted = fitSongBeats(board.beats.slice(prelude), song, options);
  return { beats: [...opening.beats, ...fitted.beats], shots: [...opening.shots, ...fitted.shots] };
}

function fitSongBeats(beats, song, { starts = {}, minShotSec = STORYBOARD_FIT_MIN_SHOT_SEC } = {}) {
  if (!beats.length) return { beats: [], shots: [] };
  const songEnd = song.durationSec;
  const holds = beats.map((beat) => (beat.panels.length ? beat.panels.reduce((sum, panel) => sum + holdSeconds(panel), 0) : STORYBOARD_DEFAULT_HOLD_SEC));
  const total = holds.reduce((sum, hold) => sum + hold, 0);
  const scale = songEnd / total;
  const mapped = [];
  holds.reduce((at, hold) => { mapped.push(at * scale); return at + hold; }, 0);

  const sectionMarks = song.sections.map((section, index) => ({ at: section.startSec, kind: 'section', label: section.label, index }));
  const lyricMarks = song.lyricCues.map((cue) => ({ at: cue.startSec, kind: 'lyric', label: clip(cue.text, 80) }));
  const downbeatMarks = song.downbeats.map((at) => ({ at, kind: 'downbeat', label: null }));
  // Reserve the requested minimum only when the song can hold it. Short songs
  // still fit every panel; their short-shot warnings use the requested minimum.
  const shotCount = beats.map((beat) => Math.max(1, beat.panels.length));
  const totalShots = shotCount.reduce((sum, n) => sum + n, 0);
  const availableShotSec = songEnd / totalShots;
  // Keep enough ticks per shot that rounding cannot consume a tiny song.
  const precision = 10 ** Math.max(2, Math.ceil(-Math.log10(availableShotSec)) + 1);
  const roundTime = (t) => Math.round(t * precision) / precision;
  const tick = 1 / precision;
  const reservedMinSec = Math.floor(Math.min(minShotSec, availableShotSec) * precision) / precision;
  const after = shotCount.map((_, i) => shotCount.slice(i).reduce((sum, n) => sum + n, 0) * reservedMinSec);

  const placed = [];
  beats.forEach((beat, i) => {
    const raw = mapped[i];
    const share = holds[i] * scale;
    const low = i === 0 ? 0 : roundTime(placed[i - 1].start + shotCount[i - 1] * reservedMinSec);
    const high = Math.max(low, Math.floor((songEnd - after[i]) * precision) / precision);
    const fits = (at) => at >= low && at <= high;
    const window = Math.max(1.5, Math.min(6, share * 0.35));
    const prevShare = i > 0 ? holds[i - 1] * scale : share;
    const options = i === 0 ? [] : [...sectionMarks, ...lyricMarks]
      .filter((mark) => mark.at > raw - prevShare && mark.at < raw + share && fits(mark.at))
      .sort((a, b) => Math.abs(a.at - raw) - Math.abs(b.at - raw)).slice(0, OPTIONS_MAX)
      .sort((a, b) => a.at - b.at)
      .map(({ at, kind, label }) => ({ at: roundTime(at), kind, label }));

    let start;
    let snap;
    const picked = starts[beat.id];
    if (i === 0) {
      start = 0;
      snap = 'start';
    } else if (Number.isFinite(picked) && fits(picked)) {
      start = picked;
      snap = 'picked';
    } else {
      const inRange = (marks) => marks.filter((mark) => fits(mark.at));
      const sections = inRange(sectionMarks);
      const found = nearest(sections.filter((mark) => roleMatches(beat.musicalRole, mark.label)), raw, window * 1.5)
        || nearest(sections, raw, window)
        || nearest(inRange(lyricMarks), raw, Math.min(window, 2))
        || nearest(inRange(downbeatMarks), raw, 1);
      start = found ? found.at : Math.min(Math.max(raw, low), high);
      snap = found ? found.kind : null;
    }
    placed.push({ start: Math.min(high, Math.max(low, roundTime(start))), snap, options });
  });

  const cutGrid = song.beats.length ? song.beats : song.downbeats;
  const fitBeats = [];
  const shots = [];
  beats.forEach((beat, i) => {
    const start = placed[i].start;
    const end = i + 1 < beats.length ? placed[i + 1].start : songEnd;
    const sectionIndex = sectionAt(song.sections, start);
    const sectionLabel = sectionIndex === null ? null : song.sections[sectionIndex].label;
    const title = clip(beat.title || STORYBOARD_MUSICAL_ROLE_LABELS[beat.musicalRole] || `Beat ${i + 1}`, LABEL_MAX);
    const panels = beat.panels.length ? beat.panels : [null];
    const weights = panels.map((panel) => holdSeconds(panel));
    const weightTotal = weights.reduce((sum, w) => sum + w, 0);
    const cuts = [start];
    weights.slice(0, -1).reduce((acc, w, p) => {
      const next = acc + w;
      const at = start + (end - start) * (next / weightTotal);
      const snapped = nearest(cutGrid.map((t) => ({ at: t })), at, CUT_SNAP_SEC)?.at;
      const floor = cuts.at(-1) + 0.5;
      const cut = roundTime(snapped !== undefined && snapped > floor && snapped < end - 0.5 ? snapped : at);
      // A snap may pass the next proportional cut; leave at least one tick
      // for every remaining panel, including when its hold is very small.
      const low = roundTime(cuts.at(-1) + tick);
      const high = roundTime(end - (panels.length - p - 1) * tick);
      cuts.push(Math.min(high, Math.max(low, cut)));
      return next;
    }, 0);
    cuts.push(end);
    let short = 0;
    panels.forEach((panel, p) => {
      const startSec = cuts[p];
      const endSec = cuts[p + 1];
      if (endSec - startSec < minShotSec - 0.001) short += 1;
      const suffix = panels.length > 1 ? ` · ${p + 1}/${panels.length}` : '';
      shots.push({
        beatId: beat.id,
        panelId: panel?.id || null,
        panelRev: panel ? storyboardPanelRev(panel) : null,
        panelArt: storyboardPanelArt(panel),
        label: `${title.slice(0, LABEL_MAX - suffix.length)}${suffix}`,
        sectionIndex,
        sectionLabel,
        startSec,
        endSec,
        visualIntent: clip(panel ? panel.action : beat.what || beat.title, TEXT_MAX) || null,
      });
    });
    fitBeats.push({
      beatId: beat.id,
      title,
      startSec: start,
      endSec: end,
      boardSec: round(holds[i]),
      songSec: round(end - start),
      sectionLabel,
      snap: placed[i].snap,
      options: placed[i].options,
      shots: panels.length,
      short,
      noPanels: !beat.panels.length,
    });
  });
  return { beats: fitBeats, shots };
}

// A song-section name's musical role ("Verse 2" → verse); null when none fits.
const ROLE_PATTERNS = [
  ['pre-chorus', /^pre[\s-]?chorus\b/i], ['chorus', /\bchorus\b|^hook\b|^refrain\b/i], ['verse', /^verse\b/i],
  ['bridge', /^(?:middle\s+(?:8|eight)|bridge)\b/i], ['intro', /^intro\b/i], ['outro', /^(?:outro|ending)\b/i],
  ['breakdown', /^breakdown\b/i], ['drop', /^(?:beat\s+)?drop\b/i], ['build', /^build\b/i],
  ['instrumental', /^(?:instrumental|interlude|(?:guitar\s+|piano\s+)?solo)\b/i],
];
export const sectionMusicalRole = (label) => ROLE_PATTERNS.find(([, pattern]) => pattern.test(String(label || '').trim()))?.[0] || null;

/**
 * The board's panels regrouped into one beat per song section, in song order:
 * consecutive analyzed sections with the same name are one section, and each
 * panel goes where its fitted shot starts. A panel with no shot follows the
 * panel before it (the first section when it leads). Each new beat is named
 * after its section and keeps the story fields (and, the first time, the id)
 * of the old beat most of its panels came from. Panels keep their ids and
 * order. Null without sections.
 */
export function songSectionBeats(board, project) {
  const song = storyboardFitSong(project);
  const raw = song?.sections || [];
  if (!raw.length) return null;
  const sections = [];
  for (const section of raw) {
    const last = sections.at(-1);
    if (last && last.label === section.label) last.endSec = section.endSec;
    else sections.push({ label: section.label, startSec: section.startSec, endSec: section.endSec });
  }
  const startOf = new Map((project.scenes || []).filter((scene) => scene.panelId && Number.isFinite(scene.startSec))
    .map((scene) => [scene.panelId, scene.startSec]));
  const groups = sections.map(() => []);
  let current = 0;
  for (const beat of board.beats) {
    for (const panel of beat.panels) {
      if (startOf.has(panel.id)) current = sectionAt(sections, startOf.get(panel.id)) ?? 0;
      groups[current].push({ panel, beat });
    }
  }
  const usedIds = new Set();
  return groups.flatMap((group, index) => {
    if (!group.length) return [];
    const counts = new Map();
    for (const { beat } of group) counts.set(beat, (counts.get(beat) || 0) + 1);
    const source = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const label = sections[index].label || `Section ${index + 1}`;
    const id = usedIds.has(source.id) ? newStoryboardEntityId('beat') : source.id;
    usedIds.add(id);
    return [{
      ...source,
      id,
      title: label,
      musicalRole: sectionMusicalRole(label) || source.musicalRole || null,
      sectionHint: label,
      pin: null,
      panels: group.map(({ panel }) => panel),
    }];
  });
}
