/**
 * Lyric-aware MiniMax Music 3 duration analysis: section/word detection, ending-cushioned
 * auto-duration recommendations, and cap warnings.
 *
 * Mirrors `server/lib/musicDuration.js`.
 */

/**
 * Lyric-length → song-duration estimation.
 *
 * Re-export of `server/lib/musicDuration.js` — the one definition of this rule,
 * imported rather than copied so the two runtimes cannot drift. The file stays
 * so every `lib/musicDuration` import path in the client is unchanged.
 */
export {
  MINIMAX_AUTO_DURATION_STEP_SEC,
  MINIMAX_AUTO_MAX_DURATION_SEC,
  MINIMAX_AUTO_MIN_DURATION_SEC,
  analyzeMusicLyrics,
  recommendMinimaxDurationSec,
} from '../../../server/lib/musicDuration.js';
