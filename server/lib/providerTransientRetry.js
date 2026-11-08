/**
 * Transient provider errors for media render lanes: a provider that is at
 * capacity, overloaded, rate limited or briefly unavailable will most likely
 * take the same request a few minutes later, so the lane waits and resends
 * instead of failing the shot.
 *
 * The classifier reads what the error says, not who said it, so every lane can
 * share it. A hard usage limit (quota, plan cap, billing) is never transient:
 * waiting minutes does not clear it, and resending only burns attempts.
 *
 * Only call `runWithTransientRetry` around a step whose failure means the
 * provider did NOT render (and so did not charge): the caller decides which
 * of its errors qualify through `isTransient`.
 */
import { isHardProviderUsageLimitError } from './persistentMindUsageLimit.js';

/** Waits before each resend: about 15 minutes in all before the lane gives up. */
export const TRANSIENT_RETRY_DELAYS_MS = Object.freeze([60_000, 2 * 60_000, 4 * 60_000, 8 * 60_000]);
const RETRY_TICK_MS = 5000;

const TRANSIENT_TEXT = new RegExp([
  String.raw`\b(?:at|over|out of|beyond) (?:full |maximum |max )?capacity\b`,
  String.raw`\bcapacity (?:constraints?|issues?|reached)\b`,
  String.raw`\boverload(?:ed)?\b`,
  String.raw`\b(?:unusually |very )?high (?:traffic|demand|load|volume)\b`,
  String.raw`\btoo many (?:requests|people)\b`,
  String.raw`\brate.?limit(?:ed|ing)?\b`,
  String.raw`\btemporarily (?:unavailable|busy|overloaded|down)\b`,
  String.raw`\bservice (?:is )?(?:temporarily )?unavailable\b`,
  String.raw`\b(?:servers? (?:is |are )?|currently |too )busy\b`,
  String.raw`\btry again (?:later|shortly|soon|in a (?:few|moment|bit|minute|while))\b`,
  String.raw`\b(?:HTTP|status|error|code)[ :]*(?:429|503|529)\b`,
].join('|'), 'i');

const errorText = (errorOrText) => (typeof errorOrText === 'string' ? errorOrText : String(errorOrText?.message || ''));

/**
 * Does this provider error read as a temporary condition worth resending
 * after a pause? `err.transient` (true/false) set by a lane wins over the text.
 */
export function isTransientProviderError(errorOrText) {
  if (!errorOrText) return false;
  if (typeof errorOrText === 'object' && typeof errorOrText.transient === 'boolean') return errorOrText.transient;
  const text = errorText(errorOrText);
  if (!text || !TRANSIENT_TEXT.test(text)) return false;
  return !isHardProviderUsageLimitError(text);
}

/** "1 min", "90 s": the wait left, for status lines. */
export const formatRetryWait = (ms) => {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return seconds >= 60 && seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`;
};

const waitTick = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const timer = setTimeout(done, ms);
  function done() {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', done);
    resolve();
  }
  signal?.addEventListener?.('abort', done, { once: true });
});

/**
 * Run `attempt(n)` (n from 0) and resend it after each transient failure,
 * waiting `delaysMs[n]` first. `onRetryWait({ retry, retries, remainingMs,
 * error })` fires when a wait starts and every few seconds through it, so the
 * lane can show the countdown and keep its watchdog fed. An abort during a
 * wait rethrows the failure that started it; the caller sees its own signal.
 *
 * When the retries run out the last error is rethrown with
 * `transientRetriesExhausted` set to how many resends were made.
 */
export async function runWithTransientRetry(attempt, {
  isTransient = isTransientProviderError,
  delaysMs = TRANSIENT_RETRY_DELAYS_MS,
  signal = null,
  onRetryWait = null,
  tickMs = RETRY_TICK_MS,
  now = Date.now,
  wait = waitTick,
} = {}) {
  for (let n = 0; ; n += 1) {
    try {
      return await attempt(n);
    } catch (error) {
      if (signal?.aborted || !isTransient(error)) throw error;
      if (n >= delaysMs.length) {
        if (error && typeof error === 'object' && n > 0) error.transientRetriesExhausted = n;
        throw error;
      }
      const resumeAt = now() + delaysMs[n];
      for (let remainingMs = delaysMs[n]; remainingMs > 0; remainingMs = resumeAt - now()) {
        onRetryWait?.({ retry: n + 1, retries: delaysMs.length, remainingMs, error });
        await wait(Math.min(tickMs, remainingMs), signal);
        if (signal?.aborted) throw error;
      }
    }
  }
}
