import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  READY_POLL_INTERVAL_MS,
  READY_IDLE_THRESHOLD_MS,
  PASTE_DEADLINE_MS,
  PASTE_MARKER_POLL_MS,
  PASTE_MARKER_PATTERN,
  detectPasteMarker,
  countPasteMarkers,
  WORK_COUNTER_PATTERN,
  MIN_WORK_COUNTER_SAMPLES,
  MIN_WORK_COUNTER_SPAN_MS,
  extractWorkCounterSeconds,
  createWorkActivityTracker,
  MERGE_QUEUE_IDLE_TIMEOUT_MS,
  isMergeQueueSignal,
  createMergeQueueTracker,
  REVIEW_LOOP_IDLE_TIMEOUT_MS,
  isReviewLoopSignal,
  createReviewLoopTracker,
  rendersWorkCounter,
  PASTE_TO_ENTER_MIN_DELAY_MS,
  PASTE_TO_ENTER_FALLBACK_MS,
  SUBMIT_ENTER_ATTEMPTS,
  SUBMIT_ENTER_SPACING_MS,
  DEFAULT_TUI_PROMPT_DELAY_MS,
  DEFAULT_TUI_IDLE_TIMEOUT_MS,
  RAW_BUFFER_CAP,
  RAW_BUFFER_HEADROOM,
  OUTPUT_BUFFER_CAP,
  OUTPUT_BUFFER_HEADROOM,
  inferTuiCommand,
  applyCommandDefaults,
  buildTuiInvocation,
  detectMissingTuiBinary,
  scheduleSubmitEnters,
} from './tuiHandshake.js';
import { CODEX_CONFIGURED_DEFAULT } from './providerModels.js';

