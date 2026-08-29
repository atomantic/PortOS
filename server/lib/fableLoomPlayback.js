/**
 * FableLoom node playback semantics shared by persistence, prompts, and UI.
 * Legacy nodes default to decision mode so upgrades never start auto-advancing
 * an authored choice graph without the author explicitly reweaving/editing it.
 */

export const FABLELOOM_PLAYBACK_MODES = Object.freeze(['cut', 'decision']);
export const FABLELOOM_PLAYBACK_MODE_DEFAULT = 'decision';

export const isFableLoomPlaybackMode = (value) => FABLELOOM_PLAYBACK_MODES.includes(value);
export const asFableLoomPlaybackMode = (value) => (
  isFableLoomPlaybackMode(value) ? value : FABLELOOM_PLAYBACK_MODE_DEFAULT
);
