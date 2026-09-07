/**
 * Re-export of `server/lib/videoStreamingMode.js` — the block-streaming mode
 * vocabulary for LTX-2/2.5 MLX local video renders (#6499).
 */
export {
  DEFAULT_VIDEO_STREAMING_MODE,
  VIDEO_STREAMING_MODES,
  VIDEO_STREAMING_MODE_OPTIONS,
  isDefaultVideoStreamingMode,
  isKnownVideoStreamingMode,
  videoStreamingModeFromRecord,
  videoStreamingModeLabel,
} from '../../../server/lib/videoStreamingMode.js';
