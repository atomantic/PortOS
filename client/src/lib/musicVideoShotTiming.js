/**
 * Music Video shot modes and provider-aware timing (#8977).
 *
 * Re-export of `server/lib/musicVideo/musicVideoShotTiming.js` — the one definition of
 * which backends can render a lip-synced performance shot and of the window /
 * coverage math, imported rather than copied so the board and the server's
 * submission gate cannot disagree.
 */
export { SOURCE_AUDIO_LIPSYNC, SOURCE_AUDIO_MUSIC, CLIP_LENGTH_SEC_RANGE, clipLengthChoices, shotRequestSpanSec, clipAudioOffsetSec, falSceneTake, falTakeRequestFields, grokCoverage, grokSceneRequestDuration, isPerformanceScene, meteredModelLabel, meteredSceneTake, performanceBlockedReason, performanceCapability, planPerformanceWindow, planPerformanceRepair, runwaySceneTake, runwayTakeRequestFields, sceneRenderShot, selectedPerformanceInstruction, shotSplitLimit } from '../../../server/lib/musicVideo/musicVideoShotTiming.js';
