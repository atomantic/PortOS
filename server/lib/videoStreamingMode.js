/**
 * Block-streaming mode vocabulary for LTX-2/2.5 MLX local video renders (#6499).
 *
 * "Block streaming" mmaps the transformer's safetensors and streams blocks in
 * per-forward instead of materializing all 48 in unified memory — the roughly
 * 10-12x transformer-RSS cut ltx-2-mlx exposes as the `low_ram_streaming`
 * pipeline constructor kwarg (adopted clean-room from Phosphene commits
 * 3f63e773 + e12fc6a1). Whether a given render MODE's pinned pipeline
 * constructor even declares that parameter can only be answered by
 * `scripts/generate_ltx2.py` inspecting the live class at request time —
 * RetakePipeline (extend mode) has none at the pins this bridge targets, every
 * other mode's pipeline does. This module carries only the REQUEST-side
 * vocabulary PortOS threads through unexamined; the bridge owns capability
 * inspection and the actual RAM-based auto decision (it runs on whichever
 * machine is EXECUTING the render, never the submitter's, so a federated peer
 * decides for its own hardware).
 *
 * `'auto'` (and absence) is the shipped default — `resolve_streaming_policy()`
 * in the Python bridge turns it into streaming on a machine at or below the
 * bridge's known-tight-memory ceiling, and resident above it or when physical
 * memory can't be read. `resident` and `stream` are explicit overrides. Unlike
 * draft-decode / speed-profile, an explicit `stream` request the pinned
 * pipeline cannot honor is a REFUSAL (the bridge exits before loading weights)
 * rather than a silent downgrade — this module does not decide that; it only
 * carries the enum.
 *
 * Pure (no ServerError, no Node builtin) — mirrored to
 * `client/src/lib/videoStreamingMode.js` so the picker and the request builder
 * share one vocabulary.
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

export const videoStreamingModeLabel = (mode) => (
  VIDEO_STREAMING_MODE_OPTIONS.find((o) => o.value === mode)?.label || 'Auto'
);

// Read a mode out of a persisted record (a history entry, a resumed job's
// params). History records only a NON-default mode (see generateVideo.js), so
// a missing/unknown field means Auto — and must CLEAR a leftover selection
// rather than carry it into a render the user asked to reproduce.
export const videoStreamingModeFromRecord = (value) => (
  isKnownVideoStreamingMode(value) ? value : DEFAULT_VIDEO_STREAMING_MODE
);