// The exported constants are load-bearing for both production callers
// (`tuiPromptRunner.js`, `agentTuiSpawning.js`). Pin every value so an
// inadvertent edit on one timing knob trips a test instead of silently
// drifting the paste handshake.
describe('tuiHandshake — paste timing constants', () => {
  it('pins ready-poll constants', () => {
    expect(READY_POLL_INTERVAL_MS).toBe(300);
    expect(READY_IDLE_THRESHOLD_MS).toBe(1200);
    expect(PASTE_DEADLINE_MS).toBe(10000);
    // The idle threshold must remain larger than the poll interval —
    // otherwise the first idle window is observed before the banner
    // has finished its second paint.
    expect(READY_IDLE_THRESHOLD_MS).toBeGreaterThan(READY_POLL_INTERVAL_MS);
    // The deadline must outrun the idle threshold by enough headroom to
    // catch a slow spawn + initial paint.
    expect(PASTE_DEADLINE_MS).toBeGreaterThan(READY_IDLE_THRESHOLD_MS);
  });

  it('pins paste-marker constants', () => {
    expect(PASTE_MARKER_POLL_MS).toBe(150);
    expect(PASTE_TO_ENTER_MIN_DELAY_MS).toBe(200);
    expect(PASTE_TO_ENTER_FALLBACK_MS).toBe(3500);
    // Fallback only fires when no marker appears; it must be longer than
    // the min delay or the min delay never gates anything.
    expect(PASTE_TO_ENTER_FALLBACK_MS).toBeGreaterThan(PASTE_TO_ENTER_MIN_DELAY_MS);
  });

  it('PASTE_MARKER_PATTERN matches Claude Code paste markers', () => {
    expect(PASTE_MARKER_PATTERN.test('[Pasted text #1 +3 lines]')).toBe(true);
    expect(PASTE_MARKER_PATTERN.test('[Pasted text #42 +120 lines]')).toBe(true);
    // Embedded inside a banner of escape-stripped output.
    expect(PASTE_MARKER_PATTERN.test('banner stuff [Pasted text #7 +1 lines] trailer')).toBe(true);
  });

  it('PASTE_MARKER_PATTERN matches the SPACE-COLLAPSED form left after ANSI strip', () => {
    // The raw PTY stream renders the marker with absolute-column cursor moves
    // between tokens (`[Pasted\x1b[11Gtext\x1b[16G#1…`), so once ANSI is stripped
    // the spaces vanish and glyphs collapse adjacent. This is the exact shape
    // observed in real transcripts and the root cause of #1229 — a space-
    // requiring regex never matched it. (See the integration assertion below
    // that strips the real escape sequence and matches the result.)
    expect(PASTE_MARKER_PATTERN.test('[Pastedtext#1+35lines]')).toBe(true);
    expect(PASTE_MARKER_PATTERN.test('[Pastedtext#42+120lines]')).toBe(true);
  });

  it('PASTE_MARKER_PATTERN matches the real cursor-positioned marker once ANSI-stripped', () => {
    // Verbatim byte shape from data/cos/agents/.../raw.txt, stripped the same
    // way the streaming ANSI stripper does (drop CSI sequences).
    const rawMarker = '[Pasted\x1b[11Gtext\x1b[16G#1\x1b[19G+35\x1b[23Glines]';
    const stripped = rawMarker.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
    expect(stripped).toBe('[Pastedtext#1+35lines]');
    // The raw form must NOT match (regression guard: this is why the fast path
    // was dead) but the stripped form MUST.
    expect(detectPasteMarker(rawMarker)).toBe(false);
    expect(detectPasteMarker(stripped)).toBe(true);
  });

  it('PASTE_MARKER_PATTERN does NOT match similar-looking but distinct text', () => {
    expect(PASTE_MARKER_PATTERN.test('[Pasted text]')).toBe(false);
    expect(PASTE_MARKER_PATTERN.test('[Pasted #1]')).toBe(false);
    expect(PASTE_MARKER_PATTERN.test('Pasted text #1')).toBe(false);
    expect(PASTE_MARKER_PATTERN.test('')).toBe(false);
  });

  it('detectPasteMarker guards non-string input', () => {
    expect(detectPasteMarker(null)).toBe(false);
    expect(detectPasteMarker(undefined)).toBe(false);
    expect(detectPasteMarker(123)).toBe(false);
    expect(detectPasteMarker('[Pasted text #1 +3 lines]')).toBe(true);
  });

  it('countPasteMarkers counts markers (so an echoed-prompt marker can be subtracted)', () => {
    expect(countPasteMarkers('')).toBe(0);
    expect(countPasteMarkers(null)).toBe(0);
    expect(countPasteMarkers('no marker here')).toBe(0);
    expect(countPasteMarkers('[Pasted text #1 +3 lines]')).toBe(1);
    // Collapsed (stripped) + spaced forms both count.
    expect(countPasteMarkers('[Pastedtext#1+35lines] then [Pasted text #2 +1 lines]')).toBe(2);
  });

  it('countPasteMarkers underpins the echoed-marker gate (count must EXCEED the prompt count)', () => {
    // A transcript-analysis prompt that itself contains a paste marker. The fast
    // path must wait for the TUI's OWN (N+1)th marker, not fire on the echo
    // (issue #1229 round-5 review).
    const prompt = 'analyze this transcript: "[Pasted text #1 +35 lines]" and report';
    const promptMarkers = countPasteMarkers(prompt); // 1
    expect(promptMarkers).toBe(1);
    // Echo of the prompt alone — count does NOT exceed the prompt's own count.
    expect(countPasteMarkers(prompt) > promptMarkers).toBe(false);
    // Once the TUI appends its real commit marker, the count exceeds it → fire.
    expect(countPasteMarkers(`${prompt} [Pastedtext#2+40lines]`) > promptMarkers).toBe(true);
    // A NORMAL prompt (0 markers) keeps the original presence behavior.
    expect(countPasteMarkers('[Pastedtext#1+35lines]') > countPasteMarkers('do the thing')).toBe(true);
  });

  it('the gate must count a STRIPPED prompt — a raw cursor-positioned marker echoes back stripped', () => {
    // Round-6 review: a pasted RAW transcript can carry the cursor-positioned form.
    // Unstripped it counts as 0 (escapes break the match), but it echoes back as
    // the stripped form (count 1) — so counting the RAW prompt would undercount and
    // fire the fast path early. The prompt must be stripped the same way the
    // post-paste buffer is. (stripAnsi behavior is covered in ansiStrip.test.js;
    // here we pin the count asymmetry the consumers must avoid.)
    const rawMarkerPrompt = 'analyze: [Pasted\x1b[11Gtext\x1b[16G#1\x1b[19G+35\x1b[23Glines]';
    const strippedPrompt = rawMarkerPrompt.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
    expect(countPasteMarkers(rawMarkerPrompt)).toBe(0);      // raw → undercount (the bug)
    expect(countPasteMarkers(strippedPrompt)).toBe(1);       // stripped → correct count
    // What the echo produces in the (stripped) post-paste buffer:
    const echoInStrippedBuffer = countPasteMarkers('[Pastedtext#1+35lines]'); // 1
    // Gating on the RAW count fires early (1 > 0); gating on the STRIPPED count does not (1 > 1 == false).
    expect(echoInStrippedBuffer > countPasteMarkers(rawMarkerPrompt)).toBe(true);
    expect(echoInStrippedBuffer > countPasteMarkers(strippedPrompt)).toBe(false);
  });

  it('extractWorkCounterSeconds parses the TUI bullet-suffixed working counter', () => {
    // Claude Code: `(1s · …`; Codex: `(57s • …`.
    expect(extractWorkCounterSeconds('(1s · thinking with high effort)')).toEqual([1]);
    expect(extractWorkCounterSeconds('(57s • esc to interrupt)')).toEqual([57]);
    expect(extractWorkCounterSeconds('(0s · Churning…)')).toEqual([0]);
    // Multiple bulleted counters in one buffer (e.g. an accumulated screen).
    expect(extractWorkCounterSeconds('(1s · a (2s • b (3s · c')).toEqual([1, 2, 3]);
  });

  it('extractWorkCounterSeconds ignores bare (Ns) durations in prose/logs (echo-proof)', () => {
    // The #1229 review fix: a bare `(5s)` in a pasted prompt / log line must NOT
    // count — only the TUI's bullet-suffixed status-line counter does. Without
    // this, an echoed prompt containing duration literals could fake "work".
    expect(extractWorkCounterSeconds('please respond within (5s) of receiving this')).toEqual([]);
    expect(extractWorkCounterSeconds('[12:00:01] (3s) elapsed (4s) total')).toEqual([]);
    expect(extractWorkCounterSeconds('● high · /effort')).toEqual([]);
    expect(extractWorkCounterSeconds('')).toEqual([]);
    expect(extractWorkCounterSeconds(null)).toEqual([]);
  });

  it('extractWorkCounterSeconds is stateless across calls (no lastIndex carryover)', () => {
    // A module-level /g regex would skip matches on the 2nd call; assert it doesn't.
    expect(extractWorkCounterSeconds('(4s · x')).toEqual([4]);
    expect(extractWorkCounterSeconds('(4s · x')).toEqual([4]);
  });

  it('createWorkActivityTracker activates only when the counter ticks across real time (echo-proof)', () => {
    const tracker = createWorkActivityTracker();
    expect(tracker.active).toBe(false);
    // Bare duration literals echoed from the prompt — no bullet → not the counter.
    expect(tracker.observe('finish within (1s) and definitely under (2s)', 0)).toBe(false);
    // A single bulleted counter value must NOT activate (one sample).
    expect(tracker.observe('(5s · thinking)', 1000)).toBe(false);
    expect(tracker.observe('(5s · thinking)', 1100)).toBe(false);
    expect(tracker.active).toBe(false);
    // A second DISTINCT bulleted value — and ≥750ms after the first — activates.
    expect(tracker.observe('(6s · thinking)', 2000)).toBe(true);
    expect(tracker.active).toBe(true);
    // Stays active once tripped.
    expect(tracker.observe('● high · /effort', 3000)).toBe(true);
  });

  it('createWorkActivityTracker rejects an echoed transcript with two distinct counters arriving at once', () => {
    // The #1229 round-3 review case: a task that pastes a TUI transcript can echo
    // two distinct bulleted counters — but they all arrive in the same paste-render
    // burst (same instant), so the time-span requirement keeps them from faking work.
    const tracker = createWorkActivityTracker();
    expect(tracker.observe('analyze this log: (1s · thinking) then (2s · thinking)', 5000)).toBe(false);
    // Even repainted later as a whole (still the SAME two values, not new ones).
    expect(tracker.observe('analyze this log: (1s · thinking) then (2s · thinking)', 9000)).toBe(false);
    expect(tracker.active).toBe(false);
  });

  it('createWorkActivityTracker stays inactive on pure stuck/idle chrome', () => {
    const tracker = createWorkActivityTracker();
    // The exact chrome from the #1229 false-success transcript (no counter).
    tracker.observe('⏵⏵ bypass permissions on (shift+tab to cycle)', 0);
    tracker.observe('● high · /effort', 1000);
    tracker.observe('paste again to expand', 2000);
    tracker.observe('Begin working on the task now.', 3000);
    tracker.observe('Opus 4.8 │ agent-92ed2c56', 4000);
    expect(tracker.active).toBe(false);
  });

  it('pins work-activity detection constants', () => {
    expect(WORK_COUNTER_PATTERN).toBeInstanceOf(RegExp);
    expect(MIN_WORK_COUNTER_SAMPLES).toBe(2);
    expect(MIN_WORK_COUNTER_SPAN_MS).toBe(750);
  });

  it('rendersWorkCounter is true only for the counter-rendering TUIs (Claude Code / Codex)', () => {
    // The idle gate may downgrade to failure ONLY for providers that render the
    // counter; others must keep the permissive idle-complete (codex P2 / #1229).
    expect(rendersWorkCounter('claude')).toBe(true);
    expect(rendersWorkCounter('codex')).toBe(true);
    expect(rendersWorkCounter('/usr/local/bin/claude')).toBe(true);
    expect(rendersWorkCounter('agy')).toBe(false);
    expect(rendersWorkCounter('gemini')).toBe(false);
    expect(rendersWorkCounter('')).toBe(false);
    expect(rendersWorkCounter(null)).toBe(false);
  });

  it('pins provider-default constants', () => {
    expect(DEFAULT_TUI_PROMPT_DELAY_MS).toBe(2500);
    expect(DEFAULT_TUI_IDLE_TIMEOUT_MS).toBe(180000);
  });

  it('pins buffer caps with headroom > cap (defensive growth allowance)', () => {
    expect(RAW_BUFFER_CAP).toBe(512 * 1024);
    expect(RAW_BUFFER_HEADROOM).toBe(640 * 1024);
    // OUTPUT cap was bumped 1MB → 8MB so realistic full-context LLM responses
    // (~600KB UTF-8 from a 200K-token window + screen chrome) fit cleanly
    // when the file-write path falls back to the buffer scrape. A regression
    // back to ~1MB would silently mid-token-truncate large fallback responses.
    expect(OUTPUT_BUFFER_CAP).toBe(8 * 1024 * 1024);
    expect(OUTPUT_BUFFER_HEADROOM).toBe(10 * 1024 * 1024);
    // Headroom must exceed cap so the slice-tail-after-overflow logic in
    // the callers actually keeps recent bytes instead of dropping them.
    expect(RAW_BUFFER_HEADROOM).toBeGreaterThan(RAW_BUFFER_CAP);
    expect(OUTPUT_BUFFER_HEADROOM).toBeGreaterThan(OUTPUT_BUFFER_CAP);
  });
});

