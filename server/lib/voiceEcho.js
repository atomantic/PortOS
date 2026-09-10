/**
 * Pure voice-echo detection helpers — tokenization, trigram building, and
 * thresholds shared between server echo filtering (`server/services/voice/echo.js`)
 * and client STT echo cancellation (`client/src/services/voiceClient.js`).
 *
 * Both implementations apply the same algorithm:
 *   1. Length gate: utterances shorter than MIN_TOKENS_FOR_ECHO_CHECK words
 *      are NEVER classified as echo (preserves user interrupts).
 *   2. Trigram match: for longer utterances, count shared 3-word windows
 *      against recently-spoken TTS sentences. Two+ shared trigrams is strong
 *      evidence of echo.
 *
 * Time-windowed: TTS sentences older than ECHO_WINDOW_MS are ignored.
 */

export const ECHO_WINDOW_MS = 8000;
export const MIN_TOKENS_FOR_ECHO_CHECK = 4;
export const MIN_SHARED_TRIGRAMS = 2;

export const tokenize = (s) => (s || '')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .split(/\s+/)
  .filter(Boolean);

export const trigramsOf = (tokens) => {
  if (!Array.isArray(tokens) || tokens.length < 3) return [];
  const out = [];
  for (let i = 0; i + 3 <= tokens.length; i++) {
    out.push(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
  }
  return out;
};
