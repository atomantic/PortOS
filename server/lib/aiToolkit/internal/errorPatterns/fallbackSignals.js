/** Detect provider fallback signals and Claude session-limit banners in streaming output. */
import { ERROR_CATEGORIES, UNTRUSTED_BOUNDARY } from './categories.js';
import { extractWaitTime } from './rateLimits.js';

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
    // The eligibility banner rejects the submission while the account handshake
    // is running. The host must resubmit periodically until it clears. A passive
    // wait cannot make progress because the composer has discarded the prompt.
    // At 20-second intervals the window allows five attempts before failover.
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

// Claude Code's session-limit banner is distinct from the separate
// `Now using extra usage` status. Only the interactive CLI can invoke the
// hidden `/low-priority` command; this detector is consumed by the CoS TUI
// runner after the submitted prompt's own screen reports its session limit.
// Keep the match line-anchored and vendor-specific so quoted task text does not
// opt an agent into another usage mode.
const CLAUDE_SESSION_LIMIT_BANNER = /^[ \t│┃╎]*(?:⎿|⏺)[ \t]*You've hit your session limit\b/im;

export function detectClaudeSessionLimitBanner(text, { lineStartTrusted = true } = {}) {
  if (!text) return null;
  const value = String(text);
  const candidate = lineStartTrusted ? value : `${UNTRUSTED_BOUNDARY}${value}`;
  if (!CLAUDE_SESSION_LIMIT_BANNER.test(candidate)) return null;
  return {
    hasError: true,
    category: ERROR_CATEGORIES.USAGE_LIMIT,
    message: 'Claude Code session usage limit reached',
    waitTime: extractWaitTime(value),
    requiresFallback: true,
    actionable: false,
    graceMs: 0,
    suggestedFix: 'Claude Code session usage limit reached; continue with the configured fallback or wait for the reset.',
    origin: 'provider',
  };
}

export function createClaudeSessionLimitBannerDetector({ maxBuffer = 1024 } = {}) {
  let line = '';
  let lineStartTrusted = true;
  let lineMatched = false;
  const cap = Number.isFinite(maxBuffer) && maxBuffer > 0 ? maxBuffer : 1024;

  return (chunk) => {
    if (!chunk) return null;
    const text = `${line}${String(chunk)}`;
    const lines = text.split('\n');
    let found = null;
    for (let i = 0; i < lines.length - 1; i += 1) {
      if (!lineMatched) {
        const analysis = detectClaudeSessionLimitBanner(lines[i].replace(/\r$/, ''), { lineStartTrusted });
        if (analysis) {
          found ||= analysis;
          lineMatched = true;
        }
      }
      lineStartTrusted = true;
      lineMatched = false;
    }
    line = lines.at(-1);
    if (line.length > cap) {
      line = line.slice(-cap);
      lineStartTrusted = false;
    }
    if (!lineMatched) {
      const analysis = detectClaudeSessionLimitBanner(line, { lineStartTrusted });
      if (analysis) {
        found ||= analysis;
        lineMatched = true;
      }
    }
    return found;
  };
}

// A short pause lets Claude Code process its TUI mode command before the
// rejected request is pasted again.
export const CLAUDE_LOW_PRIORITY_RESUBMIT_DELAY_MS = 1500;
