/**
 * Error Detection Utility
 *
 * Detects and categorizes errors from AI provider responses,
 * particularly rate limits and usage limits that require fallback handling.
 */

export const ERROR_CATEGORIES = {
  CANCELED: 'canceled',
  RATE_LIMIT: 'rate-limit',
  USAGE_LIMIT: 'usage-limit',
  AUTH_ERROR: 'auth-error',
  SPAWN_ERROR: 'spawn-error',
  MODEL_NOT_FOUND: 'model-not-found',
  NETWORK_ERROR: 'network-error',
  TIMEOUT: 'timeout',
  QUOTA_EXCEEDED: 'quota-exceeded',
  // A frontier model declined the prompt on content/safety grounds. NOT a
  // provider fault — the provider is healthy and other prompts still work, so
  // this must not bench the provider or spawn an investigation task. We do try
  // a fallback (a local model often doesn't refuse) and tell the UI what
  // happened. See server/index.js#onRunFailed + autoFixer.handleAIProviderError.
  CONTENT_REFUSAL: 'content-refusal',
  // A LOCAL inference runtime ran out of accelerator memory mid-request (Metal
  // on Apple silicon, CUDA elsewhere). Distinct from QUOTA_EXCEEDED (money) and
  // from TIMEOUT (the request never finished): the request was ACCEPTED and then
  // killed by the device allocator, so the same prompt can succeed once the GPU
  // drains. See LOCAL_RUNTIME_OOM_PATTERN.
  RESOURCE_EXHAUSTED: 'resource-exhausted',
  UNKNOWN: 'unknown'
};

/**
 * Was this rejection an intentional stop rather than a failed AI attempt?
 *
 * A canceled terminal — a Stop of the in-flight run, a coordinator cancelling
 * its own active LLM call, or a host shutdown tree-killing the child — is
 * finalized with `canceled: true` on the run metadata, and the prompt runner
 * stamps `code: 'RUN_CANCELED'` onto the rejection it raises from it.
 *
 * Every caller that CLASSIFIES a failure — picks a pause kind, files a gap /
 * investigation task, benches a provider, marks a run `error` — must ask this
 * FIRST. A cancellation is evidence about the operator, not about the provider
 * or the automation: treating it as a defect files spurious follow-up work and
 * spends a post-mortem diagnosing a human pressing Stop. Lives here (rather
 * than beside the code that stamps it) so the classifying callers can ask
 * without importing the whole provider/runner graph.
 *
 * @param {*} err — a rejection from an LLM call
 * @returns {boolean}
 */
export const isRunCanceledError = (err) => (
  !!err && (err.code === 'RUN_CANCELED' || err.canceled === true)
);

// A LOCAL inference runtime that ran out of accelerator memory mid-request.
//
// Observed shape (MTPLX/MLX behind an OpenAI-compatible server, rendered inside
// OpenCode's error box, hard-wrapped by the TUI):
//
//     {"message":"[METAL] Command buffer execution failed: Insufficient Memory
//     (00000008: kIOGPUCommandBufferCallbackErrorOutOfMemory).","type":
//     "server_error","code":"RuntimeError","param":null}
//
// Every alternative below is a single unbroken token or a short phrase that a
// TUI wraps at a space, so the pattern survives the box-drawing glyphs and
// newlines the renderer injects INSIDE the JSON. That is also why this pattern
// is deliberately NOT line-anchored the way the agy banners are: there is no
// line start to anchor to once the envelope is wrapped across four rows.
//
// The precision comes from the strings themselves — these are vendor error
// constants, not English an agent writes by accident. The residual
// false-positive surface is an agent QUOTING one (working on this file, or
// investigating this very failure), and the consumer bounds that cost: the
// agent-TUI path only nudges a session that has ALREADY gone silent, and only
// fails the run after three such nudges (see createOomNudgeGate).
const LOCAL_RUNTIME_OOM_PATTERN = new RegExp([
  'kIOGPUCommandBufferCallbackErrorOutOfMemory',
  '\\[METAL\\]\\s*Command buffer execution failed',
  'CUDA (?:error: )?out of memory',
  'torch\\.(?:cuda\\.)?OutOfMemoryError',
  'CUDA_ERROR_OUT_OF_MEMORY',
].join('|'), 'i');

