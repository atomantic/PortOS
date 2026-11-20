/**
 * Block-streaming mode vocabulary for LTX-2/2.5 MLX local video renders (#6499).
 *
 * "Block streaming" mmaps the transformer's safetensors and streams blocks per-forward instead of holding all 48 in unified memory (~10-12x transformer-RSS cut, ltx-2-mlx's `low_ram_streaming` constructor kwarg, adopted clean-room from Phosphene commits 3f63e773 + e12fc6a1). Whether a MODE's pinned pipeline declares it is answerable only by `scripts/ml/generate_ltx2.py` inspecting the live class at request time (RetakePipeline/extend has none at the pinned versions). This module carries only the REQUEST-side vocabulary PortOS threads through unexamined; the bridge owns capability inspection and the RAM-based auto decision (on the machine EXECUTING the render, so a federated peer decides for its own hardware). `'auto'` (and absence) is the default: `resolve_streaming_policy()` streams at or below the bridge's tight-memory ceiling, else resident (also when RAM can't be read); `resident` and `stream` override. Unlike draft-decode / speed-profile, an explicit `stream` the pinned pipeline can't honor is a REFUSAL (the bridge exits before loading weights), not a silent downgrade (this module only carries the enum). Pure (no ServerError, no Node builtin); mirrored to `client/src/lib/videoStreamingMode.js`.
 */

export const VIDEO_STREAMING_MODES = Object.freeze(['auto', 'resident', 'stream']);

export const DEFAULT_VIDEO_STREAMING_MODE = 'auto';

// Label + one-line description for the picker. Order matches VIDEO_STREAMING_MODES.
export const VIDEO_STREAMING_MODE_OPTIONS = Object.freeze([
  Object.freeze({
    value: 'auto',
    label: 'Auto',
    description: 'Stream transformer blocks from disk on a machine tight enough that it matters; render resident otherwise.',
  }),
  Object.freeze({
    value: 'resident',
    label: 'Resident',
    description: 'Load the full transformer into memory — the behavior every render had before this setting existed.',
  }),
  Object.freeze({
    value: 'stream',
    label: 'Stream',
    description: 'Always stream transformer blocks from disk. Refused before any weights load on a mode whose pinned pipeline has no streaming parameter (Extend).',
  }),
]);

/** Absence and the shipped default request the same thing. */
export const isDefaultVideoStreamingMode = (mode) => (
  mode == null || mode === '' || mode === DEFAULT_VIDEO_STREAMING_MODE
);

export const isKnownVideoStreamingMode = (mode) => VIDEO_STREAMING_MODES.includes(mode);

// Read a mode out of a persisted record (history entry, resumed job params): history records only a NON-default mode (generateVideo.js), so a missing/unknown field means Auto and must CLEAR a leftover selection rather than carry it into a render the user asked to reproduce.
export const videoStreamingModeFromRecord = (value) => (
  isKnownVideoStreamingMode(value) ? value : DEFAULT_VIDEO_STREAMING_MODE
);
