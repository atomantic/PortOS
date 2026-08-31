import { describe, it, expect } from 'vitest';
import {
  analyzeError,
  analyzeHttpError,
  normalizeRateLimitHeaders,
  createImmediateFallbackSignalDetector,
  createTerminalModelErrorDetector,
  createLocalRuntimeOomDetector,
  createTerminalRequestTimeoutDetector,
  detectImmediateFallbackSignal,
  detectLocalRuntimeOom,
  detectTerminalModelError,
  detectTerminalRequestTimeout,
  extractWaitTime,
  isRunCanceledError,
  ERROR_CATEGORIES
} from './errorDetection.js';

// The banner line agy paints where a spent-quota answer would have gone,
// ANSI-stripped exactly as captured from the runs that killed a series-autopilot
// foundation gate on 2026-08-13. Real chrome always pairs it with an
// `Error ID: <uuid>-<n>` line, which the signal requires but does not capture.
const QUOTA_BANNER_LINE = '⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 3h51m14s.';

describe('Error Detection', () => {
  describe('analyzeError', () => {
    it('detects a Codex/OpenAI content-safety refusal', () => {
      const result = analyzeError(
        "Invalid prompt: we've limited access to this content for safety reasons. This type of information may be used to benefit or to harm people."
      );
      expect(result.hasError).toBe(true);
      expect(result.category).toBe(ERROR_CATEGORIES.CONTENT_REFUSAL);
      expect(result.requiresFallback).toBe(true);
      expect(result.actionable).toBe(false);
    });

    it('detects an Anthropic refusal stop reason', () => {
      const result = analyzeError('{"stop_reason":"refusal"}');
      expect(result.category).toBe(ERROR_CATEGORIES.CONTENT_REFUSAL);
    });

    it('does not misclassify a generic failure as a refusal', () => {
      const result = analyzeError('Process exited with code 1', 1);
      expect(result.category).toBe(ERROR_CATEGORIES.UNKNOWN);
    });

    // A local daemon rejecting an OPERATION the model cannot perform. Untriaged
    // this landed in UNKNOWN, which is not request-specific: one bad model id
    // benched the whole Ollama provider (taking every OTHER model on it offline)
    // and raised a Tier-4 investigation task for a failure fully determined by
    // the model id.
    it('classifies an Ollama embedding model asked to chat, message intact', () => {
      const result = analyzeError('Ollama returned 400: {"error":"\\"all-minilm:latest\\" does not support chat"}', 1);
      expect(result.hasError).toBe(true);
      expect(result.category).toBe(ERROR_CATEGORIES.MODEL_NOT_FOUND);
      expect(result.requiresFallback).toBe(true);
      expect(result.actionable).toBe(true);
      // The escaped quotes in the JSON body must not eat the message.
      expect(result.message).toBe('"all-minilm:latest" does not support chat');
    });

    it('detects the unquoted and other-operation forms too', () => {
      for (const text of [
        'Ollama returned 400: {"error":"nomic-embed-text:latest does not support chat"}',
        '{"error":"smollm:135m does not support tools"}',
        "'gemma4:e4b' does not support insert",
      ]) {
        expect(analyzeError(text, 1).category, text).toBe(ERROR_CATEGORIES.MODEL_NOT_FOUND);
      }
    });

    it('leaves an unrelated unsupported-feature line in the unknown bucket', () => {
      expect(analyzeError('Note: this API does not support streaming yet.', 1).category)
        .toBe(ERROR_CATEGORIES.UNKNOWN);
    });

    it('should detect rate limit errors', () => {
      const result = analyzeError('API Error: 429 Too Many Requests');
      expect(result.hasError).toBe(true);
      expect(result.category).toBe(ERROR_CATEGORIES.RATE_LIMIT);
      expect(result.requiresFallback).toBe(false);
    });

    it('should detect rate limit from "rate limit" text', () => {
      const result = analyzeError('Rate limit exceeded. Please try again later.');
      expect(result.hasError).toBe(true);
      expect(result.category).toBe(ERROR_CATEGORIES.RATE_LIMIT);
    });

    it('should detect usage limit errors', () => {
      const result = analyzeError("You've hit your usage limit. Upgrade to Pro or try again in 1 day 1 hour 33 minutes");
      expect(result.hasError).toBe(true);
      expect(result.category).toBe(ERROR_CATEGORIES.USAGE_LIMIT);
      expect(result.requiresFallback).toBe(true);
    });

    it('should detect Claude Code rolling session limits reported as monthly spend', () => {
      const result = analyzeError("You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message · your session limit resets 7:15am (UTC)", 1);
      expect(result.hasError).toBe(true);
      expect(result.category).toBe(ERROR_CATEGORIES.USAGE_LIMIT);
      expect(result.requiresFallback).toBe(true);
    });

    it('should detect Claude extra-usage status as a usage limit', () => {
      const result = analyzeError('Now using extra usage');
      expect(result.hasError).toBe(true);
      expect(result.category).toBe(ERROR_CATEGORIES.USAGE_LIMIT);
      expect(result.requiresFallback).toBe(true);
    });

    // The post-hoc scan a failed run runs through analyzeError must reach the
    // same verdict as the in-stream signal, or the provider is never benched and
    // the next dequeued call re-dies on the same spent quota.
    it('should detect the Antigravity spent-quota banner as a usage limit', () => {
      const result = analyzeError('⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 3h51m14s.', 1);
      expect(result.hasError).toBe(true);
      expect(result.category).toBe(ERROR_CATEGORIES.USAGE_LIMIT);
      expect(result.requiresFallback).toBe(true);
    });

    it('should not detect ordinary prose about extra usage as a usage limit', () => {
      const result = analyzeError('The report mentions extra usage in the appendix.', 1);
      expect(result.hasError).toBe(true);
      expect(result.category).toBe(ERROR_CATEGORIES.UNKNOWN);
    });

    it('should extract wait time from usage limit errors', () => {
      const result = analyzeError("You've hit your usage limit. Upgrade to Pro or try again in 1 day 1 hour 33 minutes");
      expect(result.waitTime).toBeTruthy();
      expect(result.waitTime).toContain('day');
    });

    it('should detect authentication errors', () => {
      const result = analyzeError('Error: 401 Unauthorized - Invalid API key');
      expect(result.hasError).toBe(true);
      expect(result.category).toBe(ERROR_CATEGORIES.AUTH_ERROR);
      expect(result.requiresFallback).toBe(true);
    });

    it('should detect model not found errors', () => {
      const result = analyzeError('Error: model "claude-9" does not exist');
      expect(result.hasError).toBe(true);
      expect(result.category).toBe(ERROR_CATEGORIES.MODEL_NOT_FOUND);
      expect(result.requiresFallback).toBe(true);
    });

    it('classifies a Bedrock "model identifier is invalid" rejection as model-not-found', () => {
      const result = analyzeError('API Error (claude-opus-4-8): 400 The provided model identifier is invalid.. Try /model to switch to us.anthropic.claude-opus-4-1-20250805-v1:0.');
      expect(result.hasError).toBe(true);
      expect(result.category).toBe(ERROR_CATEGORIES.MODEL_NOT_FOUND);
      expect(result.requiresFallback).toBe(true);
    });

    it('classifies Ollama\'s "does not support chat" 400 as model-not-found', () => {
      // The everyday trigger is an embedding-only model reached through
      // /api/chat. It names no "model" token, so it used to fall through to
      // UNKNOWN — which benches a healthy daemon for a minute and escalates to a
      // tier-4 investigation instead of correcting the model (tier 1).
      const result = analyzeError('Ollama returned 400: {"error":"\\"nomic-embed-text:latest\\" does not support chat"}', 1);
      expect(result.hasError).toBe(true);
      expect(result.category).toBe(ERROR_CATEGORIES.MODEL_NOT_FOUND);
    });

    it('should detect network errors', () => {
      const result = analyzeError('Error: ECONNREFUSED 127.0.0.1:8080');
      expect(result.hasError).toBe(true);
      expect(result.category).toBe(ERROR_CATEGORIES.NETWORK_ERROR);
    });

    it('should detect timeout errors', () => {
      const result = analyzeError('Process timed out after 300000ms');
      expect(result.hasError).toBe(true);
      expect(result.category).toBe(ERROR_CATEGORIES.TIMEOUT);
    });

    it('should detect quota exceeded errors', () => {
      const result = analyzeError('Error: Billing quota exceeded. Please add credits.');
      expect(result.hasError).toBe(true);
      expect(result.category).toBe(ERROR_CATEGORIES.QUOTA_EXCEEDED);
      expect(result.requiresFallback).toBe(true);
    });

    it('should return unknown for unrecognized errors with exit code', () => {
      const result = analyzeError('Some unknown error occurred', 1);
      expect(result.hasError).toBe(true);
      expect(result.category).toBe(ERROR_CATEGORIES.UNKNOWN);
    });

    it('should return no error for success', () => {
      const result = analyzeError('', 0);
      expect(result.hasError).toBe(false);
      expect(result.category).toBeNull();
    });

    it('should handle null/undefined input', () => {
      const result = analyzeError(null, 0);
      expect(result.hasError).toBe(false);
    });
  });

  describe('detectImmediateFallbackSignal', () => {
    it('detects Antigravity account-eligibility blocks before an agent idles out', () => {
      const result = detectImmediateFallbackSignal(
        "We're finishing verifying your account eligibility. This usually takes a moment. Please try again shortly."
      );
      expect(result).toMatchObject({
        hasError: true,
        category: ERROR_CATEGORIES.AUTH_ERROR,
        requiresFallback: true,
        suggestedFix: expect.stringContaining('verification'),
        // The account is fine and no PortOS setting is wrong — Google is mid-
        // verification and says the condition clears itself. Actionable would
        // BLOCK the task (resolveFailedTaskDecision); provider origin is what
        // benches the provider so the retry resolves onto a fallback.
        actionable: false,
        origin: 'provider'
      });
    });

    // The banner is a repainted TUI screen, not a log: Antigravity emits the two
    // sentences on separate lines with a leading space from the erase-to-start
    // sequence. Fixture is the ANSI-STRIPPED shape observed in a real agy raw.txt
    // — the exact text the spawner's detector is fed.
    it('matches the banner as agy actually renders it (two lines, leading space)', () => {
      const rendered = "  ⎿  We're finishing verifying your account eligibility.\n This usually takes a moment. Please try again shortly.\r\n";
      expect(detectImmediateFallbackSignal(rendered)).toMatchObject({
        category: ERROR_CATEGORIES.AUTH_ERROR,
        actionable: false
      });
    });

    // #3631: the banner sentence matches anywhere in the stream, so an agent that
    // merely QUOTES it still fails its own run — but it must not be read as
    // evidence about the provider's health, or one such transcript benches a
    // healthy provider for every subsequently dequeued task.
    it.each([
      ['prose that quotes the banner', "The known failure mode is: We're finishing verifying your account eligibility. This usually takes a moment. Please try again shortly. — see errorDetection.js"],
      ['a grep hit over a prior run\'s transcript', "data/cos/agents/agent-1/output.txt:412:  ⎿  We're finishing verifying your account eligibility. This usually takes a moment. Please try again shortly."],
      ['a markdown bullet in an agent write-up', "- We're finishing verifying your account eligibility. This usually takes a moment. Please try again shortly.\n"],
    ])('marks a quoted eligibility banner as output-scan (%s)', (_label, transcript) => {
      const result = detectImmediateFallbackSignal(transcript);
      expect(result).toMatchObject({
        hasError: true,
        category: ERROR_CATEGORIES.AUTH_ERROR,
        // Still a real failure that routes to a fallback — just not provider chrome.
        requiresFallback: true,
        origin: 'output-scan'
      });
    });

    it('still promotes the banner when it opens its own line behind TUI gutter chrome', () => {
      const rendered = "reading the task brief…\n  ⎿  We're finishing verifying your account eligibility.\n This usually takes a moment. Please try again shortly.\r\n";
      expect(detectImmediateFallbackSignal(rendered)).toMatchObject({
        category: ERROR_CATEGORIES.AUTH_ERROR,
        origin: 'provider'
      });
    });

    // agentCliSpawning feeds stderr to the detector as `[stderr] ${text}`, so the
    // host tag lands BEFORE the CLI's own gutter glyphs — a genuine banner on
    // stderr must still bench.
    it('promotes the banner behind the host [stderr] tag and gutter chrome', () => {
      expect(detectImmediateFallbackSignal("[stderr]   ⎿  We're finishing verifying your account eligibility. This usually takes a moment. Please try again shortly.\n"))
        .toMatchObject({ origin: 'provider' });
    });

    // A truncated stream window starts mid-line, and `^…/m` matches that slice
    // boundary — so a quoted banner whose line prefix scrolled out of the window
    // must NOT be promoted (that is the false-bench this gate exists to stop).
    it('does not trust a slice boundary as a line start once the stream window has truncated', () => {
      const detect = createImmediateFallbackSignalDetector({ maxBuffer: 160 });
      detect(`${'x'.repeat(200)}: quoting the banner: `);
      const result = detect("We're finishing verifying your account eligibility. This usually takes a moment. Please try again shortly.");
      expect(result).toMatchObject({ category: ERROR_CATEGORIES.AUTH_ERROR, origin: 'output-scan' });
    });

    it('still promotes a gutter-rendered banner on its own line after the window truncated', () => {
      const detect = createImmediateFallbackSignalDetector({ maxBuffer: 200 });
      detect(`${'x'.repeat(300)}\n`);
      const result = detect("  ⎿  We're finishing verifying your account eligibility. This usually takes a moment. Please try again shortly.\n");
      expect(result).toMatchObject({ origin: 'provider' });
    });

    // A repainted TUI screen advances with a bare `\r` as often as a `\n`, and
    // JS `^…/m` treats both as line starts — a banner behind a carriage return
    // must still count as chrome.
    it('promotes a banner that starts after a bare carriage return', () => {
      const detect = createImmediateFallbackSignalDetector({ maxBuffer: 200 });
      detect(`${'x'.repeat(300)}\r`);
      expect(detect("⎿  We're finishing verifying your account eligibility. This usually takes a moment. Please try again shortly.\r"))
        .toMatchObject({ origin: 'provider' });
    });

    it('promotes a real banner that arrives later in a buffer whose earlier mention is quoted', () => {
      const transcript = "I will check whether We're finishing verifying your account eligibility. This usually takes a moment. Please try again shortly. is still firing.\n⎿  We're finishing verifying your account eligibility. This usually takes a moment. Please try again shortly.\n";
      expect(detectImmediateFallbackSignal(transcript)).toMatchObject({ origin: 'provider' });
    });

    it('buffers an Antigravity account-eligibility block across stream chunks', () => {
      const detect = createImmediateFallbackSignalDetector();
      expect(detect("We're finishing verifying your account eligibility. This usually ")).toBeNull();
      expect(detect('takes a moment. Please try again shortly.')).toMatchObject({
        category: ERROR_CATEGORIES.AUTH_ERROR,
        requiresFallback: true
      });
    });

    // The banner is the FRONT of agy's eligibility handshake, not its verdict —
    // a consumer holding a live session must wait it out rather than kill on
    // sight (see the signal's canonical comment for the 5/5 run-loss incident).
    it('gives the eligibility banner a grace window instead of an immediate kill', () => {
      expect(detectImmediateFallbackSignal(
        "We're finishing verifying your account eligibility. This usually takes a moment. Please try again shortly."
      )).toMatchObject({ graceMs: 120000 });
    });

    // `actionable` and `graceMs` are independent axes: a usage limit is equally
    // self-resolving, but it resets in hours — no live session can wait it out.
    it('leaves other signals at graceMs 0 so they still fail immediately', () => {
      expect(detectImmediateFallbackSignal('Now using extra usage\n')).toMatchObject({ graceMs: 0 });
    });

    // agy paints this INSTEAD of an answer and then goes quiet, so the one-shot
    // TUI runner idle-completes the run as SUCCESS and hands the repainted
    // prompt screen downstream as the model's response. Fixture is the
    // ANSI-stripped shape captured from the runs that killed a series-autopilot
    // foundation gate on 2026-08-13.
    it('detects the Antigravity spent-quota banner', () => {
      const rendered = `  \`\`\`\r\n\n${QUOTA_BANNER_LINE}\r\nError ID: 00000000-0000-4000-8000-000000000000-7\r\n`;
      expect(detectImmediateFallbackSignal(rendered)).toMatchObject({
        hasError: true,
        category: ERROR_CATEGORIES.USAGE_LIMIT,
        requiresFallback: true,
        origin: 'provider',
        // The banner names its own reset — no human has to do anything, and a
        // fallback provider can serve the call right now. Blocking the task
        // (resolveFailedTaskDecision) would strand an unattended run.
        actionable: false,
        // …but hours is far longer than a live session can profitably hold, so
        // unlike the eligibility handshake this one fails over immediately.
        graceMs: 0
      });
    });

    it('carries the reset clause into the message so /runs shows when the quota frees up', () => {
      expect(detectImmediateFallbackSignal(`${QUOTA_BANNER_LINE}\r\nError ID: 00000000-0000-4000-8000-000000000000-7\r\n`).message)
        .toContain('Resets in 3h51m14s');
    });

    // The message becomes the run's error → the autopilot's failure reason → the
    // body of the CoS task dispatched to investigate it, which a TUI echoes back
    // indented (i.e. behind nothing but whitespace). If the signal matched its own
    // propagated message it would kill that investigating agent on sight — which
    // is why the `Error ID:` envelope is required but held OUT of the capture.
    it('does not match the message it propagates, echoed back as prompt text', () => {
      const propagated = detectImmediateFallbackSignal(`${QUOTA_BANNER_LINE}\r\nError ID: abc-7\r\n`).message;
      expect(detectImmediateFallbackSignal(`### Context\n  ${propagated}\n`)).toBeNull();
    });

    it('detects the quota banner without its optional reset clause', () => {
      expect(detectImmediateFallbackSignal('⚠ Individual quota reached. Please upgrade your subscription to increase your limits.\nError ID: abc-7\n'))
        .toMatchObject({ category: ERROR_CATEGORIES.USAGE_LIMIT, origin: 'provider' });
    });

    // Line-anchored behind gutter decoration only: an agent WRITING ABOUT the
    // banner must not fail its own run, let alone bench a healthy provider.
    it.each([
      ['a markdown bullet in an agent write-up', `- ${QUOTA_BANNER_LINE}\nError ID: abc-7\n`],
      ['prose quoting the banner', `The failure mode is "${QUOTA_BANNER_LINE}" — see errorDetection.js`],
      ['a grep hit over a prior transcript', `data/runs/abc/output.txt:412: ${QUOTA_BANNER_LINE}\nError ID: abc-7\n`],
      ['the banner with no agy error envelope behind it', `${QUOTA_BANNER_LINE}\nsome other line\n`],
    ])('ignores a quoted quota banner (%s)', (_label, transcript) => {
      expect(detectImmediateFallbackSignal(transcript)).toBeNull();
    });

    it('buffers the quota banner across stream chunks', () => {
      const detect = createImmediateFallbackSignalDetector();
      expect(detect('⚠ Individual quota reached. Please upgrade your ')).toBeNull();
      // The envelope line lands in a later repaint than the banner itself.
      expect(detect('subscription to increase your limits. Resets in 3h51m14s.\r\n')).toBeNull();
      expect(detect('Error ID: 00000000-0000-4000-8000-000000000000-7\r\n'))
        .toMatchObject({ category: ERROR_CATEGORIES.USAGE_LIMIT, origin: 'provider' });
    });

    // The rolling window's slice boundary matches `^…/m` too. The run still
    // fails (its screen scrape is not an answer either way), but a fabricated
    // line start must not be read as evidence about the provider's health.
    it('does not promote a quota banner whose line start was fabricated by the window slice', () => {
      // Size the window so the slice lands EXACTLY on the banner's first
      // character: buffer[0] then looks like a line start the stream never
      // witnessed, which is the only way `^…/m` can fire on quoted text.
      const quoted = 'Individual quota reached. Please upgrade your subscription to increase your limits.\nError ID: abc-7\n';
      const detect = createImmediateFallbackSignalDetector({ maxBuffer: quoted.length });
      expect(detect(`while investigating I saw ${quoted}`))
        .toMatchObject({ category: ERROR_CATEGORIES.USAGE_LIMIT, origin: 'output-scan' });
    });

    it('detects the Claude extra-usage status line', () => {
      const result = detectImmediateFallbackSignal('Now using extra usage');
      expect(result).toMatchObject({
        hasError: true,
        category: ERROR_CATEGORIES.USAGE_LIMIT,
        requiresFallback: true
      });
      // Signals stay actionable-by-default; only a signal the provider says
      // clears itself opts out.
      expect(result.actionable).toBe(true);
    });

    it('stamps the real extra-usage status line as provider chrome', () => {
      expect(detectImmediateFallbackSignal('Now using extra usage\n')).toMatchObject({ origin: 'provider' });
    });

    it('does not match quoted prompt text in the middle of a line', () => {
      const result = detectImmediateFallbackSignal('The failure condition is "Now using extra usage".');
      expect(result).toBeNull();
    });

    it('does not match a line that only starts with the status text', () => {
      const result = detectImmediateFallbackSignal('Now using extra usage examples in docs\n');
      expect(result).toBeNull();
    });

    it('buffers the status line across stream chunks', () => {
      const detect = createImmediateFallbackSignalDetector();
      expect(detect('Now using extra ')).toBeNull();
      const result = detect('usage\n');
      expect(result).toMatchObject({
        category: ERROR_CATEGORIES.USAGE_LIMIT,
        requiresFallback: true
      });
    });

    it('does NOT catch a terminal model-id rejection — that is scoped to the one-shot TUI runner, not the shared detector the agent paths use', () => {
      // The agent spawn paths route arbitrary agent output through this shared
      // detector; a model-id rejection must NOT fire here (it lives in
      // detectTerminalModelError, consulted only by tuiPromptRunner).
      expect(detectImmediateFallbackSignal('⏺ API Error (claude-opus-4-8): 400 The provided model identifier is invalid.')).toBeNull();
    });
  });

  describe('detectTerminalModelError', () => {
    it('detects Claude Code\'s terminal "model identifier is invalid" (Bedrock 400) error line', () => {
      const result = detectTerminalModelError('⏺ API Error (claude-opus-4-8): 400 The provided model identifier is invalid.. Try /model to switch to us.anthropic.claude-opus-4-1-20250805-v1:0.');
      expect(result).toMatchObject({
        hasError: true,
        category: ERROR_CATEGORIES.MODEL_NOT_FOUND,
        requiresFallback: true
      });
    });

    it('detects an Anthropic 404 not_found_error model rejection', () => {
      const result = detectTerminalModelError('API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-9"}}');
      expect(result).toMatchObject({
        hasError: true,
        category: ERROR_CATEGORIES.MODEL_NOT_FOUND,
        requiresFallback: true
      });
    });

    it('does NOT fire on a recoverable 429/500 (Claude Code auto-retries those)', () => {
      expect(detectTerminalModelError('⏺ API Error (claude-opus-4-8): 429 rate limited, retrying…')).toBeNull();
      expect(detectTerminalModelError('⏺ API Error (claude-opus-4-8): 500 internal server error, retrying…')).toBeNull();
    });

    it('does NOT fire on an agent merely printing the phrase without the API Error prefix', () => {
      expect(detectTerminalModelError('The Bedrock backend says the model identifier is invalid when you pass a bare id.')).toBeNull();
    });

    it('does NOT fire on a full error line quoted mid-sentence in prose (line-anchored)', () => {
      expect(detectTerminalModelError('I fixed the `API Error (claude-opus-4-8): 400 The provided model identifier is invalid` bug in the runner.')).toBeNull();
    });

    it('does NOT fire on a retryable 429 line that incidentally contains 404 (status anchored to the prefix)', () => {
      expect(detectTerminalModelError('API Error: 429 too many requests for the 404 page not found endpoint')).toBeNull();
    });

    it('buffers the error line across stream chunks', () => {
      const detect = createTerminalModelErrorDetector();
      expect(detect('⏺ API Error (claude-opus-4-8): 400 The provided ')).toBeNull();
      const result = detect('model identifier is invalid.\n');
      expect(result).toMatchObject({ category: ERROR_CATEGORIES.MODEL_NOT_FOUND, requiresFallback: true });
    });
  });

  describe('detectTerminalRequestTimeout', () => {
    it('detects Claude Code exhausting all internal request retries', () => {
      expect(detectTerminalRequestTimeout('  ⎿\u00a0Requesttimedout\n')).toMatchObject({
        category: ERROR_CATEGORIES.TIMEOUT,
        requiresFallback: true,
        actionable: false,
        exitCode: 124,
      });
    });

    it('does not interrupt an in-progress internal retry', () => {
      expect(detectTerminalRequestTimeout('⎿ Request timed out · Retrying in 38s · attempt 9/10\n')).toBeNull();
    });

    it('does not treat generated prose mentioning a timeout as provider chrome', () => {
      expect(detectTerminalRequestTimeout('The report says the request timed out before the retry.')).toBeNull();
    });

    it('buffers the terminal banner across stream chunks', () => {
      const detect = createTerminalRequestTimeoutDetector();
      expect(detect('  ⎿ Request')).toBeNull();
      expect(detect(' timed out\n')).toMatchObject({
        category: ERROR_CATEGORIES.TIMEOUT,
        exitCode: 124,
      });
    });

    // #3715 — the whole-banner cases above all pass with a `$`-terminated
    // pattern too. What broke in production was the SPLIT: the buffered
    // detector re-tests a rolling buffer whose end is the newest byte, so
    // "line so far ends at 'Request timed out'" looked exactly like a finished
    // line and killed a run that was still happily retrying.
    it('does NOT fire when a PTY chunk boundary lands right after "Request timed out"', () => {
      const detect = createTerminalRequestTimeoutDetector();
      expect(detect('  ⎿ Request timed out')).toBeNull();
    });

    it('discards a split candidate that the next chunk completes into a retry banner', () => {
      const detect = createTerminalRequestTimeoutDetector();
      expect(detect('  ⎿ Request timed out')).toBeNull();
      expect(detect(' · Retrying in 38s · attempt 3/10\n')).toBeNull();
      // …and the countdown repaint that follows is still not a terminal state.
      expect(detect('  ⎿ Request timed out · Retrying in 37s · attempt 3/10\n')).toBeNull();
    });

    it('fires once the terminator for a split candidate finally arrives', () => {
      const detect = createTerminalRequestTimeoutDetector();
      expect(detect('  ⎿ Request timed out')).toBeNull();
      expect(detect('\n')).toMatchObject({ category: ERROR_CATEGORIES.TIMEOUT, exitCode: 124 });
    });

    it('accepts a bare CR terminator (how a repainted TUI screen advances)', () => {
      const detect = createTerminalRequestTimeoutDetector();
      expect(detect('  ⎿ Request timed out\r')).toMatchObject({ exitCode: 124 });
    });

    it('treats end of stream as the terminator a held candidate was waiting for', () => {
      const detect = createTerminalRequestTimeoutDetector();
      expect(detect('  ⎿ Request timed out')).toBeNull();
      // The PTY exited — nothing can still complete the line into a retry.
      expect(detect(null, { endOfStream: true })).toMatchObject({ exitCode: 124 });
    });

    it('does not invent a match at end of stream when the last line is a retry banner', () => {
      const detect = createTerminalRequestTimeoutDetector();
      detect('  ⎿ Request timed out · Retrying in 38s · attempt 3/10');
      expect(detect(null, { endOfStream: true })).toBeNull();
    });

    it('ignores a line start fabricated by the rolling window slice boundary', () => {
      // One long line of agent prose quoting the banner, with the window sized so
      // the slice lands EXACTLY on the gutter glyph. buffer[0] then looks like a
      // line start the stream never witnessed — matching there would kill a
      // healthy run over the agent's own output.
      const banner = '⎿ Request timed out\n';
      const detect = createTerminalRequestTimeoutDetector({ maxBuffer: banner.length });
      expect(detect(`while investigating I saw ${banner}`)).toBeNull();
    });

    it('still fires on a real line start inside a window that has already rolled', () => {
      const detect = createTerminalRequestTimeoutDetector({ maxBuffer: 32 });
      detect('a long banner line of TUI chrome that overflows the window\n');
      expect(detect('  ⎿ Request timed out\n')).toMatchObject({ exitCode: 124 });
    });
  });

  describe('detectLocalRuntimeOom', () => {
    // The MLX/MTPLX error envelope exactly as OpenCode's error box renders it —
    // hard-wrapped mid-JSON, with the box-drawing gutter between rows. Captured
    // from agent-011d0c27 (2026-08-22).
    const WRAPPED_OOM_BOX = [
      '│  {"message":"[METAL] Command buffer execution failed:    │',
      '│  Insufficient Memory (00000008:                          │',
      '│  kIOGPUCommandBufferCallbackErrorOutOfMemory).","type":   │',
      '│  "server_error","code":"RuntimeError","param":null}       │',
    ].join('\n');

    it('detects the Metal OOM through the TUI box that wraps it mid-JSON', () => {
      expect(detectLocalRuntimeOom(WRAPPED_OOM_BOX)).toMatchObject({
        category: ERROR_CATEGORIES.RESOURCE_EXHAUSTED,
        requiresFallback: true,
        // Nobody has to fix anything — marking it actionable would block the task.
        actionable: false,
        // Nudge-then-fail-over is the caller's policy, not a grace window here.
        graceMs: 0,
        origin: 'provider',
      });
    });

    it('detects the CUDA phrasings a non-Apple local runtime raises', () => {
      expect(detectLocalRuntimeOom('RuntimeError: CUDA out of memory. Tried to allocate 2.00 GiB'))
        .toMatchObject({ category: ERROR_CATEGORIES.RESOURCE_EXHAUSTED });
      expect(detectLocalRuntimeOom('torch.cuda.OutOfMemoryError: CUDA out of memory'))
        .toMatchObject({ category: ERROR_CATEGORIES.RESOURCE_EXHAUSTED });
    });

    it('leaves ordinary output alone', () => {
      expect(detectLocalRuntimeOom('the build ran out of disk space')).toBeNull();
      expect(detectLocalRuntimeOom('Insufficient Memory')).toBeNull();
      expect(detectLocalRuntimeOom('')).toBeNull();
    });

    it('buffers the constant across stream chunks', () => {
      const detect = createLocalRuntimeOomDetector();
      expect(detect('...(00000008: kIOGPUCommandBuffer')).toBeNull();
      expect(detect('CallbackErrorOutOfMemory).')).toMatchObject({
        category: ERROR_CATEGORIES.RESOURCE_EXHAUSTED,
      });
    });

    it('reports a message that cannot re-match the detector', () => {
      // The message becomes the run's error string, which a CoS task
      // description can quote back — straight into this detector via the TUI's
      // prompt echo. If it re-matched, the agent dispatched to investigate an
      // OOM would itself be nudged and failed over.
      const { message } = detectLocalRuntimeOom(WRAPPED_OOM_BOX);
      expect(detectLocalRuntimeOom(message)).toBeNull();
    });

    it('classifies the same text in a post-hoc output scan', () => {
      expect(analyzeError(WRAPPED_OOM_BOX, 1)).toMatchObject({
        category: ERROR_CATEGORIES.RESOURCE_EXHAUSTED,
        requiresFallback: true,
        actionable: false,
      });
    });
  });

  describe('extractWaitTime', () => {
    it('should extract "X day X hour X minutes" format', () => {
      const result = extractWaitTime('try again in 1 day 2 hours 30 minutes');
      expect(result).toBeTruthy();
      expect(result).toContain('day');
      expect(result).toContain('hour');
      expect(result).toContain('min');
    });

    it('should extract "in X hours" format', () => {
      const result = extractWaitTime('Please wait, available in 3 hours');
      expect(result).toBeTruthy();
      expect(result).toMatch(/3\s*hour/i);
    });

    it('should extract "wait X minutes" format', () => {
      const result = extractWaitTime('Wait 5 minutes before retrying');
      expect(result).toBeTruthy();
      expect(result).toMatch(/5\s*min/i);
    });

    it('should return null for no time found', () => {
      const result = extractWaitTime('No time information here');
      expect(result).toBeNull();
    });

    it('should handle null input', () => {
      const result = extractWaitTime(null);
      expect(result).toBeNull();
    });
  });

  describe('analyzeHttpError', () => {
    it('should detect 429 rate limit', () => {
      const result = analyzeHttpError({
        status: 429,
        statusText: 'Too Many Requests',
        body: ''
      });
      expect(result.hasError).toBe(true);
      expect(result.category).toBe(ERROR_CATEGORIES.RATE_LIMIT);
    });

    it('should detect 401 auth error', () => {
      const result = analyzeHttpError({
        status: 401,
        statusText: 'Unauthorized',
        body: ''
      });
      expect(result.hasError).toBe(true);
      expect(result.category).toBe(ERROR_CATEGORIES.AUTH_ERROR);
    });

    it('should detect 403 auth error', () => {
      const result = analyzeHttpError({
        status: 403,
        statusText: 'Forbidden',
        body: ''
      });
      expect(result.hasError).toBe(true);
      expect(result.category).toBe(ERROR_CATEGORIES.AUTH_ERROR);
    });

    it('should return no error for 200 status', () => {
      const result = analyzeHttpError({
        status: 200,
        statusText: 'OK',
        body: ''
      });
      expect(result.hasError).toBe(false);
    });

    it('should analyze body for more specific errors', () => {
      const result = analyzeHttpError({
        status: 400,
        statusText: 'Bad Request',
        body: 'Error: model "invalid-model" does not exist'
      });
      expect(result.hasError).toBe(true);
      expect(result.category).toBe(ERROR_CATEGORIES.MODEL_NOT_FOUND);
    });

    it('preserves a status-zero readiness failure instead of inventing HTTP 0', () => {
      const result = analyzeHttpError({
        status: 0,
        statusText: '',
        body: 'MTPLX could not start: checkpoint failed to load'
      });

      expect(result).toMatchObject({
        hasError: true,
        category: ERROR_CATEGORIES.UNKNOWN,
        message: 'MTPLX could not start: checkpoint failed to load'
      });
    });

    it('should extract wait time from 429 response body', () => {
      const result = analyzeHttpError({
        status: 429,
        statusText: 'Too Many Requests',
        body: 'Rate limit exceeded. Try again in 5 minutes.'
      });
      expect(result.hasError).toBe(true);
      expect(result.waitTime).toBeTruthy();
    });

    it('normalizes relative and HTTP-date Retry-After values without retaining raw headers', () => {
      const now = Date.parse('2026-08-26T12:00:00.000Z');
      expect(normalizeRateLimitHeaders({ 'Retry-After': '90' }, { now })).toEqual({
        observedAt: '2026-08-26T12:00:00.000Z',
        retryAfterMs: 90000,
      });
      expect(normalizeRateLimitHeaders(new Headers({
        'retry-after': 'Wed, 26 Aug 2026 12:02:00 GMT',
      }), { now })).toEqual({
        observedAt: '2026-08-26T12:00:00.000Z',
        retryAfterMs: 120000,
      });
    });

    it('normalizes provider header casing, reset timestamps, and count metadata', () => {
      const now = Date.parse('2026-08-26T12:00:00.000Z');
      const result = normalizeRateLimitHeaders({
        'X-RateLimit-Reset': String((now + 60000) / 1000),
        'X-RATELIMIT-REMAINING': '4',
        'x-ratelimit-limit': '100',
        authorization: 'Bearer secret-value',
      }, { now });
      expect(result).toEqual({
        observedAt: '2026-08-26T12:00:00.000Z',
        resetAt: '2026-08-26T12:01:00.000Z',
        remaining: 4,
        limit: 100,
      });
      expect(JSON.stringify(result)).not.toContain('secret-value');
      expect(JSON.stringify(result)).not.toContain('authorization');
    });

    it('normalizes provider-specific request-window duration headers', () => {
      const now = Date.parse('2026-08-26T12:00:00.000Z');
      expect(normalizeRateLimitHeaders({
        'X-RateLimit-Reset-Requests': '1m30s',
        'X-RateLimit-Remaining-Requests': '2',
        'X-RateLimit-Limit-Requests': '50',
      }, { now })).toEqual({
        observedAt: '2026-08-26T12:00:00.000Z',
        resetAt: '2026-08-26T12:01:30.000Z',
        remaining: 2,
        limit: 50,
      });
    });

    it('continues past an empty alias to a populated allowed header', () => {
      const now = Date.parse('2026-08-26T12:00:00.000Z');
      expect(normalizeRateLimitHeaders({
        'ratelimit-remaining': '',
        'x-ratelimit-remaining': '5',
      }, { now })).toEqual({
        observedAt: '2026-08-26T12:00:00.000Z',
        remaining: 5,
      });
    });

    it('ignores malformed, negative, oversized, and huge values', () => {
      const now = Date.parse('2026-08-26T12:00:00.000Z');
      expect(normalizeRateLimitHeaders({
        'retry-after': '-1',
        'x-ratelimit-reset': String((now + (31 * 24 * 60 * 60 * 1000)) / 1000),
        'x-ratelimit-remaining': '9'.repeat(129),
        'x-ratelimit-limit': 'token-secret',
      }, { now })).toBeNull();
      expect(normalizeRateLimitHeaders(null, { now })).toBeNull();
    });

    it('attaches only normalized rate-limit metadata to a quota response', () => {
      const result = analyzeHttpError({
        status: 400,
        statusText: 'Bad Request',
        body: 'usage limit reached',
        headers: { 'Retry-After': '15', 'X-Api-Key': 'secret-value' },
      });
      expect(result.category).toBe(ERROR_CATEGORIES.USAGE_LIMIT);
      expect(result.rateLimitWindow).toMatchObject({ retryAfterMs: 15000 });
      expect(JSON.stringify(result)).not.toContain('secret-value');
    });
  });

  describe('isRunCanceledError', () => {
    it('recognizes both markers the runners stamp on a canceled terminal', () => {
      // promptRunner stamps the code; the runner metadata carries the flag.
      expect(isRunCanceledError(Object.assign(new Error('TUI canceled (signal 15)'), { code: 'RUN_CANCELED' }))).toBe(true);
      expect(isRunCanceledError(Object.assign(new Error('CLI canceled (signal SIGTERM)'), { canceled: true }))).toBe(true);
    });

    it('does not claim an ordinary provider failure — which would suppress a real diagnosis', () => {
      expect(isRunCanceledError(new Error('TUI exited with code 1: model unavailable'))).toBe(false);
      // A run that merely mentions cancellation in its text is still a failure.
      expect(isRunCanceledError(new Error('the user canceled their subscription'))).toBe(false);
      expect(isRunCanceledError({ canceled: false, code: 'RUN_FAILED' })).toBe(false);
      expect(isRunCanceledError(null)).toBe(false);
      expect(isRunCanceledError(undefined)).toBe(false);
    });
  });
});
