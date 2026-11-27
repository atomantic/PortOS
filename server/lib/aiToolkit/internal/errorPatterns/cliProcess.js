/** Classify terminal model errors, CLI timeouts and retry stalls. */
import { ERROR_CATEGORIES, UNTRUSTED_BOUNDARY } from './categories.js';

// Claude Code renders a non-recoverable *model id* rejection inline as
// `⏺ API Error (<model>): 400 The provided model identifier is invalid…`
// (Bedrock) or `API Error: 404 … not_found_error` (Anthropic) and then sits at an
// unanswered prompt — it does NOT auto-retry the way it does a 429/500. Without an
// early-fail signal the one-shot TUI runner idles out, reports success, and scrapes
// the error screen as a bogus "response" (which then trips downstream guards like
// the manuscript-reformat integrity check).
//
// This is DELIBERATELY NOT in IMMEDIATE_FALLBACK_SIGNALS: that detector is shared
// by the long-running agent spawn paths (agentTuiSpawning / agentCliSpawning) and
// the CLI runner, which stream arbitrary agent output through it. An agent that
// legitimately prints this error line — `cat`-ing a prior run's output.txt, running
// the error-detection tests, or investigating this very failure — commonly puts the
// raw error at a LINE START, where line-anchoring alone wouldn't save it, and a
// healthy run would be killed and misclassified MODEL_NOT_FOUND. So only the one-shot
// TUI runner (tuiPromptRunner) consults this, via `createTerminalModelErrorDetector`:
// it runs a single prompt whose only `API Error` rendering is Claude Code's own, so
// the false-positive surface is negligible. CLI runs detect the same failure via the
// process's non-zero exit code; they don't need an in-stream signal.
//
// Two precision constraints (belt-and-suspenders for the one-shot path):
//   1. Line-anchored (`^…/m`) — the real signal is at a line start (or the
//      512-char buffer's slice boundary, which `^` also matches).
//   2. The 400/404 status must immediately follow the `API Error[(model)]:` prefix
//      — so a retryable `API Error: 429 … 404 not found` (incidental 404) is left
//      alone for Claude Code to auto-retry.
const TERMINAL_MODEL_ERROR_PATTERN = /^\s*(?:⏺\s*)?API Error(?:\s*\([^)]*\))?:\s*(?:400|404)\b[^\n]{0,160}(?:model identifier is invalid|not[_\s]?found)/im;

export function detectTerminalModelError(text) {
  if (!text) return null;
  const match = String(text).match(TERMINAL_MODEL_ERROR_PATTERN);
  if (!match) return null;
  return {
    hasError: true,
    category: ERROR_CATEGORIES.MODEL_NOT_FOUND,
    message: match[0].trim() || 'Provider rejected the configured model id',
    waitTime: null,
    requiresFallback: true,
    actionable: true,
    suggestedFix: 'The provider does not recognize this model id — check the model name/availability for this provider; retrying with a fallback model.'
  };
}

export function createTerminalModelErrorDetector({ maxBuffer = 512 } = {}) {
  let buffer = '';
  const cap = Number.isFinite(maxBuffer) && maxBuffer > 0 ? maxBuffer : 512;

  return (chunk) => {
    if (!chunk) return null;
    buffer = `${buffer}${String(chunk)}`.slice(-cap);
    return detectTerminalModelError(buffer);
  };
}

