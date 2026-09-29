// Single source of truth for the MuScriptor audio → MIDI model-size tiers.
// Consumed by the two transcription trigger points:
//   - pages/MusicVideo.jsx — the source-track `MIDI` button's size <select>.
//   - components/songs/ReferenceAnalysis.jsx — the reference-audio Transcribe
//     MIDI button's size <select>.
// Larger tiers are higher quality but slower and pull a bigger weight file on
// first use; `medium` is the balanced default. The server's z.enum in
// server/lib/musicVideoValidation.js imports MUSCRIPTOR_MODELS from
// server/lib/muscriptorModels.js, which a parity test pins to the Python
// runner's choices — add a tier there and here together.
export const MUSCRIPTOR_MODELS = ['small', 'medium', 'large'];

export const DEFAULT_MUSCRIPTOR_MODEL = 'medium';