// Issue #2074 — a swarm orchestrator in its Phase C serialized merge queue goes
// silent for minutes per PR (each rebases + re-runs CI). Detection latches so the
// idle reaper can extend its grace and not reap a still-working orchestrator.
describe('tuiHandshake — merge-queue idle suppression (#2074)', () => {
  it('extends the idle timeout well past the default 3-minute window', () => {
    expect(MERGE_QUEUE_IDLE_TIMEOUT_MS).toBe(900000);
    expect(MERGE_QUEUE_IDLE_TIMEOUT_MS).toBeGreaterThan(DEFAULT_TUI_IDLE_TIMEOUT_MS);
  });

  it('isMergeQueueSignal matches Phase C merge-queue chrome (case-insensitive)', () => {
    expect(isMergeQueueSignal('### Swarm Phase C — Serialized merge queue')).toBe(true);
    expect(isMergeQueueSignal('Running: gh pr checks 2071 --required --watch --fail-fast')).toBe(true);
    expect(isMergeQueueSignal('gh pr merge 2071 --merge --delete-branch')).toBe(true);
    expect(isMergeQueueSignal('PHASE C: serialized MERGE QUEUE begins')).toBe(true);
  });

  it('isMergeQueueSignal ignores ordinary implementation/output chrome', () => {
    expect(isMergeQueueSignal('Editing server/services/agentTuiSpawning.js')).toBe(false);
    expect(isMergeQueueSignal('● high · (12s · running tests)')).toBe(false);
    expect(isMergeQueueSignal('')).toBe(false);
    expect(isMergeQueueSignal(null)).toBe(false);
    expect(isMergeQueueSignal(undefined)).toBe(false);
  });

  it('createMergeQueueTracker latches on first signal and stays active through silence', () => {
    const tracker = createMergeQueueTracker();
    expect(tracker.active).toBe(false);
    tracker.observe('implementing the fix, running the suite');
    expect(tracker.active).toBe(false);
    // Enters Phase C — latches.
    expect(tracker.observe('gh pr merge 2071 --merge --delete-branch')).toBe(true);
    expect(tracker.active).toBe(true);
    // Subsequent quiet CI-wait chunks (no marker) must NOT un-latch it — the
    // whole point is that the silent gap is when the grace is needed.
    tracker.observe('waiting...');
    tracker.observe('');
    expect(tracker.active).toBe(true);
  });
});