// Claude Code retries transient provider failures inside the TUI. Let those
// retries run: a line such as `Request timed out · Retrying … attempt 7/10` is
// still recoverable and may eventually produce the requested response file.
// Once all retries are exhausted, however, Claude Code renders a terminal
// gutter line (`⎿ Request timed out`) and may still exit with code 0. Without a
// one-shot-only detector, the runner calls that a success and hands the error
// screen to downstream JSON/prose consumers as if it were model output.
//
// Require the gutter glyph and the whole line. This deliberately does not match
// ordinary generated prose mentioning a request timeout, nor an in-progress
// retry banner. `\s*` between words also matches the cursor-positioned,
// ANSI-stripped shape observed from the TUI (`Requesttimedout`).
//
// The line must end with a REAL terminator (`\r` or `\n`) — `$` alone is a trap
// here (#3715). The streaming detector re-tests a rolling buffer whose end is
// always the newest byte received, so `$` also matched "the line so far",
// making a PTY chunk that split right after `Request timed out`
// indistinguishable from a finished line: the ` · Retrying in 38s · attempt
// 3/10` suffix simply had not been delivered yet. With a 200x50 PTY repainting
// on every countdown tick that split is a matter of time, not a rare race — and
// it killed the very runs this detector exists to let keep retrying. Requiring
// a terminator holds the candidate until the rest of the line lands; if that
// turns out to be a retry suffix, the match never happens. Trailing horizontal
// whitespace is tolerated, but `[^\S\r\n]` must not swallow the terminator.
const TERMINAL_REQUEST_TIMEOUT_PATTERN = /^[\s\u00a0]*⎿[\s\u00a0]*Request\s*timed\s*out\.?[^\S\r\n]*[\r\n]/im;

export function detectTerminalRequestTimeout(text, { lineStartTrusted = true } = {}) {
  if (!text) return null;
  const value = String(text);
  const match = (lineStartTrusted ? value : `${UNTRUSTED_BOUNDARY}${value}`)
    .match(TERMINAL_REQUEST_TIMEOUT_PATTERN);
  if (!match) return null;
  return {
    hasError: true,
    category: ERROR_CATEGORIES.TIMEOUT,
    message: 'Provider request timed out after exhausting TUI retries',
    waitTime: null,
    requiresFallback: true,
    actionable: false,
    suggestedFix: 'The provider exhausted its internal request retries — retrying with a fallback provider.',
    exitCode: 124,
  };
}

export function createTerminalRequestTimeoutDetector({ maxBuffer = 512 } = {}) {
  let buffer = '';
  // Mirrors createImmediateFallbackSignalDetector: once the window has dropped
  // anything, buffer[0] is a slice boundary, not a line start, and the
  // `^`-anchored pattern would happily match a fabricated one (a long line of
  // agent prose sliced exactly before the gutter glyph). A TUI stream rolls a
  // 512-char window within a second, so this matters in practice; the repaint
  // loop re-delivers the real banner with its own line start moments later.
  let truncated = false;
  const cap = Number.isFinite(maxBuffer) && maxBuffer > 0 ? maxBuffer : 512;

  // `endOfStream` reports that no more bytes can arrive (the PTY exited), which
  // is itself the terminator a held candidate was waiting for — nothing can
  // still complete the last line into a `· Retrying …` banner. Synthesizing the
  // newline there keeps the terminator requirement above from losing the case
  // where the banner is the final thing painted before exit.
  return (chunk, { endOfStream = false } = {}) => {
    if (chunk) {
      const next = `${buffer}${String(chunk)}`;
      if (next.length > cap) truncated = true;
      buffer = next.slice(-cap);
    } else if (!endOfStream) return null;
    return detectTerminalRequestTimeout(
      endOfStream ? `${buffer}\n` : buffer,
      { lineStartTrusted: !truncated },
    );
  };
}

// Claude Code's in-TUI retry banner, painted while it re-sends a failed request:
// `API error · Retrying in 0s · attempt 1/10` (the prefix varies — `Request timed
// out`, `Overloaded` — so only the retry suffix is matched). The whitespace is
// `\s*` everywhere for the same reason TERMINAL_REQUEST_TIMEOUT_PATTERN's is: the
// ANSI-stripped screen can drop the spaces between cursor-positioned glyphs.
//
// A banner is NOT a failure by itself — Claude Code retries transient 429/5xx
// on its own and usually succeeds. It becomes one when the SAME request keeps
// failing without a response. The host's retry-stall gate owns the attempt
// count and deadline. This detector only reads the banner.
const TUI_RETRY_BANNER_PATTERN = /Retrying\s*in\s*(\d+)\s*s\s*[·•]\s*attempt\s*(\d+)\s*\/\s*(\d+)/gi;

/**
 * The LAST retry banner in `text`, or null. A repaint often carries two ticks
 * of the same countdown (`Retrying in 1s` then `0s`); the newest is the state.
 *
 * @returns {{ attempt: number, maxAttempts: number, retryInSeconds: number, endIndex: number }|null}
 */
