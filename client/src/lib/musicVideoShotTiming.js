/**
 * Music Video shot modes and provider-aware timing (#8977).
 *
 * Re-export of `server/lib/musicVideoShotTiming.js` — the one definition of
 * which backends can render a lip-synced performance shot and of the window /
 * coverage math, imported rather than copied so the board and the server's
 * submission gate cannot disagree.
 */
export {
  MUSIC_VIDEO_SHOT_MODES,
  SOURCE_AUDIO_LIPSYNC,
  approximateMotionCues,
  grokCoverage,
  isPerformanceScene,
  performanceBlockedReason,
  performanceCapability,
  planPerformanceWindow,
} from '../../../server/lib/musicVideoShotTiming.js';