// Order matters — more specific patterns first.
const ERROR_PATTERNS = [
  {
    // High-precision markers for a model safety/content refusal. Codex (OpenAI)
    // returns "Invalid prompt: we've limited access to this content for safety
    // reasons. This type of information may be used to benefit or to harm…";
    // Anthropic surfaces a `refusal` stop reason. Matched FIRST so a refusal is
    // never misclassified as an auth/unknown failure that would bench the
    // provider and queue a CoS investigation task.
    pattern: /limited access to this content for safety|may be used to benefit or to harm|content[_ ]policy[_ ]violation|stop_reason["']?\s*:\s*["']?refusal|"type"\s*:\s*"refusal"/i,
    category: ERROR_CATEGORIES.CONTENT_REFUSAL,
    requiresFallback: true,
    actionable: false,
    suggestedFix: 'Model declined the prompt on content/safety grounds — retrying with a fallback model.'
  },
  {
    // A local inference server (MTPLX/MLX, vLLM, llama.cpp, Ollama) whose device
    // allocator failed mid-request. Matched BEFORE the generic network/timeout
    // clauses so a post-hoc scan of a failed run's output labels it for what it
    // is instead of landing in UNKNOWN. Shares its source with
    // LOCAL_RUNTIME_OOM_PATTERN so the streaming detector and the post-hoc scan
    // can never drift apart.
    pattern: LOCAL_RUNTIME_OOM_PATTERN,
    category: ERROR_CATEGORIES.RESOURCE_EXHAUSTED,
    requiresFallback: true,
    actionable: false,
    suggestedFix: 'The local inference runtime ran out of GPU memory. Retry once the device drains, shrink the context/KV cache, or run a smaller model.'
  },
  {
    pattern: /billing|payment|credit|insufficient funds/i,
    category: ERROR_CATEGORIES.QUOTA_EXCEEDED,
    requiresFallback: true,
    actionable: true,
    suggestedFix: 'Check billing status and add credits to the provider account'
  },
  {
    pattern: /API Error: 429|rate.?limit|too many requests/i,
    category: ERROR_CATEGORIES.RATE_LIMIT,
    requiresFallback: false,
    actionable: false,
    suggestedFix: 'Wait and retry - temporary rate limiting'
  },
  {
    // `upgrade your subscription to increase your limits` is Antigravity's
    // quota banner (see AGY_QUOTA_BANNER). Claude Code reports its rolling
    // subscription exhaustion as `You've hit your monthly spend limit ...
    // your session limit resets ...`, which is a usage limit too even though it
    // does not contain the older `usage limit` wording. The existing
    // usage-limit category is also used by the immediate-fallback signals; the
    // CLI path needs this post-hoc match to bench the provider and reach a
    // fallback rather than falling through to UNKNOWN. Kept to vendor/billing
    // phrasing — a bare
    // "quota reached" is a phrase story text can legitimately contain, and
    // this scan reads the model's entire screen.
    pattern: /(?:hit your usage limit|hit your (?:monthly )?spend limit|your session limit resets?|usage limit|Upgrade to Pro|upgrade your subscription to increase your limits|(?:^|\n)\s*(?:\[stderr\]\s*)?Now using extra usage\s*(?:\r?\n|$))/i,
    category: ERROR_CATEGORIES.USAGE_LIMIT,
    requiresFallback: true,
    actionable: true,
    suggestedFix: 'Provider usage limit reached. Using fallback provider or wait for limit reset.',
    extractWaitTime: true
  },
  {
    pattern: /unauthorized|invalid.?api.?key|authentication|forbidden|401|403/i,
    category: ERROR_CATEGORIES.AUTH_ERROR,
    requiresFallback: true,
    actionable: true,
    suggestedFix: 'Check API key configuration for this provider'
  },
  {
    // A local CLI cannot be started when its executable is absent from the
    // server process's PATH. This is a configuration/install problem, not an
    // unknown provider failure: classifying it as spawn-error routes the
    // diagnostic to the existing Tier-1 setup guidance.
    pattern: /spawn\s+\S+\s+ENOENT|CLI is not installed or is not on PortOS's PATH/i,
    category: ERROR_CATEGORIES.SPAWN_ERROR,
    requiresFallback: true,
    actionable: true,
    suggestedFix: 'Install the local provider CLI and restart PortOS so its PATH includes the command.'
  },
  {
    // "model identifier is invalid" is Bedrock's wording when the runner passes
    // a model id the backend doesn't recognize (e.g. a bare Anthropic id like
    // `claude-opus-5` to a Bedrock-backed Claude Code, which wants
    // `global.anthropic.claude-opus-5`). Categorize it alongside the
    // not-found/invalid-model phrasings so the cooldown + fallback path treats
    // it as the config problem it is.
    // `"<model>" does not support chat` is Ollama's 400 when a request routes a
    // model at an endpoint it doesn't serve — the everyday case being an
    // embedding-only model (nomic-embed-text, bge-*, mxbai-embed-*) reached
    // through /api/chat. It names no "model" token, so the clauses above miss
    // it and it used to land in UNKNOWN: a 1-minute bench of a perfectly
    // healthy daemon plus a tier-4 investigation task. It is the same class of
    // fault as an unknown model id — this request named the wrong model for
    // this endpoint — so it belongs here, where the cooldown treats it as
    // request-specific and tier 1 corrects the model instead. The other
    // operations Ollama names the same way (`insert`, `tools`, `thinking`) are
    // the same fault — a model asked for something it cannot do — and were
    // still landing in UNKNOWN.
    pattern: /model.*(not found|does not exist|unavailable)|invalid model|model identifier is invalid|does not support (?:chat|generate|completions?|embeddings?|insert|tools|thinking)/i,
    category: ERROR_CATEGORIES.MODEL_NOT_FOUND,
    requiresFallback: true,
    actionable: true,
    suggestedFix: 'Check model name and availability in provider settings'
  },
  {
    pattern: /ECONNREFUSED|ENOTFOUND|network error|connection refused|timeout|ETIMEDOUT/i,
    category: ERROR_CATEGORIES.NETWORK_ERROR,
    requiresFallback: false,
    actionable: false,
    suggestedFix: 'Check network connectivity and provider endpoint URL'
  },
  {
    pattern: /timed out|timeout exceeded|SIGTERM/i,
    category: ERROR_CATEGORIES.TIMEOUT,
    requiresFallback: false,
    actionable: false,
    suggestedFix: 'Consider increasing timeout or reducing prompt complexity'
  }
];

const WAIT_TIME_PATTERNS = [
  /resets?\s+(\d{1,2}(?:am|pm)?)\s*\(([^)]+)\)/i,
  /try again in\s+((?:\d+\s*(?:day|hour|minute|second)s?\s*)+)/i,
  /wait\s+((?:\d+\s*(?:day|hour|minute|second)s?\s*)+)/i,
  /in\s+(\d+)\s*(day|hour|minute|second)s?/i,
  /(\d+\s*day(?:s)?)?[,\s]*(\d+\s*hour(?:s)?)?[,\s]*(\d+\s*min(?:ute)?(?:s)?)?/i
];

