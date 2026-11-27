/** MuScriptor size tiers and balanced default shared by transcription, route schemas and UI. */

// The argparse choices in scripts/ml/transcribe_muscriptor.py are pinned by a parity test.
export const MUSCRIPTOR_MODELS = Object.freeze(['small', 'medium', 'large']);
export const DEFAULT_MUSCRIPTOR_MODEL = 'medium';
