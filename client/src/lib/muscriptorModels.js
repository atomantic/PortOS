// Single source of truth for the MuScriptor audio → MIDI model-size tiers.
// Consumed by the two transcription trigger points:
//   - pages/MusicVideo.jsx — the source-track `MIDI` button's size <select>.
//   - components/songs/ReferenceAnalysis.jsx — the reference-audio Transcribe
//     MIDI button's size <select>.
// Larger tiers are higher quality but slower and pull a bigger weight file on
// first use; `medium` is the balanced default. The server's z.enum in
// server/lib/musicVideoValidation.js and MUSCRIPTOR_MODELS in
// server/services/audioMidiTranscription.js must match these values — add a
// tier here and to the server set together.
export const MUSCRIPTOR_MODELS = ['small', 'medium', 'large'];

export const DEFAULT_MUSCRIPTOR_MODEL = 'medium';