// TUI chrome renders a banner in an output gutter — leading whitespace plus the
// box-drawing/bullet glyphs the CLIs draw (agy uses `⎿`, Claude Code `⏺`). An
// agent *quoting* a banner in prose, a grep hit (`file.js:122: …`), or a source
// line (`pattern: /…/`) puts real text before the banner on the same line, which
// this prefix deliberately does NOT admit. Markdown list bullets (`- `, `* `) are
// left out for the same reason: that is how an agent writes ABOUT a banner.
//
// `[stderr]` is a host-added tag, not agent text: agentCliSpawning feeds stderr
// to the detector as `[stderr] ${text}`, so it lands BEFORE the CLI's own gutter
// glyphs. The alternation lets tag and gutter interleave in either order —
// requiring gutter-then-tag would demote a genuine banner printed on stderr.
// `⚠` is agy's gutter glyph for its own error banners (quota, see below).
const TUI_GUTTER_PREFIX = '^(?:[\\s│┃╎⎿⏺●•⚠]|\\[stderr\\])*';

// Antigravity's spent-subscription banner, as agy paints it:
//
//     ⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 3h51m14s.
//     Error ID: <uuid>-7
//
// Line-anchored behind gutter decoration only, so an agent writing ABOUT the
// banner (a markdown bullet, prose, a grep hit) never matches — the same
// precision the `Now using extra usage` entry relies on. The qualifier before
// `quota reached` is left open (`Individual` today) because it names WHOSE
// quota, not what happened. `Resets in …` is optional: it is the part most
// likely to change shape, and the sentence before it is already unambiguous.
//
// The trailing lookahead requires agy's `Error ID:` envelope line WITHOUT
// pulling it into match[0], and that asymmetry is the point. `match[0]` becomes
// the run's error string, which becomes the autopilot's failure reason, which a
// CoS task description then quotes on a line of its own — and a TUI echoes a
// pasted prompt indented, i.e. behind nothing but whitespace. Without the
// lookahead this signal would match its OWN propagated message and kill the very
// agent dispatched to investigate it. Keeping the envelope out of the capture
// means the reason string can never re-match. A hypothetical banner agy prints
// with no `Error ID:` is deliberately left to the post-hoc output scan below.
const AGY_QUOTA_BANNER = `${TUI_GUTTER_PREFIX}(?:[A-Za-z][\\w-]*\\s+)?quota reached\\.\\s*Please upgrade your subscription to increase your limits\\.(?:\\s*Resets? in\\s*[^\\r\\n]{1,32})?(?=\\s{0,8}Error ID:)`;

/**
 * Signals that fail a run immediately so the task can pick a fallback provider.
 *
 * Provenance (#3631): a match is stamped `origin: 'provider'` — the whole gate
 * `agentFinalization.js` uses to BENCH the provider for every subsequently
 * dequeued task — only when the text is unambiguous provider chrome. When an
 * entry's `pattern` can also match text the agent itself could have printed
 * (quoting a banner in prose, `cat`-ing a prior run's `output.txt`, a grep hit
 * over this file), an optional `structuredMarker` sub-pattern gates the
 * promotion: without the marker the match falls through to
 * `origin: 'output-scan'` — still a real failure that fails the run and routes
 * to a fallback, just not evidence about the provider's health. This mirrors
 * `resolvePatternOrigin` in PortOS's `agentErrorAnalysis.js`. An entry whose
 * pattern has no loose alternative may omit `structuredMarker`.
 */
