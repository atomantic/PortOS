/**
 * Server-side mirror of the a cappella song-craft vocabulary.
 *
 * The full reference data (BPM bands, counts, learning steps, notation help,
 * solfège) lives client-side in `client/src/lib/songCraft.js` and is rendered
 * by the Songs Guide. The server only needs the *vocabulary* — the rhythm-shape
 * and voice-layer ids/labels/roles — so it can inject them into the AI
 * generate/evaluate prompts and the model returns ids the editor pickers already
 * understand. Kept as a deliberate, small mirror (not a shared import: client
 * and server are separate packages) — `server/services/songs.js` already
 * documents this mirror relationship for the sanitizer's id vocabulary.
 *
 * Pure data, no imports. If you add/rename a shape or layer id here, mirror it
 * in `client/src/lib/songCraft.js` (and vice versa) so generated ids resolve in
 * the UI. Unknown ids are tolerated downstream (free-text fallback), so a brief
 * drift can't 400 — but it costs picker resolution until reconciled.
 */

// Rhythm shapes: { id, label, dirge, feel }. `dirge` marks the slow/lament
// family the workbench is built around. Mirrors RHYTHM_SHAPES in songCraft.js.
export const RHYTHM_SHAPES = [
  { id: 'slow-4-4', label: 'Slow 4/4 ballad', dirge: true, feel: 'Four even beats per bar, weight on 1 and 3.' },
  { id: 'dirge-6-8', label: 'Compound 6/8 dirge', dirge: true, feel: 'Two slow pulses per bar, each split into three — a swaying funeral-march lilt.' },
  { id: 'rubato-free', label: 'Rubato / free-time lament', dirge: true, feel: 'Pulse stretches and contracts with the phrase; the lead breathes, the layers follow.' },
  { id: 'cut-time-march', label: 'Cut-time processional', dirge: true, feel: 'Two broad pulses per bar — a walking, processional tread.' },
  { id: 'driving-4-4', label: 'Driving 4/4 (uptempo)', dirge: false, feel: 'Steady, energetic four — backbeat emphasis on 2 and 4.' },
  { id: 'waltz-3-4', label: 'Waltz 3/4', dirge: false, feel: 'Three beats per bar, strong downbeat then two lighter beats.' },
];

// Voice layers in foundation-first build order: { id, label, voices, role }.
// SAME vocabulary as HARMONY_PARTS (ids + labels match) so recording "take types"
// stay in step with the parts the derive tool generates. Mirrors VOICE_LAYERS in
// songCraft.js.
export const VOICE_LAYERS = [
  { id: 'melody', label: 'Melody', voices: 'Any — the tune everyone knows', role: 'The lead — the song itself. Everyone learns this first so the harmony has a home to orbit.' },
  { id: 'bass', label: 'Bass', voices: 'Bass', role: 'The harmonic floor — the root of each chord with the fifth as gentle movement.' },
  { id: 'mid-harmony-1', label: 'Mid Harmony I', voices: 'Alto / Tenor', role: 'The main moving inner voice — a third/sixth below the melody but landing on chord tones.' },
  { id: 'mid-harmony-2', label: 'Mid Harmony II', voices: 'Alto', role: 'A low inner pad — sustained chord tones below the melody (often the 3rd or 5th of the chord).' },
  { id: 'high-harmony-2', label: 'High Harmony II', voices: 'Soprano / Tenor', role: 'A sustained upper chord tone with gentle suspensions — carries the leading tone that pulls back to the tonic.' },
  { id: 'high-harmony-1', label: 'High Harmony I', voices: 'Soprano', role: 'The sparse top descant — mostly sustained high chord tones, entering on the emotional phrases.' },
];

// The dirge-family shapes (the lament the workbench centers on), in order.
export const DIRGE_RHYTHM_SHAPES = RHYTHM_SHAPES.filter((s) => s.dirge);

// Sheet-music harmony parts: { id, label, role, order, range, derivable, voicing }.
// The base score is the `melody`; the derivable parts are what the AI derive tool
// produces from it. The voicing model is CHORD-TONE (each voice targets a chord
// tone and moves smoothly), NOT parallel-interval tracking of the melody — see
// client/src/lib/songCraft.js for the full rationale. Injected into the derive
// prompt so the model voices each part correctly and returns ids the editor's
// switcher understands. Mirrors HARMONY_PARTS in songCraft.js — keep
// id/label/role/order/range/voicing in sync.
export const HARMONY_PARTS = [
  { id: 'melody', label: 'Melody', role: 'melody', order: 0, range: 'as written', derivable: false, voicing: 'The lead — carries the lyric and rhythmic detail. The base every harmony targets.' },
  { id: 'bass', label: 'Bass', role: 'bass', order: 1, range: 'G2–D3 (down to E2)', derivable: true, voicing: 'Root of each chord, with the fifth as gentle movement — a hymn-like root–fifth–root drone.' },
  { id: 'mid-harmony-2', label: 'Mid Harmony II', role: 'harmony', order: 2, range: 'B2–E4', derivable: true, voicing: 'Low inner pad — sustained chord tones below the melody (often the 3rd or 5th of the chord).' },
  { id: 'mid-harmony-1', label: 'Mid Harmony I', role: 'harmony', order: 3, range: 'D3–G4', derivable: true, voicing: 'The main moving inner voice — a third/sixth below the melody but landing on chord tones.' },
  { id: 'high-harmony-2', label: 'High Harmony II', role: 'harmony', order: 4, range: 'G3–B4', derivable: true, voicing: 'Sustained upper chord tone with gentle suspensions — carries the leading tone (the F# on D7) that pulls back to G.' },
  { id: 'high-harmony-1', label: 'High Harmony I', role: 'harmony', order: 5, range: 'B3–E5', derivable: true, voicing: 'Sparse top descant — mostly sustained high chord tones, entering on the emotional phrases.' },
];

// The parts the derive tool generates (all but the melody, which is the input),
// declaration order low→high.
export const DERIVABLE_HARMONY_PARTS = HARMONY_PARTS.filter((p) => p.derivable);