export function detectTuiRetryBanner(text) {
  if (!text) return null;
  let last = null;
  for (const match of String(text).matchAll(TUI_RETRY_BANNER_PATTERN)) {
    last = {
      retryInSeconds: Number(match[1]),
      attempt: Number(match[2]),
      maxAttempts: Number(match[3]),
      endIndex: match.index + match[0].length,
    };
  }
  return last;
}

/**
 * The fail-over analysis for a request the TUI kept retrying without ever
 * getting a response — same shape as `detectImmediateFallbackSignal` returns, so
 * a consumer hands it straight to its fail-over path.
 *
 * A FIXED sentence, deliberately not the banner text: this message becomes the
 * run error, then a failure reason a CoS task body can quote, and a TUI echoes
 * a pasted prompt back through the very detector above — so it must not match
 * TUI_RETRY_BANNER_PATTERN (it carries no `Retrying in Ns · attempt`).
 */
export function describeTuiRetryStall({ attempts, spanMs }) {
  const minutes = Math.max(1, Math.round(spanMs / 60000));
  return {
    hasError: true,
    category: ERROR_CATEGORIES.TIMEOUT,
    message: `Provider kept failing the same request: the TUI retried it ${attempts} times over ${minutes} minutes without a response`,
    waitTime: null,
    requiresFallback: true,
    // Nothing a human has to fix before a retry can succeed elsewhere: the
    // request is too slow for THIS provider's harness window (a long prefill on
    // a local model server, a stalled upstream), and a fallback can serve it now.
    actionable: false,
    graceMs: 0,
    suggestedFix: 'Every retry re-sent the same request and none answered — typically a prompt whose prefill outlives the harness\'s stream-idle window on a local model server. Shrink the prompt, widen the idle window, or pin the stage to a faster provider.',
    origin: 'provider',
  };
}

export const spawnRule = {
  // A local CLI cannot be started when its executable is absent from the
  // server process's PATH. This is a configuration/install problem, not an
  // unknown provider failure: classifying it as spawn-error routes the
  // diagnostic to the existing Tier-1 setup guidance.
  pattern: /spawn\s+\S+\s+ENOENT|CLI is not installed or is not on PortOS's PATH/i,
  category: ERROR_CATEGORIES.SPAWN_ERROR,
  requiresFallback: true,
  actionable: true,
  suggestedFix: 'Install the local provider CLI and restart PortOS so its PATH includes the command.'
};

export const networkRule = {
  // `GOAWAY` / `UND_ERR_SOCKET` are undici's connection-level failures, which
  // reach here as the flattened cause chain `describeTransportError` builds
  // (the bare `TypeError: fetch failed` matches nothing). Without them a
  // remote gateway retiring a pooled connection classified as UNKNOWN and was
  // escalated to an open-ended tier-4 investigation, when the honest reading
  // is a transient connectivity fault with a 2m bench.
  //
  // `terminated` is the same family seen from the other half of a run: undici
  // raises `TypeError: terminated` when the peer drops the connection while
  // the RESPONSE BODY is streaming, normally with the code on `.cause` (so
  // `UND_ERR_SOCKET` above already matches the flattened chain) but not
  // always. It is anchored to the WHOLE string rather than line-anchored on
  // purpose — `analyzeError` also scans an agent's entire CLI screen, where
  // "… terminated" is ordinary prose, and only a cause-less transport
  // rejection ever arrives as that single word on its own.
  pattern: /ECONNREFUSED|ECONNRESET|EPIPE|ENOTFOUND|network error|connection refused|timeout|ETIMEDOUT|GOAWAY|UND_ERR_SOCKET|ERR_STREAM_PREMATURE_CLOSE|^terminated$|TypeError: terminated/i,
  category: ERROR_CATEGORIES.NETWORK_ERROR,
  requiresFallback: false,
  actionable: false,
  suggestedFix: 'Check network connectivity and provider endpoint URL'
};

export const timeoutRule = {
  pattern: /timed out|timeout exceeded|SIGTERM/i,
  category: ERROR_CATEGORIES.TIMEOUT,
  requiresFallback: false,
  actionable: false,
  suggestedFix: 'Consider increasing timeout or reducing prompt complexity'
};