// Observed 2026-07-02 (agent-61508f36) — a do:release run's multi-reviewer
// loop correctly backgrounded a slow codex review and polled for it rather
// than blocking, but the reviewer's silent working stretch exceeded the
// 3-minute default and the runner reaped the still-waiting release as a false
// `idle-complete` success before it reached the merge gate, leaving PR #2084
// open. Mirrors the merge-queue suppression above.
describe('tuiHandshake — review-loop idle suppression', () => {
  it('extends the idle timeout well past the default 3-minute window', () => {
    expect(REVIEW_LOOP_IDLE_TIMEOUT_MS).toBe(900000);
    expect(REVIEW_LOOP_IDLE_TIMEOUT_MS).toBeGreaterThan(DEFAULT_TUI_IDLE_TIMEOUT_MS);
  });

  it('isReviewLoopSignal matches multi-reviewer-loop chrome (case-insensitive)', () => {
    expect(isReviewLoopSignal('Review plan: [claude, codex] (mode: series, stop-mode: all)')).toBe(true);
    expect(isReviewLoopSignal('--- Review pass 1/2: codex ---')).toBe(true);
    expect(isReviewLoopSignal('## Multi-Reviewer Summary')).toBe(true);
    expect(isReviewLoopSignal('You are a COPILOT REVIEW LOOP agent.')).toBe(true);
  });

  it('isReviewLoopSignal ignores ordinary implementation/output chrome', () => {
    expect(isReviewLoopSignal('Editing server/services/agentTuiSpawning.js')).toBe(false);
    expect(isReviewLoopSignal('● high · (12s · running tests)')).toBe(false);
    expect(isReviewLoopSignal('')).toBe(false);
    expect(isReviewLoopSignal(null)).toBe(false);
    expect(isReviewLoopSignal(undefined)).toBe(false);
  });

  it('createReviewLoopTracker latches on first signal and stays active through silence', () => {
    const tracker = createReviewLoopTracker();
    expect(tracker.active).toBe(false);
    tracker.observe('implementing the fix, running the suite');
    expect(tracker.active).toBe(false);
    // Enters the multi-reviewer loop — latches.
    expect(tracker.observe('Review plan: [claude, codex] (mode: series, stop-mode: all)')).toBe(true);
    expect(tracker.active).toBe(true);
    // Subsequent quiet reviewer-wait chunks (no marker) must NOT un-latch it —
    // the whole point is that the silent gap is when the grace is needed.
    tracker.observe('waiting for codex...');
    tracker.observe('');
    expect(tracker.active).toBe(true);
  });
});