const IMMEDIATE_FALLBACK_SIGNALS = [
  {
    // Antigravity leaves its composer visible while Google verifies account
    // eligibility, so a CoS agent can appear ready, accept a paste, then do no
    // work until the provider-signal grace window fails over. This exact two-line
    // banner is provider chrome (not a generic auth word an agent may print), so it is
    // safe to act on and let the task select a fallback.
    //
    // NOT actionable: the account is fine and nothing in PortOS config is wrong
    // — Google is mid-verification and says so ("try again shortly"). Marking it
    // actionable would BLOCK the task outright (see
    // agentErrorAnalysis#resolveFailedTaskDecision) over a condition that clears
    // itself, so it takes the ordinary retry path instead. The host still
    // sidelines the provider for the auth-error cooldown (providerCooldown.js)
    // so that retry resolves onto a fallback rather than re-dying on the same
    // banner three seconds later.
    //
    // ── CANONICAL ACCOUNT of the 2026-08-11 incident (other sites point here) ──
    // `graceMs` exists because killing on sight was wrong: this banner is the
    // FRONT of agy's eligibility handshake, not its verdict. agy's own CLI log
    // shows the run authenticating fine (`OAuth: authenticated successfully`,
    // keyring token refreshed for another hour) and then retrying
    // `v1internal:loadCodeAssist` while the composer shows this notice. PortOS
    // killed the session 0.85–1.5s after the paste, so `streamGenerateContent`
    // was NEVER reached. Every agy CoS run from 2026-08-07 on died this way
    // (5/5, each in 3–5s), while the same account + model answered instantly
    // over `--print` and over a PTY whose eligibility was already warm.
    //
    // Two INDEPENDENT axes, easy to conflate — a signal sets each on its own:
    //   • `actionable` — must a HUMAN do something? (bad key ⇒ yes; this ⇒ no)
    //   • `graceMs`    — can a LIVE session profitably wait it out? A usage
    //     limit is equally self-resolving but resets in hours, so it stays at 0
    //     (fail now) while this waits.
    //
    // ── 2026-08-12 FOLLOW-UP: the wait had to become ACTIVE ──
    // A 60s PASSIVE window never once cleared, because the banner is agy's
    // REJECTION of the submission, not a spinner over an in-flight one: agy
    // discards the prompt, empties its composer and returns to its idle footer
    // (agent-1f08178b's raw.txt; confirmed on a live session parked at the
    // banner). With nothing in flight, the generation chrome the window watches
    // for cannot appear, so its only reachable outcome was expiry — a 60s pause
    // bolted in front of the same fail-over. The window now RE-SUBMITS the
    // prompt on a cadence (createSelfClearingSignalGate#takeResubmit in
    // ../tuiHandshake.js), which is what the vendor's own "try again shortly"
    // asks for, and fails over only once those retries are exhausted.
    //
    // Why 120s: with retries every 20s that is five real attempts rather than
    // one dead wait. The signal has its own bounded fail-over window, which is
    // the whole point of an immediate provider signal.
    graceMs: 120000,
    pattern: /We're finishing verifying your account eligibility\.\s*This usually takes a moment\. Please try again shortly\./i,
    // The banner sentence is distinctive, but it is not chrome-ONLY: it matches
    // anywhere in the stream, so an agent that merely quotes it (investigating
    // this very failure mode, `cat`-ing a prior run's output, a grep hit over
    // this file) used to bench a healthy provider for the full auth cooldown
    // across every subsequently dequeued task (#3631). Promote to provider
    // origin only when the banner opens its own line behind nothing but TUI
    // gutter decoration — the shape agy actually renders.
    structuredMarker: new RegExp(`${TUI_GUTTER_PREFIX}We're finishing verifying your account eligibility\\.`, 'im'),
    category: ERROR_CATEGORIES.AUTH_ERROR,
    message: 'Antigravity account eligibility is still being verified',
    suggestedFix: 'Antigravity account verification is still in progress — sidelining the provider briefly and retrying on a fallback.',
    actionable: false
  },
  {
    // Antigravity REFUSES a submission outright once the account's subscription
    // quota is spent: it paints the one-line banner above where the answer would
    // have gone, empties the composer, and returns to its idle footer. Nothing
    // further arrives — so the one-shot TUI runner's output-idle fallback fires
    // and finalizes the run as `idle-complete` SUCCESS with the repainted PROMPT
    // screen standing in for the response.
    //
    // That is worse than a lost run. On 2026-08-13 both attempts of a
    // `pipeline-judge-foundation` call died this way (90KB and 284KB of screen
    // scrape, `success: true`, `errorCategory: null`). The judge prompt carries a
    // JSON output-contract example — `{ "score": 6, "gap": "string", "fix":
    // "string" }` — so the judge parsed the placeholder rubric back out of its own
    // echoed instructions, the shape guard rejected it (correctly), and the series
    // autopilot died reporting "foundation judge response parsed but its rubric is
    // incomplete or contains placeholders": a manuscript-shaped error for what was
    // purely a spent provider quota.
    //
    // USAGE_LIMIT, not AUTH_ERROR: the account and the PortOS config are both
    // fine. `actionable: false` (unlike the extra-usage entry below) because the
    // banner states its own reset — blocking the task would strand an unattended
    // run over a condition that needs no human and that a fallback provider can
    // serve right now (see agentErrorAnalysis#resolveFailedTaskDecision).
    // `graceMs` stays 0: hours is far past what a live session can wait out.
    //
    // `structuredMarker` mirrors the pattern rather than loosening it — the point
    // here is the untrusted-slice-boundary guard in resolveSignalOrigin, so a
    // `^` match fabricated by the rolling window fails the run without benching a
    // healthy provider.
    pattern: new RegExp(AGY_QUOTA_BANNER, 'im'),
    structuredMarker: new RegExp(AGY_QUOTA_BANNER, 'im'),
    category: ERROR_CATEGORIES.USAGE_LIMIT,
    message: 'Antigravity subscription quota reached',
    suggestedFix: 'Antigravity subscription quota is spent until it resets — sidelining the provider and retrying on a fallback.',
    actionable: false
  },
  {
    // No `structuredMarker`: this pattern has no loose alternative to gate. It
    // already requires the vendor-branded status line to OWN a whole line, so a
    // quoted mention inside surrounding agent output never matches in the first
    // place and the provider is left available (#3631).
    pattern: /^\s*(?:\[stderr\]\s*)?Now using extra usage\s*(?:\r?\n|$)/im,
    category: ERROR_CATEGORIES.USAGE_LIMIT,
    message: 'Provider switched to extra usage',
    suggestedFix: 'Provider usage limit reached. Using fallback provider or wait for limit reset.'
  }
];

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

