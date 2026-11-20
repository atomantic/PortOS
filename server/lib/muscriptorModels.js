// `MUSCRIPTOR_MODELS` (`small`/`medium`/`large`) — MuScriptor size tiers shared by route schemas and
// `audioMidiTranscription.js`.
//
// Pinned to the Python runner's argparse choices.
//
// MuScriptor model sizes (weights auto-download on first use). Pure leaf shared
// by the route schemas and services/audioMidiTranscription.js; a parity test
// pins it to `--model` choices in scripts/ml/transcribe_muscriptor.py.
export const MUSCRIPTOR_MODELS = Object.freeze(['small', 'medium', 'large']);