describe('tuiHandshake.inferTuiCommand', () => {
  // Catch-all default also returns claude; the claude rows just confirm
  // an explicit match isn't accidentally tagged codex/antigravity/gemini.
  it.each([
    ['', 'claude'],
    [null, 'claude'],
    [undefined, 'claude'],
    ['mystery-provider', 'claude'],
    ['codex', 'codex'],
    ['openai-codex', 'codex'],
    ['codex-cloud', 'codex'],
    ['antigravity', 'agy'],
    ['google-antigravity-2', 'agy'],
    ['gemini', 'gemini'],
    ['google-gemini-2', 'gemini'],
    ['claude', 'claude'],
    ['anthropic-claude-code', 'claude'],
  ])('inferTuiCommand(%p) → %p', (id, expected) => {
    expect(inferTuiCommand(id)).toBe(expected);
  });
});

describe('tuiHandshake.applyCommandDefaults', () => {
  it('injects `--dangerously-bypass-approvals-and-sandbox` for codex when not already present', () => {
    expect(applyCommandDefaults('codex', ['exec', '-'])).toEqual([
      '--dangerously-bypass-approvals-and-sandbox', 'exec', '-',
    ]);
  });

  it('passes codex args through unchanged when --ask-for-approval is already present', () => {
    const args = ['--ask-for-approval', 'auto-edit', 'exec', '-'];
    expect(applyCommandDefaults('codex', args)).toBe(args);
  });

  it('passes codex args through unchanged when --sandbox is already present', () => {
    const args = ['--sandbox', 'workspace-write', 'exec', '-'];
    expect(applyCommandDefaults('codex', args)).toBe(args);
  });

  it('does not duplicate the bypass flag when codex args already pin it', () => {
    const args = ['--dangerously-bypass-approvals-and-sandbox', 'exec', '-'];
    expect(applyCommandDefaults('codex', args)).toBe(args);
  });

  it('passes non-codex commands through unchanged', () => {
    const args = ['-p', '-'];
    expect(applyCommandDefaults('claude', args)).toBe(args);
    expect(applyCommandDefaults('gemini', args)).toBe(args);
    expect(applyCommandDefaults('something-else', args)).toBe(args);
  });

  it('adds Antigravity permission bypass and strips legacy Gemini flags', () => {
    expect(applyCommandDefaults('agy', ['--yolo', '--model', 'gemini-2.5-pro'])).toEqual([
      '--dangerously-skip-permissions',
    ]);
  });

  it('preserves the original arg list when injecting (caller can still mutate before spawn)', () => {
    const args = ['exec', '-'];
    const result = applyCommandDefaults('codex', args);
    // The injection produces a new array; original is untouched.
    expect(result).not.toBe(args);
    expect(args).toEqual(['exec', '-']);
  });
});