// A non-printing, non-line-terminator byte prefixed to a buffer whose index 0 is
// a slice boundary rather than a witnessed line start, so a `^…/m` pattern
// cannot match there. Full rationale on resolveSignalOrigin below.
const UNTRUSTED_BOUNDARY = '\x00';

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

/**
 * Detect a LOCAL inference runtime that ran out of accelerator memory
 * mid-request (see LOCAL_RUNTIME_OOM_PATTERN for the observed shape).
 *
 * Deliberately NOT an entry in IMMEDIATE_FALLBACK_SIGNALS, for the same reason
 * detectTerminalModelError is kept out of it: that list is consulted by every
 * TUI/CLI spawn path, and a `graceMs` entry there would arm the self-clearing
 * gate in the ONE-SHOT runner too — where a false "recovered" latch finalizes a
 * run as a success that scraped the error screen. This failure needs a
 * different remedy anyway. The provider did not REJECT the submission the way
 * agy's eligibility banner does; it accepted the turn and the device allocator
 * killed it, so the TUI session still holds the whole conversation and only
 * needs to be told to carry on — which is exactly what a human typing
 * `continue` did on 2026-08-22 (agent-011d0c27, OpenCode on
 * `mtplx/mtplx-qwen38-27b-optimized-speed`). Re-sending the whole prompt, the
 * one thing the self-clearing gate knows how to do, would instead restart the
 * task on top of the work already done.
 *
 * Only `agentTuiSpawning` consults this, through `createOomNudgeGate`.
 *
 * @returns {object|null} an analysis in the same shape
 *   `detectImmediateFallbackSignal` returns, so the caller can hand it straight
 *   to its fail-over path once the nudges are spent.
 */
export function detectLocalRuntimeOom(text) {
  if (!text) return null;
  // `.test` rather than `.match`: only the yes/no matters, and the pattern
  // carries no `g` flag, so there is no `lastIndex` to leak between calls.
  if (!LOCAL_RUNTIME_OOM_PATTERN.test(String(text))) return null;
  return {
    hasError: true,
    // A FIXED sentence, deliberately not the vendor text that was matched.
    // This message becomes the run's error string, which becomes a failure
    // reason a CoS task description can go on to quote — and a TUI echoes a
    // pasted prompt back into this very detector. Quoting the vendor constant
    // here would let the signal re-match its own propagated message and nudge
    // (then fail) the agent dispatched to investigate it. agy's quota banner
    // solves the same problem with a lookahead; a fixed message is the simpler
    // answer when the analysis doesn't need the original text.
    category: ERROR_CATEGORIES.RESOURCE_EXHAUSTED,
    message: 'Local inference runtime ran out of GPU memory',
    waitTime: null,
    requiresFallback: true,
    // Nothing in PortOS config is wrong and nobody has to fix anything: the
    // device was momentarily short of memory. Marking it actionable would BLOCK
    // the task (see agentErrorAnalysis#resolveFailedTaskDecision) over a
    // condition a fallback provider can serve right now.
    actionable: false,
    graceMs: 0,
    suggestedFix: 'The local inference runtime ran out of GPU memory. Retry once the device drains, shrink the context/KV cache, or run a smaller model.',
    // Genuine evidence about the provider host: this endpoint's GPU is short of
    // memory, so benching it briefly (RESOURCE_EXHAUSTED in
    // providerCooldown.js) routes the retry somewhere that can serve it.
    origin: 'provider',
  };
}

