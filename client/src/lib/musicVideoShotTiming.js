/**
 * Music Video shot modes and provider-aware timing (#8977).
 *
 * Re-export of `server/lib/musicVideoShotTiming.js` — the one definition of
 * which backends can render a lip-synced performance shot and of the window /
 * coverage math, imported rather than copied so the board and the server's
 * submission gate cannot disagree.
 */
import { grokCoverage, shotRequestSpanSec } from '../../../server/lib/musicVideoShotTiming.js';

/** The duration a shot card submits, including its per-shot override. */
export function grokSceneRequestDuration(scene, settings, target = null, scenes = null) {
  const span = shotRequestSpanSec(scene, scenes);
  return target?.grokDuration || (span != null ? grokCoverage(span).requestSec : settings?.grokDuration);
}

export {
  MUSIC_VIDEO_SHOT_MODES,
  SOURCE_AUDIO_LIPSYNC,
  SOURCE_AUDIO_MUSIC,
  CLIP_LENGTH_SEC_RANGE,
  approximateMotionCues,
  clipLengthChoices,
  sceneClipLengthSec,
  shotRequestSpanSec,
  clipAudioOffsetSec,
  falSceneTake,
  falTakeRequestFields,
  grokCoverage,
  isPerformanceScene,
  meteredModelLabel,
  meteredSceneTake,
  performanceBlockedReason,
  performanceCapability,
  planPerformanceWindow,
  planPerformanceRepair,
  runwaySceneTake,
  runwayTakeRequestFields,
  sceneRenderShot,
  selectedPerformanceInstruction,
  shotSplitLimit,
} from '../../../server/lib/musicVideoShotTiming.js';