describe('tuiHandshake.buildTuiInvocation', () => {
  // buildTuiInvocation reads process.env for the Bedrock signal; isolate from host/CI.
  let savedBedrock;
  beforeEach(() => {
    savedBedrock = process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
  });
  afterEach(() => {
    if (savedBedrock === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK;
    else process.env.CLAUDE_CODE_USE_BEDROCK = savedBedrock;
  });

  it('uses provider.command when present and skips codex defaults for non-literal-codex command names', () => {
    const provider = { id: 'codex', command: 'my-codex-wrapper', args: ['exec', '-'] };
    const out = buildTuiInvocation(provider, null);
    expect(out.command).toBe('my-codex-wrapper');
    // `applyCommandDefaults` checks `command === 'codex'` (strict). A
    // wrapper name escapes the auto-inject — caller-controlled commands
    // own their argv entirely.
    expect(out.args).toEqual(['exec', '-']);
  });

  it('infers command from id when provider.command is missing', () => {
    const provider = { id: 'codex' };
    const out = buildTuiInvocation(provider, null);
    expect(out.command).toBe('codex');
    expect(out.args).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
  });

  it('appends --model when caller passes a model and provider.args has no model flag', () => {
    const provider = { id: 'claude', args: ['-p', '-'] };
    const out = buildTuiInvocation(provider, 'claude-opus-4-7');
    expect(out.command).toBe('claude');
    expect(out.args).toEqual(['-p', '-', '--model', 'claude-opus-4-7']);
  });

  it.each([
    { form: '--model X', bakedArgs: ['--model', 'baked-in'] },
    { form: '--model=X', bakedArgs: ['--model=baked-in'] },
    { form: '-m X', bakedArgs: ['-m', 'baked-in'] },
    { form: '-m=X', bakedArgs: ['-m=baked-in'] },
  ])('does NOT append --model when provider.args pins one ($form form)', ({ bakedArgs }) => {
    const provider = { id: 'claude', args: ['-p', '-', ...bakedArgs] };
    const out = buildTuiInvocation(provider, 'caller-model');
    expect(out.args).toEqual(['-p', '-', ...bakedArgs]);
  });

  it('skips --model injection when caller passes the codex sentinel (configured default)', () => {
    // resolveCliModel(CODEX_CONFIGURED_DEFAULT) returns null → no flag.
    const provider = { id: 'codex', args: ['exec', '-'] };
    const out = buildTuiInvocation(provider, CODEX_CONFIGURED_DEFAULT);
    expect(out.args).toEqual(['--dangerously-bypass-approvals-and-sandbox', 'exec', '-']);
  });

  it('skips --model injection when model is null/undefined/empty', () => {
    const provider = { id: 'claude', args: ['-p', '-'] };
    expect(buildTuiInvocation(provider, null).args).toEqual(['-p', '-']);
    expect(buildTuiInvocation(provider, undefined).args).toEqual(['-p', '-']);
    expect(buildTuiInvocation(provider, '').args).toEqual(['-p', '-']);
  });

  it('namespaces the Ollama model under ollama/ for an OpenCode TUI', () => {
    const provider = { id: 'opencode-ollama-tui', command: 'opencode', args: [], ollamaBacked: true };
    const out = buildTuiInvocation(provider, 'qwen2.5:7b');
    expect(out.command).toBe('opencode');
    expect(out.args).toEqual(['--model', 'ollama/qwen2.5:7b']);
  });

  it('handles a provider with no args (treats as empty array)', () => {
    const out = buildTuiInvocation({ id: 'claude' }, 'opus-x');
    expect(out.command).toBe('claude');
    expect(out.args).toEqual(['--model', 'opus-x']);
  });

  it('does not append --model for Antigravity TUI', () => {
    const out = buildTuiInvocation({ id: 'antigravity-tui', command: 'agy', args: [] }, 'antigravity-configured-default');
    expect(out.command).toBe('agy');
    expect(out.args).toEqual(['--dangerously-skip-permissions']);
  });

  it('handles a missing provider with no id (falls back to claude)', () => {
    const out = buildTuiInvocation(undefined, 'opus-x');
    expect(out.command).toBe('claude');
    expect(out.args).toEqual(['--model', 'opus-x']);
  });

  it('maps a bare Claude model to its Bedrock form when CLAUDE_CODE_USE_BEDROCK is set (claude-code-tui runner)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const provider = { id: 'claude-code-tui', args: ['-p', '-'], envVars: { CLAUDE_CODE_USE_BEDROCK: '1' } };
    const out = buildTuiInvocation(provider, 'claude-opus-4-8');
    expect(out.args).toEqual(['-p', '-', '--model', 'global.anthropic.claude-opus-4-8']);
    spy.mockRestore();
  });
});

