/**
 * Storyboard ↔ shots sync — a music video's shots kept 1:1 with its linked
 * storyboard's panels. Shared by the Storyboard step (each panel's time and
 * sung lyric, and the sync preview, in the browser) and the write (on the
 * server), so the shots written are the ones previewed.
 *
 * Timing: a panel's `seconds` is its exact length. The song's panels play end
 * to end from the song's start (pins and the proportional Fit to song do not
 * apply), and the last one runs to the song's end when the board is within a
 * second of it. Panels in the beats before the song become the shots before
 * it (`preMusic`) at their own lengths. A panel with no length holds the
 * default.
 *
 * Linking: each panel keeps one shot (`scene.panelId`). A shot already linked
 * to a panel follows it; on the first sync a shot not linked yet links to the
 * panel over the same span (or one overlapping most of it), keeping its words,
 * frames and clips as they are. A panel with no shot gets a new one, and a
 * shot whose panel is gone (or that no panel took) is removed.
 *
 * What a sync changes on a linked shot: its span, place, label, section and
 * sung lyric always; its words and frame reference (the panel's action and
 * art) only when the panel changed since the shot last took them, and only on
 * a shot whose still is not locked (a locked one waits for Update, as after
 * Fit to song). Everything the shot owns (prompts, takes, transitions,
 * effects, film look, mode) is kept. A shot whose video is locked never
 * moves, and a locked shot is removed only when asked (`removeLocked`).
 *
 * Browser-safe: no node-only imports.
 */

import { sungLyricTextWithin } from './musicVideoLyricAnchors.js';
import { coldOpenPlan, isPreMusicShot } from './musicVideoColdOpen.js';
import { storyboardPreludeShotSec, storyboardPanelArt, storyboardPanelRev } from './storyboardFit.js';
import { STORYBOARD_DEFAULT_HOLD_SEC, storyboardPreludeCount } from './storyboardSongBrief.js';
import { STORYBOARD_MUSICAL_ROLE_LABELS } from './storyboardVocabulary.js';

// A board this close to the song's end runs its last panel to the end.
export const STORYBOARD_SYNC_END_SLACK_SEC = 1;
// An unlinked shot links to a panel covering at least this share of the longer of the two.
const OVERLAP_LINK_SHARE = 0.8;
const SAME_SEC = 0.005;
const LABEL_MAX = 120;
const TEXT_MAX = 2000;

const round = (t) => Math.round(t * 100) / 100;
const clip = (text, max) => String(text || '').trim().slice(0, max);
const holdSeconds = (panel) => (panel?.seconds > 0 ? panel.seconds : STORYBOARD_DEFAULT_HOLD_SEC);
const same = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < SAME_SEC;

/** Which song section a time falls in (the last one starting at or before it). */
function sectionAt(sections, at) {
  let index = null;
  (sections || []).forEach((section, i) => { if (section.startSec <= at + 0.01) index = i; });
  return index === null && sections?.length ? 0 : index;
}

/**
 * Every panel's place: `{ panelId, beatId, beatTitle, label, beforeSong, startSec, endSec,
 * durationSec, estimated, lyricText, sectionIndex, sectionLabel, pastSong }` in board order,
 * plus the song panels' `totalSec`, `overrunSec` (how far they run past the song) and
 * `gapSec` (how much of the song's end no panel covers). `song` is storyboardFitSong's;
 * without it the panels are timed from 0 with no lyric or section.
 */