export function createLocalRuntimeOomDetector({ maxBuffer = 512 } = {}) {
  let buffer = '';
  const cap = Number.isFinite(maxBuffer) && maxBuffer > 0 ? maxBuffer : 512;

  return (chunk) => {
    if (!chunk) return null;
    buffer = `${buffer}${String(chunk)}`.slice(-cap);
    return detectLocalRuntimeOom(buffer);
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
// failing: on 2026-09-04 a Stage 3 review whose ~100K-token prefill outlived the
// harness's stream-idle window was cancelled and re-sent every 6 minutes, so the
// session sat at this banner for the run's whole lifetime while every reaper
// saw a busy TUI (agent-e057cca7). `createRetryStallGate` in tuiHandshake.js
// owns the "keeps failing" judgement; this only reads the banner.
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

export function extractWaitTime(text) {
  if (!text) return null;

  for (const pattern of WAIT_TIME_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      const timeStr = match.slice(1).filter(Boolean).join(' ').trim();
      if (timeStr && timeStr !== ' ') {
        return timeStr;
      }
    }
  }

  const generalMatch = text.match(/(\d+)\s*(day|hour|min|sec)(?:ute)?(?:s)?/gi);
  if (generalMatch) {
    return generalMatch.join(' ');
  }

  return null;
}

export function analyzeError(errorText, exitCode = null) {
  if (!errorText && exitCode === 0) {
    return {
      hasError: false,
      category: null,
      message: null,
      waitTime: null,
      requiresFallback: false,
      actionable: false,
      suggestedFix: null
    };
  }

  const text = String(errorText || '');

  for (const errorPattern of ERROR_PATTERNS) {
    if (errorPattern.pattern.test(text)) {
      return {
        hasError: true,
        category: errorPattern.category,
        message: extractErrorMessage(text),
        waitTime: errorPattern.extractWaitTime ? extractWaitTime(text) : null,
        requiresFallback: errorPattern.requiresFallback,
        actionable: errorPattern.actionable,
        suggestedFix: errorPattern.suggestedFix
      };
    }
  }

  if (exitCode !== 0 && exitCode !== null) {
    return {
      hasError: true,
      category: ERROR_CATEGORIES.UNKNOWN,
      message: extractErrorMessage(text) || `Process exited with code ${exitCode}`,
      waitTime: null,
      requiresFallback: false,
      actionable: false,
      suggestedFix: null
    };
  }

  return {
    hasError: false,
    category: null,
    message: null,
    waitTime: null,
    requiresFallback: false,
    actionable: false,
    suggestedFix: null
  };
}

/**
 * Resolve the provenance origin for a matched IMMEDIATE_FALLBACK_SIGNAL (#3631).
 * Returns `'provider'` only when the signal declares no `structuredMarker` (its
 * pattern is chrome-only on its own) or that marker appears in the text;
 * otherwise `'output-scan'` — a genuine failure that still requires a fallback,
 * but not evidence the provider is unhealthy.
 *
 * The marker is tested against the WHOLE buffered text rather than the matched
 * substring, mirroring `resolvePatternOrigin` in `agentErrorAnalysis.js`: a
 * pattern returns its LEFTMOST match, which may be a quoted mention even when
 * the real banner arrives later in the same buffer.
 *
 * `lineStartTrusted: false` says index 0 of the text is a slice boundary rather
 * than a real line start (the streaming detector keeps only a trailing window).
 * A marker anchored with `^…/m` matches a slice boundary too, so a quoted
 * banner whose line prefix fell out of the window would be promoted — the very
 * false-bench this gate exists to prevent. An untrusted boundary is therefore
 * disqualified by prefixing a non-printing, non-line-terminator byte: every
 * line start the buffer actually witnessed (JS `^…/m` honors a bare `\r` too,
 * which is how a repainted TUI screen advances) still promotes, and nothing is
 * discarded. Pure.
 */
function resolveSignalOrigin(signal, text, lineStartTrusted) {
  if (!signal.structuredMarker) return 'provider';
  const value = text || '';
  return signal.structuredMarker.test(lineStartTrusted ? value : `${UNTRUSTED_BOUNDARY}${value}`)
    ? 'provider'
    : 'output-scan';
}

export function detectImmediateFallbackSignal(text, { lineStartTrusted = true } = {}) {
  if (!text) return null;
  const value = String(text);

  for (const signal of IMMEDIATE_FALLBACK_SIGNALS) {
    const match = value.match(signal.pattern);
    if (!match) continue;

    const line = match[0].trim();
    return {
      hasError: true,
      category: signal.category,
      message: line || signal.message,
      waitTime: extractWaitTime(value),
      requiresFallback: true,
      // Signals are actionable-by-default (a human has to do something); a
      // signal opts out when the provider says the condition clears on its own.
      actionable: signal.actionable !== false,
      // How long a consumer holding a LIVE session should hold it open for this
      // condition to clear before failing over. 0 (the default) = fail now, which
      // is every signal except a transient provider handshake. Always a number so
      // consumers branch on `> 0` without an `undefined` check. See the
      // account-eligibility entry for why this is a duration and not a boolean.
      graceMs: Number.isFinite(signal.graceMs) && signal.graceMs > 0 ? signal.graceMs : 0,
      suggestedFix: signal.suggestedFix,
      // Provider CHROME benches the provider host-side; text the agent itself
      // could have printed must not (#3631). See resolveSignalOrigin.
      origin: resolveSignalOrigin(signal, value, lineStartTrusted)
    };
  }

  return null;
}

export function createImmediateFallbackSignalDetector({ maxBuffer = 512 } = {}) {
  let buffer = '';
  // Once the window has dropped anything, buffer[0] is a slice boundary, not a
  // line start — provenance must stop trusting it (see resolveSignalOrigin).
  let truncated = false;
  const cap = Number.isFinite(maxBuffer) && maxBuffer > 0 ? maxBuffer : 512;

  return (chunk) => {
    if (!chunk) return null;
    const next = `${buffer}${String(chunk)}`;
    if (next.length > cap) truncated = true;
    buffer = next.slice(-cap);
    return detectImmediateFallbackSignal(buffer, { lineStartTrusted: !truncated });
  };
}

// Undo JSON string escaping in a value lifted out of a raw error BODY. One pass,
// so an escaped backslash can't be re-read as the start of the next escape
// (`C:\\ntemp` stays a path, not a newline). Only the `json: true` patterns
// below use it — a plain `Error: …` line is literal text, and unescaping it
// would rewrite a Windows path.
const JSON_STRING_ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
const unescapeJsonString = (value) =>
  value.replace(/\\(.)/g, (_, ch) => JSON_STRING_ESCAPES[ch] ?? ch);

function extractErrorMessage(text) {
  if (!text) return '';

  const patterns = [
    { re: /Error:\s*(.+?)(?:\n|$)/i },
    // A JSON error body routinely ESCAPES quotes inside the value — Ollama
    // reports `{"error":"\"all-minilm:latest\" does not support chat"}`. A
    // `[^"]+` value stops at that first escaped quote and returns a lone
    // backslash as "the message", which is what a log line and an investigation
    // task then carried instead of the actual sentence. Consume escape pairs.
    { re: /error":\s*"((?:[^"\\]|\\.)+)"/i, json: true },
    { re: /message":\s*"((?:[^"\\]|\\.)+)"/i, json: true },
    { re: /failed:\s*(.+?)(?:\n|$)/i }
  ];

  for (const { re, json } of patterns) {
    const match = text.match(re);
    if (match) {
      return (json ? unescapeJsonString(match[1]) : match[1]).trim();
    }
  }

  const lines = text.split('\n').filter(line => line.trim());
  return lines[0]?.substring(0, 200) || text.substring(0, 200);
}

export function isRateLimitStatus(statusCode) {
  return statusCode === 429;
}

export function isAuthErrorStatus(statusCode) {
  return statusCode === 401 || statusCode === 403;
}

const RATE_LIMIT_HEADER_NAMES = {
  retryAfter: ['retry-after'],
  reset: ['ratelimit-reset', 'rate-limit-reset', 'x-ratelimit-reset', 'x-rate-limit-reset', 'x-ratelimit-reset-requests', 'anthropic-ratelimit-requests-reset'],
  remaining: ['ratelimit-remaining', 'rate-limit-remaining', 'x-ratelimit-remaining', 'x-rate-limit-remaining', 'x-ratelimit-remaining-requests', 'anthropic-ratelimit-requests-remaining'],
  limit: ['ratelimit-limit', 'rate-limit-limit', 'x-ratelimit-limit', 'x-rate-limit-limit', 'x-ratelimit-limit-requests', 'anthropic-ratelimit-requests-limit'],
};
const MAX_RATE_LIMIT_HEADER_LENGTH = 128;
const MAX_RATE_LIMIT_HEADER_DELAY_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RATE_LIMIT_COUNT = 1_000_000_000;

const readAllowedHeader = (headers, names) => {
  for (const name of names) {
    const value = typeof headers?.get === 'function'
      ? headers.get(name)
      : Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name)?.[1];
    if (value != null) {
      const normalized = String(value).trim();
      if (normalized) return normalized;
    }
  }
  return null;
};

const parseRateLimitCount = (value) => {
  if (!value || value.length > MAX_RATE_LIMIT_HEADER_LENGTH || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= MAX_RATE_LIMIT_COUNT ? parsed : null;
};

const parseRetryAfter = (value, now) => {
  if (!value || value.length > MAX_RATE_LIMIT_HEADER_LENGTH) return null;
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const delay = Math.ceil(Number(value) * 1000);
    return Number.isSafeInteger(delay) && delay >= 0 && delay <= MAX_RATE_LIMIT_HEADER_DELAY_MS ? delay : null;
  }
  const at = Date.parse(value);
  const delay = at - now;
  return Number.isFinite(at) && delay >= 0 && delay <= MAX_RATE_LIMIT_HEADER_DELAY_MS ? delay : null;
};

const parseResetAt = (value, now) => {
  if (!value || value.length > MAX_RATE_LIMIT_HEADER_LENGTH) return null;
  let at;
  if (/^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/i.test(value)) {
    const units = { ms: 1, s: 1000, m: 60000, h: 3600000 };
    const delay = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/gi)]
      .reduce((total, match) => total + (Number(match[1]) * units[match[2].toLowerCase()]), 0);
    at = now + delay;
  } else if (/^\d+(?:\.\d+)?$/.test(value)) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) return null;
    if (numeric >= 1e12) at = numeric;
    else if (numeric >= 1e9) at = numeric * 1000;
    else at = now + (numeric * 1000);
  } else {
    at = Date.parse(value);
  }
  const delay = at - now;
  return Number.isFinite(at) && delay >= 0 && delay <= MAX_RATE_LIMIT_HEADER_DELAY_MS
    ? new Date(at).toISOString()
    : null;
};

/**
 * Normalize the small, explicit set of upstream rate-limit headers PortOS may
 * persist. Raw names/values never leave this boundary.
 */
export function normalizeRateLimitHeaders(headers, { now = Date.now() } = {}) {
  if (!headers) return null;
  const retryAfterMs = parseRetryAfter(readAllowedHeader(headers, RATE_LIMIT_HEADER_NAMES.retryAfter), now);
  const resetAt = parseResetAt(readAllowedHeader(headers, RATE_LIMIT_HEADER_NAMES.reset), now);
  const remaining = parseRateLimitCount(readAllowedHeader(headers, RATE_LIMIT_HEADER_NAMES.remaining));
  const limit = parseRateLimitCount(readAllowedHeader(headers, RATE_LIMIT_HEADER_NAMES.limit));
  if (retryAfterMs == null && resetAt == null && remaining == null && limit == null) return null;
  return {
    observedAt: new Date(now).toISOString(),
    ...(retryAfterMs != null ? { retryAfterMs } : {}),
    ...(resetAt ? { resetAt } : {}),
    ...(remaining != null ? { remaining } : {}),
    ...(limit != null ? { limit } : {}),
  };
}

export function analyzeHttpError(response) {
  const { status, statusText, body, headers } = response;
  const rateLimitWindow = normalizeRateLimitHeaders(headers);

  if (status >= 200 && status < 300) {
    return {
      hasError: false,
      category: null,
      message: null,
      waitTime: null,
      requiresFallback: false,
      actionable: false,
      suggestedFix: null
    };
  }

  if (isRateLimitStatus(status)) {
    return {
      hasError: true,
      category: ERROR_CATEGORIES.RATE_LIMIT,
      message: `Rate limit exceeded (${status})`,
      waitTime: extractWaitTime(body),
      rateLimitWindow,
      requiresFallback: false,
      actionable: false,
      suggestedFix: 'Wait and retry - temporary rate limiting'
    };
  }

  if (isAuthErrorStatus(status)) {
    return {
      hasError: true,
      category: ERROR_CATEGORIES.AUTH_ERROR,
      message: `Authentication failed (${status})`,
      waitTime: null,
      requiresFallback: true,
      actionable: true,
      suggestedFix: 'Check API key configuration for this provider'
    };
  }

  if (body) {
    // analyzeError returns `hasError: false` when no known pattern matches;
    // for a non-2xx response that's still a failure — preserve it as an
    // UNKNOWN HTTP error instead of letting the caller treat it as success.
    const bodyAnalysis = analyzeError(body);
    if (bodyAnalysis.hasError) return { ...bodyAnalysis, rateLimitWindow };
  }

  return {
    hasError: true,
    category: ERROR_CATEGORIES.UNKNOWN,
    // Status 0 is PortOS's sentinel for "no HTTP response" (a fetch rejection
    // or a failed provider-readiness hook). Preserve that transport detail;
    // calling it `HTTP 0` discards the only useful diagnosis and HTTP has no
    // status zero in the first place.
    message: statusText || (status === 0 && body ? extractErrorMessage(String(body)) : `HTTP ${status}`),
    waitTime: null,
    requiresFallback: false,
    actionable: false,
    suggestedFix: null
  };
}
