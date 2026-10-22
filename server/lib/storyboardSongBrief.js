/**
 * Song brief — a storyboard's beats as a song map to write or generate the
 * song from (Suno, the Music Designer): sections in order, the target length
 * of each, its energy, mood and lyric theme. Built from the board alone, with
 * no model call, so it is the same text every time the beats are the same.
 *
 * `panelHoldSeconds` is also the animatic's timing: a panel with no estimated
 * seconds holds for the default, so Play and the brief agree on length.
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

export const panelHoldSeconds = (panel) => (panel?.seconds > 0 ? panel.seconds : STORYBOARD_DEFAULT_HOLD_SEC);


// How hard each section should hit, as a songwriter would brief it.
const ROLE_ENERGY = Object.freeze({
  intro: 'low', verse: 'medium', 'pre-chorus': 'rising', chorus: 'high', bridge: 'a change of feel',
  build: 'rising', drop: 'peak', breakdown: 'low', instrumental: 'medium', outro: 'falling',
});

/**
 * The song map: one section per beat (beats with no panels still count, at
 * zero length). `estimated` marks a section where some panel had no seconds
 * and held for the default.
 */
export function storyboardSongSections(board) {
  return (board?.beats || []).map((beat, index) => {
    const seconds = beat.panels.reduce((sum, panel) => sum + panelHoldSeconds(panel), 0);
    const lines = beat.panels.map((panel) => panel.dialogue.trim()).filter(Boolean);
    return {
      beatId: beat.id,
      label: STORYBOARD_MUSICAL_ROLE_LABELS[beat.musicalRole] || `Section ${index + 1}`,
      tag: STORYBOARD_MUSICAL_ROLE_LABELS[beat.musicalRole] || null,
      title: beat.title,
      seconds: Math.round(seconds * 100) / 100,
      estimated: beat.panels.some((panel) => !(panel.seconds > 0)),
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