export function storyboardPanelSpans(board, song = null) {
  const beats = board?.beats || [];
  const prelude = storyboardPreludeCount(board);
  const songEnd = song?.durationSec > 0 ? song.durationSec : null;
  const cues = song?.lyricCues || [];
  const panels = [];
  let at = 0;
  beats.forEach((beat, beatIndex) => {
    const title = clip(beat.title || STORYBOARD_MUSICAL_ROLE_LABELS[beat.musicalRole] || `Beat ${beatIndex + 1}`, LABEL_MAX);
    beat.panels.forEach((panel, p) => {
      const suffix = beat.panels.length > 1 ? ` · ${p + 1}/${beat.panels.length}` : '';
      const base = {
        panelId: panel.id, beatId: beat.id, beatTitle: title, label: `${title.slice(0, LABEL_MAX - suffix.length)}${suffix}`,
        estimated: !(panel.seconds > 0),
      };
      if (beatIndex < prelude) {
        panels.push({ ...base, beforeSong: true, startSec: null, endSec: null, durationSec: storyboardPreludeShotSec(panel),
          lyricText: null, sectionIndex: null, sectionLabel: null, pastSong: false });
        return;
      }
      const startSec = round(at);
      at += holdSeconds(panel);
      panels.push({ ...base, beforeSong: false, startSec, endSec: round(at), durationSec: null });
    });
  });
  const songPanels = panels.filter((span) => !span.beforeSong);
  const totalSec = round(at);
  let overrunSec = 0;
  let gapSec = 0;
  if (songEnd && songPanels.length) {
    const last = songPanels.at(-1);
    // Snap only when the last panel still starts before the song ends; otherwise it is an overrun.
    if (Math.abs(songEnd - last.endSec) <= STORYBOARD_SYNC_END_SLACK_SEC && songEnd > last.startSec + SAME_SEC) last.endSec = songEnd;
    else if (last.endSec < songEnd) gapSec = round(songEnd - last.endSec);
    else overrunSec = round(last.endSec - songEnd);
  }
  for (const span of songPanels) {
    span.durationSec = round(span.endSec - span.startSec);
    span.pastSong = !!songEnd && span.endSec > songEnd + SAME_SEC;
    span.lyricText = cues.length ? sungLyricTextWithin(cues, span.startSec, span.endSec) : null;
    span.sectionIndex = song ? sectionAt(song.sections, span.startSec) : null;
    // The beat is the planned section; the song section only places it.
    span.sectionLabel = span.beatTitle;
  }
  return { panels, totalSec, overrunSec, gapSec, songSec: songEnd };
}

const STILL_HELD = new Set(['locked', 'changed']);

/**
 * The sync: what each panel's shot becomes, and which shots go. `locks` and
 * `clipLocks` are the video's still and clip locks by shot id (productionReview
 * shotLocks / clipLocks). Returns `{ problem, shots, removed, counts, inSync,
 * spans }`. Each of `shots` is `{ panelId, sceneId (null for a new shot), link
 * ('panel' | 'span' | 'overlap' | 'new'), retimed, moved, content, held, blocked,
 * patch | input }`: `patch` is what changes on the existing shot, `input` the
 * new shot's fields. `removed` lists `{ sceneId, label, locked, videoLocked, blocked }`.
 */
