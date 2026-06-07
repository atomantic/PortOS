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
// Mirrors VOICE_LAYERS in songCraft.js.
export const VOICE_LAYERS = [
  { id: 'lead', label: 'Lead melody', voices: 'Any — the tune everyone knows', role: 'The song itself. Everyone learns this first so the harmony has a home to orbit.' },
  { id: 'bass', label: 'Bass / root', voices: 'Bass', role: 'The harmonic floor — usually the root of each chord, moving slowly.' },
  { id: 'harmony-3rd', label: 'Harmony (third)', voices: 'Alto / Tenor', role: 'A line a third above or below the melody — the first taste of chord color.' },
  { id: 'harmony-5th', label: 'Harmony (fifth)', voices: 'Tenor / Soprano', role: 'The fifth fills out the triad and opens the sound up.' },
  { id: 'drone', label: 'Drone / pedal', voices: 'Bass / Alto', role: 'A sustained held note (often the tonic or fifth) under everything.' },
  { id: 'counter', label: 'Counter-melody', voices: 'Soprano / Tenor', role: 'An independent melodic line that answers the lead in its gaps.' },
  { id: 'vocal-perc', label: 'Vocal percussion / texture', voices: 'Any', role: 'Breath, hums, clicks, "doo"/"ah" pads, or beatbox — rhythmic and textural glue.' },
];

// The dirge-family shapes (the lament the workbench centers on), in order.
export const DIRGE_RHYTHM_SHAPES = RHYTHM_SHAPES.filter((s) => s.dirge);
