/**
 * Storyboard vocabulary — ids, enums and caps shared by the server record
 * normalizer (storyboardRecord.js), the route schemas and the client editor.
 * Kept free of node-only imports so the client can import it directly.
 */

import {
  SHOT_ANGLES, SHOT_COMPOSITIONS, SHOT_EYELINES, SHOT_FACINGS, SHOT_FOCUSES, SHOT_LENSES, SHOT_MOVES, SHOT_TYPES,
} from './shotGrammar.js';

export const STORYBOARD_ID_PATTERN = /^sb-[A-Za-z0-9-]{1,80}$/;
export const isValidStoryboardId = (id) => typeof id === 'string' && STORYBOARD_ID_PATTERN.test(id);
// globalThis.crypto (not node:crypto) keeps this module importable by the
// client for its vocabulary; only the server ever mints ids.
export const newStoryboardId = () => `sb-${globalThis.crypto.randomUUID()}`;
export const newStoryboardEntityId = (prefix) => `${prefix}-${globalThis.crypto.randomUUID()}`;
// Saved panel maker recipes (the Make tab's library), shared across boards.
export const STORYBOARD_RECIPE_ID_PATTERN = /^sbr-[A-Za-z0-9-]{1,80}$/;
export const isValidStoryboardRecipeId = (id) => typeof id === 'string' && STORYBOARD_RECIPE_ID_PATTERN.test(id);

export const STORYBOARD_ASPECT_RATIOS = Object.freeze(['16:9', '9:16', '1:1', '4:5', '2.39:1']);
export const STORYBOARD_ART_STYLES = Object.freeze(['pencil', 'clean-line', 'grey-marker', 'production-sketch', 'color']);
export const STORYBOARD_ART_STYLE_LABELS = Object.freeze({
  pencil: 'Pencil', 'clean-line': 'Clean line', 'grey-marker': 'Grey marker', 'production-sketch': 'Production sketch', color: 'Color',
});
// Song-structure vocabulary for a beat before (or without) a song. Matches how
// a songwriter names sections, not the music-video treatment's arc roles.
export const STORYBOARD_MUSICAL_ROLES = Object.freeze([
  'intro', 'verse', 'pre-chorus', 'chorus', 'bridge', 'build', 'drop', 'breakdown', 'instrumental', 'outro',
]);
export const STORYBOARD_MUSICAL_ROLE_LABELS = Object.freeze({
  intro: 'Intro', verse: 'Verse', 'pre-chorus': 'Pre-chorus', chorus: 'Chorus', bridge: 'Bridge',
  build: 'Build', drop: 'Drop', breakdown: 'Breakdown', instrumental: 'Instrumental', outro: 'Outro',
});
export const STORYBOARD_PANEL_FRAMINGS = SHOT_TYPES;
export const STORYBOARD_PANEL_ANGLES = SHOT_ANGLES;
export const STORYBOARD_PANEL_FACINGS = SHOT_FACINGS;
export const STORYBOARD_PANEL_COMPOSITIONS = SHOT_COMPOSITIONS;
export const STORYBOARD_PANEL_MOVES = SHOT_MOVES;
export const STORYBOARD_PANEL_LENSES = SHOT_LENSES;
export const STORYBOARD_PANEL_FOCUSES = SHOT_FOCUSES;
export const STORYBOARD_PANEL_EYELINES = SHOT_EYELINES;
export const STORYBOARD_TAKE_SOURCES = Object.freeze(['upload', 'gallery', 'catalog', 'moodBoard', 'sketch', 'generated']);

export const STORYBOARD_LIMITS = Object.freeze({
  name: 120,
  logline: 500,
  beats: 200,
  panelsPerBeat: 60,
  panelsTotal: 1000,
  beatTitle: 120,
  beatText: 2000,
  emotion: 120,
  sectionHint: 120,
  panelText: 2000,
  camera: 200,
  refs: 40,
  refId: 128,
  takes: 30,
  panelSecondsMax: 600,
  notes: 4000,
  tempTrackName: 200,
  songSections: 60,
  sectionLabel: 80,
  lyricLines: 400,
  lyricLine: 300,
  markerAtMax: 7200,
});