export function storyboardShotSyncPlan(board, project, { song = null, locks = null, clipLocks = null, removeLocked = false } = {}) {
  const spans = storyboardPanelSpans(board, song);
  const empty = { shots: [], removed: [], counts: { linked: 0, retimed: 0, updated: 0, held: 0, added: 0, removed: 0, blocked: 0 }, inSync: true, spans };
  if (!song) return { ...empty, problem: 'Analyze the song first; the panels are timed on it.' };
  if (!spans.panels.length) return { ...empty, problem: 'The storyboard has no panels yet.' };
  if (spans.overrunSec > 0) {
    return { ...empty, problem: `The panels run ${spans.overrunSec.toFixed(2)} s past the end of the song; shorten them first.` };
  }
  const scenes = [...(project?.scenes || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const panelById = new Map(board.beats.flatMap((beat) => beat.panels.map((panel) => [panel.id, panel])));
  const stillOf = (scene) => locks?.[scene.sceneId] || 'open';
  const clipLocked = (scene) => clipLocks?.[scene.sceneId] === 'locked';

  const claimed = new Set();
  const linkedTo = new Map();
  for (const scene of scenes) {
    if (scene.panelId && panelById.has(scene.panelId) && !linkedTo.has(scene.panelId)) {
      linkedTo.set(scene.panelId, scene);
      claimed.add(scene.sceneId);
    }
  }
  // Shots no panel holds yet, which a panel over the same time may take.
  const unlinked = scenes.filter((scene) => !scene.panelId);
  const takeUnlinked = (span) => {
    const pool = unlinked.filter((scene) => !claimed.has(scene.sceneId) && isPreMusicShot(scene) === span.beforeSong);
    if (span.beforeSong) return pool[0] ? { scene: pool[0], link: 'span' } : null;
    const exact = pool.find((scene) => same(scene.startSec, span.startSec) && same(scene.endSec, span.endSec));
    if (exact) return { scene: exact, link: 'span' };
    let best = null;
    for (const scene of pool) {
      if (!Number.isFinite(scene.startSec) || !Number.isFinite(scene.endSec)) continue;
      const overlap = Math.min(scene.endSec, span.endSec) - Math.max(scene.startSec, span.startSec);
      const longer = Math.max(scene.endSec - scene.startSec, span.endSec - span.startSec);
      if (longer > 0 && overlap / longer >= OVERLAP_LINK_SHARE && (!best || overlap > best.overlap)) best = { scene, overlap };
    }
    return best ? { scene: best.scene, link: 'overlap' } : null;
  };

  // Where each cold-open shot plays now, and where its panel would put it: a reorder
  // or a longer shot ahead moves it without changing its own length.
  const coldOpenAt = new Map(coldOpenPlan(project || {}).map(({ scene, startSec }) => [scene.sceneId, startSec]));
  const preludeAt = new Map();
  let preludeClock = 0;
  for (const span of spans.panels) {
    if (!span.beforeSong) continue;
    preludeAt.set(span.panelId, round(preludeClock));
    preludeClock += span.durationSec;
  }
  const counts = { ...empty.counts };
  let lockedColdOpenMoves = false;
  const shots = spans.panels.map((span, order) => {
    const panel = panelById.get(span.panelId);
    const rev = storyboardPanelRev(panel);
    const art = storyboardPanelArt(panel);
    const timing = span.beforeSong
      ? { preMusic: { durationSec: span.durationSec } }
      : { startSec: span.startSec, endSec: span.endSec, lyricText: span.lyricText };
    const placing = { label: span.label, sectionIndex: span.sectionIndex, sectionLabel: span.sectionLabel, ...timing };
    const found = linkedTo.has(span.panelId) ? { scene: linkedTo.get(span.panelId), link: 'panel' } : takeUnlinked(span);
    if (!found) {
      counts.added += 1;
      return {
        panelId: span.panelId, sceneId: null, link: 'new', retimed: false, moved: false, content: true, held: false, blocked: null,
        input: { ...placing, loop: false, visualIntent: clip(panel.action, TEXT_MAX) || null, panelId: panel.id, panelRev: rev, panelArt: art },
      };
    }
    const { scene, link } = found;
    claimed.add(scene.sceneId);
    counts.linked += 1;
    const retimed = span.beforeSong
      ? !same(scene.preMusic?.durationSec, span.durationSec) || !same(coldOpenAt.get(scene.sceneId), preludeAt.get(span.panelId))
      : !same(scene.startSec, span.startSec) || !same(scene.endSec, span.endSec);
    const blocked = retimed && clipLocked(scene) ? 'Its video is locked; unlock the video to move it.' : null;
    if (blocked && span.beforeSong && !same(coldOpenAt.get(scene.sceneId), preludeAt.get(span.panelId))) lockedColdOpenMoves = true;
    // The first link keeps the shot's own words and frames as the panel's.
    const changed = link === 'panel' && (rev !== scene.panelRev || art !== (scene.panelArt ?? null));
    const held = changed && STILL_HELD.has(stillOf(scene));
    const content = changed && !held;
    const patch = {
      ...(blocked ? {} : placing),
      ...(link !== 'panel' ? { panelId: panel.id, panelRev: rev, panelArt: art } : {}),
      ...(content ? { visualIntent: clip(panel.action, TEXT_MAX) || null, panelRev: rev, panelArt: art } : {}),
    };
    if (span.beforeSong && !blocked) patch.preMusic = { ...scene.preMusic, durationSec: span.durationSec };
    // A cold-open shot whose panel moved onto the song stops being a cold-open shot.
    else if (!span.beforeSong && !blocked && isPreMusicShot(scene)) patch.preMusic = null;
    const delta = Object.fromEntries(Object.entries(patch).filter(([key, value]) => JSON.stringify(scene[key] ?? null) !== JSON.stringify(value ?? null)));
    const moved = (scene.order ?? 0) !== order;
    if (retimed && !blocked) counts.retimed += 1;
    if (content) counts.updated += 1;
    if (held) counts.held += 1;
    if (blocked) counts.blocked += 1;
    return { panelId: span.panelId, sceneId: scene.sceneId, link, retimed: retimed && !blocked, moved, content, held, blocked, patch: delta };
  });

  // The cold open plays in shot order, so a locked shot cannot keep its place while others move around it.
  if (lockedColdOpenMoves) {
    return { ...empty, problem: 'A shot before the song has a locked video and would move; unlock its video to reorder the cold open.' };
  }
  const removed = scenes.filter((scene) => !claimed.has(scene.sceneId)).map((scene) => {
    const videoLocked = clipLocked(scene);
    const locked = STILL_HELD.has(stillOf(scene)) || videoLocked;
    const blocked = videoLocked ? 'Its video is locked; unlock the video to remove it.'
      : locked && !removeLocked ? 'It is locked; unlock it, or remove locked shots too.' : null;
    if (blocked) counts.blocked += 1;
    else counts.removed += 1;
    return { sceneId: scene.sceneId, label: scene.label || '', locked, videoLocked, blocked };
  });
  const inSync = !shots.some((shot) => !shot.sceneId || shot.moved || (shot.patch && Object.keys(shot.patch).length))
    && !removed.some((shot) => !shot.blocked);
  return { problem: null, shots, removed, counts, inSync, spans };
}