describe('tuiHandshake.detectMissingTuiBinary', () => {
  it('detects bash-style not-found for the spawned command', () => {
    expect(detectMissingTuiBinary('bash: codex: command not found', 'codex')).toBe(true);
    expect(detectMissingTuiBinary('zsh: command not found: claude', 'claude')).toBe(true);
  });

  it('is case-insensitive on both sides', () => {
    expect(detectMissingTuiBinary('Codex: COMMAND NOT FOUND', 'codex')).toBe(true);
    expect(detectMissingTuiBinary('command not found CODEX', 'CoDeX')).toBe(true);
  });

  it('rejects unrelated errors that mention the command but not "command not found"', () => {
    expect(detectMissingTuiBinary('codex: permission denied', 'codex')).toBe(false);
    expect(detectMissingTuiBinary('codex panicked at line 42', 'codex')).toBe(false);
  });

  it('rejects "command not found" for a different command', () => {
    expect(detectMissingTuiBinary('bash: gemini: command not found', 'codex')).toBe(false);
  });

  it('rejects empty / whitespace strings', () => {
    expect(detectMissingTuiBinary('', 'codex')).toBe(false);
    expect(detectMissingTuiBinary('   ', 'codex')).toBe(false);
  });
});

describe('tuiHandshake.scheduleSubmitEnters', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('writes SUBMIT_ENTER_ATTEMPTS times: once immediately, the rest spaced apart', () => {
    const write = vi.fn();
    const timer = scheduleSubmitEnters(write, () => false);

    // First Enter fires synchronously; the rest come from the interval.
    expect(write).toHaveBeenCalledTimes(1);
    expect(timer).not.toBeNull();

    vi.advanceTimersByTime(SUBMIT_ENTER_SPACING_MS * (SUBMIT_ENTER_ATTEMPTS + 2));
    expect(write).toHaveBeenCalledTimes(SUBMIT_ENTER_ATTEMPTS);
  });

  it('sends nothing and returns null when already finalized', () => {
    const write = vi.fn();
    const timer = scheduleSubmitEnters(write, () => true);
    expect(write).not.toHaveBeenCalled();
    expect(timer).toBeNull();
  });

  it('stops re-sending once finalized mid-flight (no write into a torn-down session)', () => {
    const write = vi.fn();
    let finalized = false;
    scheduleSubmitEnters(write, () => finalized);
    expect(write).toHaveBeenCalledTimes(1);

    finalized = true;
    vi.advanceTimersByTime(SUBMIT_ENTER_SPACING_MS * (SUBMIT_ENTER_ATTEMPTS + 2));
    // The immediate write already happened; no interval-driven writes follow.
    expect(write).toHaveBeenCalledTimes(1);
  });
});
