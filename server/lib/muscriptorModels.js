// MuScriptor model sizes (weights auto-download on first use). Pure leaf shared
// by the route schemas and services/audioMidiTranscription.js; a parity test
// pins it to `--model` choices in scripts/transcribe_muscriptor.py.
export const MUSCRIPTOR_MODELS = Object.freeze(['small', 'medium', 'large']);
