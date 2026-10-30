/**
 * Song brief — a storyboard's beats as a song map to write or generate the
 * song from (Suno, the Music Designer): sections in order, the target length
 * of each, its energy, mood and lyric theme. Built from the board alone, with
 * no model call, so it is the same text every time the beats are the same.
 *
 * `storyboardTimeline` is the animatic's timing, shared by Play and the
 * brief so they agree on length: a panel holds for its estimated seconds (the
 * default when unset), and a beat pinned to a song section or lyric line on
 * the temp track starts at that time, the beats before it fitted to reach it.
 * Beats marked before the song play first, and the song starts after them.
 *
 * Browser-safe: no node-only imports.
 */

import { STORYBOARD_MUSICAL_ROLE_LABELS } from './storyboardVocabulary.js';

// M:SS.ss — hundredths, like every other storyboard time.
const clock = (sec) => {
  const m = Math.floor(sec / 60);
  return `${m}:${(sec - m * 60).toFixed(2).padStart(5, '0')}`;
};

export const STORYBOARD_DEFAULT_HOLD_SEC = 3;

const panelHoldSeconds = (panel) => (panel?.seconds > 0 ? panel.seconds : STORYBOARD_DEFAULT_HOLD_SEC);


// How hard each section should hit, as a songwriter would brief it.
const ROLE_ENERGY = Object.freeze({
  intro: 'low', verse: 'medium', 'pre-chorus': 'rising', chorus: 'high', bridge: 'a change of feel',
  build: 'rising', drop: 'peak', breakdown: 'low', instrumental: 'medium', outro: 'falling',
});

/**
 * How many beats open the board before the song starts (the prelude): the
 * leading beats marked `beforeSong`. The song's own time starts after them.
 */
export function storyboardPreludeCount(board) {
  const beats = board?.beats || [];
  let count = 0;
  while (count < beats.length && beats[count].beforeSong === true) count += 1;
  return count;
}

/**
 * Every panel's start and end on the animatic clock, and each beat's span.
 *
 * Beats before the song (the prelude) play first at their holds, and the
 * song starts where they end (`songStartSec`); pins are song times, so they
 * land that much later on this clock. Pins split the rest into runs: each
 * run's panels keep their relative holds, scaled so the run fills the time up
 * to the next pin (from the song's start for the run before the first pin).
 * The run after the last pin plays at its holds. A pin earlier than the one
 * before it is ignored, so time never runs back.
 */
export function storyboardTimeline(board) {
  const beats = board?.beats || [];
  const track = board?.tempTrack;
  const markerTimes = new Map();
  for (const section of track?.sections || []) markerTimes.set(section.id, section.at);
  for (const line of track?.lines || []) if (line.at !== null) markerTimes.set(line.id, line.at);

  const panels = [];
  const spans = [];
  const prelude = storyboardPreludeCount(board);
  let songStartSec = 0;
  beats.slice(0, prelude).forEach((beat, beatIndex) => {
    const start = songStartSec;
    for (const panel of beat.panels) {
      const end = songStartSec + panelHoldSeconds(panel);
      panels.push({ panel, beat, beatIndex, number: panels.length + 1, start: songStartSec, end, beforeSong: true });
      songStartSec = end;
    }
    spans.push({ beatId: beat.id, start, end: songStartSec, pinned: false, fitted: false, beforeSong: true });
  });

  const anchors = [];
  let last = -Infinity;
  beats.forEach((beat, index) => {
    if (index < prelude) return;
    const at = markerTimes.get(beat.pin);
    if (at === undefined || at <= last) return;
    anchors.push({ index, at: songStartSec + at });
    last = at;
  });
  if (prelude < beats.length && anchors[0]?.index !== prelude) anchors.unshift({ index: prelude, at: songStartSec, implicit: true });

  anchors.forEach((anchor, runIndex) => {
    const stop = anchors[runIndex + 1];
    const runBeats = beats.slice(anchor.index, stop ? stop.index : beats.length);
    const natural = runBeats.reduce((sum, beat) => sum + beat.panels.reduce((s, panel) => s + panelHoldSeconds(panel), 0), 0);
    const fitted = !!stop && natural > 0;
    const scale = fitted ? (stop.at - anchor.at) / natural : 1;
    let t = anchor.at;
    runBeats.forEach((beat, offset) => {
      const beatIndex = anchor.index + offset;
      const start = t;
      for (const panel of beat.panels) {
        const end = t + panelHoldSeconds(panel) * scale;
        panels.push({ panel, beat, beatIndex, number: panels.length + 1, start: t, end });
        t = end;
      }
      spans.push({ beatId: beat.id, start, end: t, pinned: offset === 0 && !anchor.implicit, fitted });
    });
  });
  return { panels, beats: spans, end: panels.at(-1)?.end || 0, songStartSec };
}

/**
 * The song map: one section per beat (beats with no panels still count, at
 * zero length), on song time; beats before the song are not part of it.
 * `estimated` marks a section where some panel had no seconds and held for
 * the default.
 */
export function storyboardSongSections(board) {
  const { beats: spans, songStartSec } = storyboardTimeline(board);
  const prelude = storyboardPreludeCount(board);
  return (board?.beats || []).slice(prelude).map((beat, offset) => {
    const index = prelude + offset;
    const span = spans[index];
    const seconds = span.end - span.start;
    const lines = beat.panels.map((panel) => panel.dialogue.trim()).filter(Boolean);
    return {
      beatId: beat.id,
      label: STORYBOARD_MUSICAL_ROLE_LABELS[beat.musicalRole] || `Section ${offset + 1}`,
      tag: STORYBOARD_MUSICAL_ROLE_LABELS[beat.musicalRole] || null,
      title: beat.title,
      seconds: Math.round(seconds * 100) / 100,
      start: span.start - songStartSec,
      pinned: span.pinned,
      estimated: !span.fitted && beat.panels.some((panel) => !(panel.seconds > 0)),
      energy: ROLE_ENERGY[beat.musicalRole] || null,
      mood: beat.emotion,
      theme: beat.what || beat.title,
      sectionHint: beat.sectionHint,
      lines,
    };
  });
}

/** The brief as plain text to paste into a song tool. */
export function storyboardSongBriefText(board) {
  const sections = storyboardSongSections(board);
  const total = sections.reduce((sum, section) => sum + section.seconds, 0);
  const out = [`Song brief: ${board.name}`];
  if (board.logline) out.push(`Story: ${board.logline}`);
  out.push(`Length: about ${clock(total)} across ${sections.length} section${sections.length === 1 ? '' : 's'}`);
  const tags = sections.map((section) => section.tag).filter(Boolean);
  if (tags.length) out.push(`Structure: ${tags.map((tag) => `[${tag}]`).join(' ')}`);
  sections.forEach((section, index) => {
    const head = [`${index + 1}. ${section.label}`, clock(section.seconds)];
    if (section.pinned) head.push(`starts at ${clock(section.start)}`);
    if (section.energy) head.push(`${section.energy} energy`);
    out.push('', head.join(', '));
    if (section.title && section.title !== section.theme) out.push(`   Beat: ${section.title}`);
    if (section.mood) out.push(`   Mood: ${section.mood}`);
    if (section.theme) out.push(`   Lyric theme: ${section.theme}`);
    if (section.sectionHint) out.push(`   Note: ${section.sectionHint}`);
    if (section.lines.length) out.push(`   Lines: ${section.lines.join(' / ')}`);
  });
  return out.join('\n');
}
