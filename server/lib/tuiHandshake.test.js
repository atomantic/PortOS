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
  BACKGROUND_SHELL_IDLE_TIMEOUT_MS,
  isBackgroundShellSignal,
  createBackgroundShellTracker,
  MCP_BOOT_PASTE_DEADLINE_MS,
  MCP_BOOT_PASTE_RETRY_DELAY_MS,
  isMcpBootSignal,
  createMcpBootTracker,
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
  PASTE_VERIFY_POLL_MS,
  PASTE_VERIFY_WINDOW_MS,
  PASTE_RETRY_MAX_ATTEMPTS,
  PASTE_RETRY_BASE_DELAY_MS,
  extractVerifiablePromptPrefix,
  verifyPasteRendered,
  isPasteConfirmed,
  isCollapsedPasteChip,
  createInputReadyTracker,
  AGY_INPUT_READY_PATTERN,
} from './tuiHandshake.js';
import { CODEX_CONFIGURED_DEFAULT } from './providerModels.js';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

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

  it('PASTE_MARKER_PATTERN matches Codex paste-commit chips', () => {
    expect(PASTE_MARKER_PATTERN.test('[Pasted Content 2431 chars]')).toBe(true);
    expect(PASTE_MARKER_PATTERN.test('[PastedContent2431chars]')).toBe(true);
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
  });

  it('isReviewLoopSignal ignores ordinary implementation/output chrome', () => {
    expect(isReviewLoopSignal('Editing server/services/agentTuiSpawning.js')).toBe(false);
    expect(isReviewLoopSignal('● high · (12s · running tests)')).toBe(false);
    expect(isReviewLoopSignal('')).toBe(false);
    expect(isReviewLoopSignal(null)).toBe(false);
    expect(isReviewLoopSignal(undefined)).toBe(false);
  });

  // Regression for false-positive latches found across three rounds of local
  // review: bare substrings ('review pass', 'review loop', 'multi-reviewer',
  // 'multi-reviewer summary') would match this project's own CLAUDE.md
  // convention ("run a simplify/self-review pass before committing") and this
  // repo's bundled slashdo docs — which say "review loop"/"multi-reviewer"
  // dozens of times, include the literal instruction text "Review plan:
  // {REVIEW_AGENTS}...", AND (codex review's finding) render a fully-formed
  // example of their own "## Multi-Reviewer Summary" aggregate-report heading
  // in a sample output block — latching the tracker for ANY CoS agent's
  // ordinary narration or docs-editing, not just an actual do:release/do:pr/
  // do:rpr run.
  it('isReviewLoopSignal does NOT match ordinary self-review narration or doc prose', () => {
    expect(isReviewLoopSignal('running the self-review pass before committing')).toBe(false);
    expect(isReviewLoopSignal('## Local Agent Code Review Loop')).toBe(false);
    expect(isReviewLoopSignal('You are a Copilot review loop agent.')).toBe(false);
    expect(isReviewLoopSignal('the multi-reviewer wrapper dispatches each listed agent')).toBe(false);
    expect(isReviewLoopSignal('Print the resolved plan before starting: `Review plan: {REVIEW_AGENTS} (mode: ...)`')).toBe(false);
    expect(isReviewLoopSignal('## Multi-Reviewer Summary')).toBe(false);
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

  // Regression for codex review [P2] (iteration 2): a real TUI can deliver
  // the banner split across two onData chunks (token-by-token streaming),
  // so checking only the current chunk in isolation would miss it.
  it('createReviewLoopTracker latches on a marker split across two chunks', () => {
    const tracker = createReviewLoopTracker();
    // Split right before the '[' that anchors the pattern — neither half
    // alone contains "review plan: [".
    tracker.observe('Now starting the review loop. Review plan:');
    expect(tracker.active).toBe(false);
    expect(tracker.observe(' [claude, codex] (mode: series, stop-mode: all)')).toBe(true);
    expect(tracker.active).toBe(true);
  });
});

// Incident 2026-08-09, task-mslczmtr: three consecutive attempts were reaped
// while `/do:pr`'s self-review gate waited on backgrounded reviewers (an Ollama
// per-file pass, a headless codex pass). Between reviewer completions the model
// sits at the prompt and the TUI emits NOTHING, so the 3-minute default fired
// on a session that was working correctly. The branch ended with three commits
// pushed and no PR. The review-loop tracker above did NOT cover it: that keys
// on the multi-reviewer LOOP banners, which only print when configReviewLoop is
// on — this run had it off (zero marker hits across all three transcripts).
describe('tuiHandshake — background-shell idle grace (task-mslczmtr)', () => {
  it('extends the idle timeout well past the default 3-minute window', () => {
    expect(BACKGROUND_SHELL_IDLE_TIMEOUT_MS).toBe(900000);
    expect(BACKGROUND_SHELL_IDLE_TIMEOUT_MS).toBeGreaterThan(DEFAULT_TUI_IDLE_TIMEOUT_MS);
  });

  it('isBackgroundShellSignal matches the outstanding-shell footer', () => {
    expect(isBackgroundShellSignal('✻ Baked for 20s · 2 shells still running')).toBe(true);
    expect(isBackgroundShellSignal('✻ Cooked for 2s · 1 shell still running')).toBe(true);
    expect(isBackgroundShellSignal('SAUTÉED FOR 1M 8S · 3 SHELLS STILL RUNNING')).toBe(true);
  });

  // The TUI repaints DIFFERENTIALLY, so a redraw that rewrites only the changed
  // cells can drop the space between the count and the noun. This exact string
  // is the ONLY rendering of the footer in the agent-839255ca transcript — a
  // pattern requiring a literal space would have missed that run entirely.
  it('isBackgroundShellSignal tolerates the space dropped by a differential repaint', () => {
    expect(isBackgroundShellSignal('✻ Baked for 34m 33s · 1shell still running')).toBe(true);
  });

  it('isBackgroundShellSignal ignores ordinary narration and non-strings', () => {
    expect(isBackgroundShellSignal('the dev server is still running on :5555')).toBe(false);
    expect(isBackgroundShellSignal('shells still running')).toBe(false);
    expect(isBackgroundShellSignal('Ran 5 shell commands')).toBe(false);
    expect(isBackgroundShellSignal('')).toBe(false);
    expect(isBackgroundShellSignal(null)).toBe(false);
    expect(isBackgroundShellSignal(undefined)).toBe(false);
  });

  it('createBackgroundShellTracker latches on first signal and stays active through silence', () => {
    const tracker = createBackgroundShellTracker();
    expect(tracker.active).toBe(false);
    tracker.observe('implementing the fix, running the suite');
    expect(tracker.active).toBe(false);
    expect(tracker.observe('✻ Baked for 20s · 2 shells still running')).toBe(true);
    expect(tracker.active).toBe(true);
    // The silent reviewer wait is exactly when the grace is needed, so quiet
    // chunks must not un-latch it.
    tracker.observe('Standing by for the review to finish.');
    tracker.observe('');
    expect(tracker.active).toBe(true);
  });

  it('createBackgroundShellTracker latches on a marker split across two chunks', () => {
    const tracker = createBackgroundShellTracker();
    tracker.observe('✻ Baked for 20s · 2 shells');
    expect(tracker.active).toBe(false);
    expect(tracker.observe(' still running')).toBe(true);
    expect(tracker.active).toBe(true);
  });
});

describe('tuiHandshake — codex MCP-boot paste patience (agent-c5a26b40)', () => {
  it('deadline covers a node_repl startup_timeout_sec=120 plus margin, under the idle-reap window', () => {
    // Long enough for the documented 120s node_repl startup + an npx cold
    // download, short enough to resolve before the 180s default idle reaper.
    expect(MCP_BOOT_PASTE_DEADLINE_MS).toBe(150000);
    expect(MCP_BOOT_PASTE_DEADLINE_MS).toBeGreaterThan(120000);
    expect(MCP_BOOT_PASTE_DEADLINE_MS).toBeLessThan(DEFAULT_TUI_IDLE_TIMEOUT_MS);
    expect(MCP_BOOT_PASTE_RETRY_DELAY_MS).toBe(5000);
  });

  it('isMcpBootSignal matches codex MCP boot banners (case-insensitive)', () => {
    expect(isMcpBootSignal('Booting MCP server: codex_apps(0s • esc to interrupt)')).toBe(true);
    expect(isMcpBootSignal('Starting MCP servers (0/3): codex_apps, node_repl, playwright')).toBe(true);
    expect(isMcpBootSignal('STARTING MCP SERVERS (3/3)')).toBe(true);
  });

  it('isMcpBootSignal ignores ordinary output that merely mentions MCP', () => {
    // Conservative anchoring: a prompt/output that talks ABOUT mcp servers must
    // not latch the extended budget (a false positive only slows a failure, but
    // keep it tight anyway — mirrors the merge-queue/review-loop discipline).
    expect(isMcpBootSignal('Configure the mcp server in server/services/voice/tools.js')).toBe(false);
    expect(isMcpBootSignal('the playwright MCP server is slow')).toBe(false);
    expect(isMcpBootSignal('')).toBe(false);
    expect(isMcpBootSignal(null)).toBe(false);
    expect(isMcpBootSignal(undefined)).toBe(false);
  });

  it('createMcpBootTracker latches on first banner and stays active through the silent boot', () => {
    const tracker = createMcpBootTracker();
    expect(tracker.active).toBe(false);
    // Ordinary startup banner chrome — not a boot signal.
    tracker.observe('>_ OpenAI Codex (v0.144.1)  permissions: YOLO mode');
    expect(tracker.active).toBe(false);
    // MCP boot begins — latches.
    expect(tracker.observe('Starting MCP servers (0/3): codex_apps, node_repl, playwright')).toBe(true);
    expect(tracker.active).toBe(true);
    // Codex updates the line via cursor-positioned partial redraws that do NOT
    // reprint the full phrase, and the boot subprocess can go silent (npx
    // download) — neither must un-latch the extended patience.
    tracker.observe('servers (3/4');
    tracker.observe('');
    expect(tracker.active).toBe(true);
  });

  it('createMcpBootTracker latches on a banner split across two chunks', () => {
    const tracker = createMcpBootTracker();
    tracker.observe('• You have 3 usage limit resets available. Booting MCP');
    expect(tracker.active).toBe(false);
    expect(tracker.observe(' server: codex_apps(0s • esc to interrupt)')).toBe(true);
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
    ['kimi-tui', 'kimi'],
    ['moonshot-kimi-2', 'kimi'],
    // grok / opencode were missing, so a blank-command provider under either id
    // silently resolved to `claude` — which also told it (via
    // resolveSlashdoStyle's spawner posture) to type `/do:pr` commands its real
    // binary doesn't have.
    ['grok-tui', 'grok'],
    ['xai-grok-2', 'grok'],
    ['opencode-tui', 'opencode'],
    ['opencode-ollama-tui', 'opencode'],
    // `cursor` must map to the AGENT binary, not the `cursor` GUI launcher, and
    // must not fall through to the blank-command `claude` default.
    ['cursor-tui', 'cursor-agent'],
    ['cursor-cli', 'cursor-agent'],
  ])('inferTuiCommand(%p) → %p', (id, expected) => {
    expect(inferTuiCommand(id)).toBe(expected);
  });
});

describe('tuiHandshake.applyCommandDefaults', () => {
  it('injects the bypass flag and disables the startup update check for codex when not already present', () => {
    expect(applyCommandDefaults('codex', ['exec', '-'])).toEqual([
      '--dangerously-bypass-approvals-and-sandbox', '-c', 'check_for_update_on_startup=false', 'exec', '-',
    ]);
  });

  it('skips the bypass flag but still disables the update check when --ask-for-approval is already present', () => {
    const args = ['--ask-for-approval', 'auto-edit', 'exec', '-'];
    expect(applyCommandDefaults('codex', args)).toEqual([
      '-c', 'check_for_update_on_startup=false', '--ask-for-approval', 'auto-edit', 'exec', '-',
    ]);
  });

  it('skips the bypass flag but still disables the update check when --sandbox is already present', () => {
    const args = ['--sandbox', 'workspace-write', 'exec', '-'];
    expect(applyCommandDefaults('codex', args)).toEqual([
      '-c', 'check_for_update_on_startup=false', '--sandbox', 'workspace-write', 'exec', '-',
    ]);
  });

  it('does not duplicate the bypass flag when codex args already pin it', () => {
    const args = ['--dangerously-bypass-approvals-and-sandbox', 'exec', '-'];
    expect(applyCommandDefaults('codex', args)).toEqual([
      '-c', 'check_for_update_on_startup=false', '--dangerously-bypass-approvals-and-sandbox', 'exec', '-',
    ]);
  });

  it('does not duplicate the update-check config when codex args already pin it', () => {
    const args = ['-c', 'check_for_update_on_startup=true', 'exec', '-'];
    expect(applyCommandDefaults('codex', args)).toEqual([
      '--dangerously-bypass-approvals-and-sandbox', '-c', 'check_for_update_on_startup=true', 'exec', '-',
    ]);
  });

  it('returns the same codex arg list untouched when both policy and update-check are already pinned', () => {
    const args = ['--dangerously-bypass-approvals-and-sandbox', '-c', 'check_for_update_on_startup=false', 'exec', '-'];
    expect(applyCommandDefaults('codex', args)).toBe(args);
  });

  it('passes non-codex commands through unchanged', () => {
    const args = ['-p', '-'];
    expect(applyCommandDefaults('claude', args)).toBe(args);
    expect(applyCommandDefaults('gemini', args)).toBe(args);
    expect(applyCommandDefaults('something-else', args)).toBe(args);
  });

  it('adds Antigravity permission bypass and strips legacy Gemini flags', () => {
    expect(applyCommandDefaults('agy', ['--yolo', '-m', 'gemini-2.5-pro'])).toEqual([
      '--dangerously-skip-permissions',
    ]);
  });

  // agy accepts the long `--model` now, so a baked pin survives (and suppresses
  // the per-run model injection in buildTuiInvocation).
  it('preserves a long-form --model pin for Antigravity', () => {
    expect(applyCommandDefaults('agy', ['--model', 'gemini-3.1-pro-high'])).toEqual([
      '--model', 'gemini-3.1-pro-high', '--dangerously-skip-permissions',
    ]);
  });

  it('preserves the original arg list when injecting (caller can still mutate before spawn)', () => {
    const args = ['exec', '-'];
    const result = applyCommandDefaults('codex', args);
    // The injection produces a new array; original is untouched.
    expect(result).not.toBe(args);
    expect(args).toEqual(['exec', '-']);
  });

  it('adds Grok TUI permission bypass and is idempotent when already pinned', () => {
    expect(applyCommandDefaults('grok', [])).toEqual(['--permission-mode', 'bypassPermissions']);
    const pinned = ['--permission-mode', 'auto'];
    expect(applyCommandDefaults('grok', pinned)).toEqual(['--permission-mode', 'auto']);
  });

  it('adds the Kimi TUI --yolo auto-approve and is idempotent when an approval posture is already pinned', () => {
    expect(applyCommandDefaults('kimi', [])).toEqual(['--yolo']);
    // Seeded default already carries --yolo — no duplicate.
    expect(applyCommandDefaults('kimi', ['--yolo'])).toEqual(['--yolo']);
    // A user-pinned posture (-y / --afk) is respected.
    expect(applyCommandDefaults('kimi', ['--afk'])).toEqual(['--afk']);
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

  it('uses provider.command when present and skips codex defaults for non-codex-basename command names', () => {
    const provider = { id: 'codex', command: 'my-codex-wrapper', args: ['exec', '-'] };
    const out = buildTuiInvocation(provider, null);
    expect(out.command).toBe('my-codex-wrapper');
    // `applyCommandDefaults` matches codex by basename. `my-codex-wrapper`'s
    // basename is not `codex`, so it escapes the auto-inject — a caller-
    // controlled wrapper owns its argv entirely.
    expect(out.args).toEqual(['exec', '-']);
  });

  it('injects codex defaults for an absolute codex binary path (basename-aware match)', () => {
    // A provider commonly pins the absolute path `which codex` returns; a strict
    // `=== 'codex'` would skip the defaults and leave the TUI to wedge on the
    // update modal. Basename `codex` still matches.
    const provider = { id: 'codex-tui', command: '/opt/homebrew/bin/codex', args: [] };
    const out = buildTuiInvocation(provider, null);
    expect(out.command).toBe('/opt/homebrew/bin/codex');
    expect(out.args).toEqual(['--dangerously-bypass-approvals-and-sandbox', '-c', 'check_for_update_on_startup=false']);
  });

  it('infers command from id when provider.command is missing', () => {
    const provider = { id: 'codex' };
    const out = buildTuiInvocation(provider, null);
    expect(out.command).toBe('codex');
    expect(out.args).toEqual(['--dangerously-bypass-approvals-and-sandbox', '-c', 'check_for_update_on_startup=false']);
  });

  it('builds the Kimi TUI with --yolo and no --model for the configured-default sentinel', () => {
    const provider = { id: 'kimi-tui', command: 'kimi', args: ['--yolo'] };
    const out = buildTuiInvocation(provider, 'kimi-configured-default');
    expect(out.command).toBe('kimi');
    // --yolo is already seeded; sentinel resolves to null so no --model is appended.
    expect(out.args).toEqual(['--yolo']);
    expect(out.args).not.toContain('--model');
  });

  it('appends --model for a concrete kimi model id', () => {
    const provider = { id: 'kimi-tui', command: 'kimi', args: ['--yolo'] };
    const out = buildTuiInvocation(provider, 'kimi-k2');
    expect(out.args).toEqual(['--yolo', '--model', 'kimi-k2']);
  });

  it('builds the Cursor TUI with --force and appends the model', () => {
    const provider = { id: 'cursor-tui', command: 'cursor-agent', args: ['--force'] };
    const out = buildTuiInvocation(provider, 'auto');
    expect(out.command).toBe('cursor-agent');
    expect(out.args).toEqual(['--force', '--model', 'auto']);
  });

  it('injects --force when a cursor provider’s saved args dropped it', () => {
    const out = buildTuiInvocation({ id: 'cursor-tui', command: 'cursor-agent', args: [] }, null);
    expect(out.args).toEqual(['--force']);
  });

  it('emits no --effort for cursor — its reasoning tier is baked into the model id', () => {
    const provider = { id: 'cursor-tui', command: 'cursor-agent', args: ['--force'], effort: 'high' };
    const out = buildTuiInvocation(provider, 'claude-opus-5-thinking-high');
    expect(out.args).not.toContain('--effort');
  });

  it('does not Bedrock-map a cursor model id that merely contains "claude"', () => {
    const prev = process.env.CLAUDE_CODE_USE_BEDROCK;
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    try {
      const provider = { id: 'cursor-tui', command: 'cursor-agent', args: ['--force'] };
      const out = buildTuiInvocation(provider, 'claude-opus-5-thinking-high');
      expect(out.args).toEqual(['--force', '--model', 'claude-opus-5-thinking-high']);
      expect(out.args.join(' ')).not.toContain('anthropic.');
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK;
      else process.env.CLAUDE_CODE_USE_BEDROCK = prev;
    }
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
    expect(out.args).toEqual(['--dangerously-bypass-approvals-and-sandbox', '-c', 'check_for_update_on_startup=false', 'exec', '-']);
  });

  it('passes a selected Codex model tier to the interactive CLI', () => {
    const provider = { id: 'codex-tui', command: 'codex', args: [] };
    const out = buildTuiInvocation(provider, 'gpt-5.6-sol');
    expect(out.args).toEqual(['--dangerously-bypass-approvals-and-sandbox', '-c', 'check_for_update_on_startup=false', '--model', 'gpt-5.6-sol']);
  });

  it('skips --model injection when model is null/undefined/empty', () => {
    const provider = { id: 'claude', args: ['-p', '-'] };
    expect(buildTuiInvocation(provider, null).args).toEqual(['-p', '-']);
    expect(buildTuiInvocation(provider, undefined).args).toEqual(['-p', '-']);
    expect(buildTuiInvocation(provider, '').args).toEqual(['-p', '-']);
  });

  it('injects Grok TUI permission bypass and omits --model for the configured-default sentinel', () => {
    const provider = { id: 'grok-tui', command: 'grok', args: [] };
    const out = buildTuiInvocation(provider, 'grok-configured-default');
    expect(out.command).toBe('grok');
    expect(out.args).toEqual(['--permission-mode', 'bypassPermissions']);
    expect(out.args).not.toContain('--model');
  });

  it('appends --model for Grok TUI when a concrete model is requested', () => {
    const provider = { id: 'grok-tui', command: 'grok', args: [] };
    const out = buildTuiInvocation(provider, 'grok-code-fast-1');
    expect(out.args).toEqual(['--permission-mode', 'bypassPermissions', '--model', 'grok-code-fast-1']);
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

  it('does not append --model for the Antigravity configured-default sentinel', () => {
    const out = buildTuiInvocation({ id: 'antigravity-tui', command: 'agy', args: [] }, 'antigravity-configured-default');
    expect(out.command).toBe('agy');
    expect(out.args).toEqual(['--dangerously-skip-permissions']);
  });

  it('appends --model for Antigravity TUI when a real model is selected', () => {
    const out = buildTuiInvocation({ id: 'antigravity-tui', command: 'agy', args: [] }, 'gemini-3.1-pro-high');
    expect(out.command).toBe('agy');
    // A legacy effort-suffixed id splits into base + `--effort` — the same
    // invocation agy resolves `gemini-3.1-pro-high` to.
    expect(out.args).toEqual(['--dangerously-skip-permissions', '--model', 'gemini-3.1-pro', '--effort', 'high']);
  });

  it('pairs a base Antigravity model with provider.effort', () => {
    const out = buildTuiInvocation(
      { id: 'antigravity-tui', command: 'agy', args: [], effort: 'medium' },
      'gemini-3.6-flash',
    );
    expect(out.args).toEqual(['--dangerously-skip-permissions', '--model', 'gemini-3.6-flash', '--effort', 'medium']);
  });

  it('clamps provider.effort to a tier the selected Antigravity model actually has', () => {
    // agy rejects `--model gemini-3.1-pro --effort medium` outright, so the
    // catalog narrows the ladder to the tiers that base really offers.
    const out = buildTuiInvocation(
      {
        id: 'antigravity-tui',
        command: 'agy',
        args: [],
        effort: 'medium',
        models: ['gemini-3.1-pro-low', 'gemini-3.1-pro-high'],
      },
      'gemini-3.1-pro',
    );
    expect(out.args).toEqual(['--dangerously-skip-permissions', '--model', 'gemini-3.1-pro', '--effort', 'low']);
  });

  it('emits no --effort for an Antigravity model the catalog gives no tiers', () => {
    const out = buildTuiInvocation(
      {
        id: 'antigravity-tui',
        command: 'agy',
        args: [],
        effort: 'high',
        models: ['gemini-3.6-flash-high', 'claude-sonnet-4-6'],
      },
      'claude-sonnet-4-6',
    );
    expect(out.args).toEqual(['--dangerously-skip-permissions', '--model', 'claude-sonnet-4-6']);
  });

  it('appends --effort for a claude TUI provider carrying provider.effort', () => {
    const out = buildTuiInvocation(
      { id: 'claude-code-tui', command: 'claude', args: [], effort: 'max' },
      'claude-opus-5',
    );
    expect(out.args).toEqual(['--model', 'claude-opus-5', '--effort', 'max']);
  });

  it('emits no --effort for a TUI provider with no effort control', () => {
    const out = buildTuiInvocation(
      { id: 'opencode-tui', command: 'opencode', args: [], effort: 'high' },
      'qwen3',
    );
    expect(out.args).toEqual(['--model', 'qwen3']);
  });

  // agy serves its `claude-*` ids through Google's own gateway, so a Bedrock box
  // must NOT rewrite them to `global.anthropic.*` (agy can't resolve that).
  it('does not Bedrock-map an Antigravity claude-* model id', () => {
    const prev = process.env.CLAUDE_CODE_USE_BEDROCK;
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    try {
      const out = buildTuiInvocation({ id: 'antigravity-tui', command: 'agy', args: [] }, 'claude-sonnet-4-6');
      expect(out.args).toEqual(['--dangerously-skip-permissions', '--model', 'claude-sonnet-4-6']);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK;
      else process.env.CLAUDE_CODE_USE_BEDROCK = prev;
    }
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

// Paste verification helpers (issue #2192)
describe('tuiHandshake — paste verification constants', () => {
  it('pins paste verification constants', () => {
    expect(PASTE_VERIFY_POLL_MS).toBe(200);
    expect(PASTE_VERIFY_WINDOW_MS).toBe(2000);
    expect(PASTE_RETRY_MAX_ATTEMPTS).toBe(3);
    expect(PASTE_RETRY_BASE_DELAY_MS).toBe(800);
    // Verification window should be shorter than the overall paste deadline
    expect(PASTE_VERIFY_WINDOW_MS).toBeLessThan(PASTE_DEADLINE_MS);
  });
});

describe('tuiHandshake.extractVerifiablePromptPrefix', () => {
  it('extracts a prefix from a normal prompt', () => {
    const prompt = 'Please implement the feature described in issue #123. The feature should...';
    const prefix = extractVerifiablePromptPrefix(prompt);
    expect(prefix).toBeTruthy();
    expect(prefix.length).toBeGreaterThanOrEqual(15);
    expect(prefix.length).toBeLessThanOrEqual(40);
    // The prefix should be from the prompt, not the very beginning (skips common prefixes)
    expect(prompt.includes(prefix)).toBe(true);
    expect(prompt.startsWith(prefix)).toBe(false);
  });

  it('returns the whole prompt for very short prompts', () => {
    const prompt = 'Fix the bug';
    const prefix = extractVerifiablePromptPrefix(prompt);
    expect(prefix).toBe('Fix the bug');
  });

  it('returns null for prompts too short to verify', () => {
    expect(extractVerifiablePromptPrefix('Hi')).toBeNull();
    expect(extractVerifiablePromptPrefix('')).toBeNull();
    expect(extractVerifiablePromptPrefix(null)).toBeNull();
    expect(extractVerifiablePromptPrefix(undefined)).toBeNull();
  });

  it('collapses whitespace in the prefix', () => {
    const prompt = 'Please  implement\n\nthe   feature';
    const prefix = extractVerifiablePromptPrefix(prompt);
    expect(prefix).not.toMatch(/\s{2,}/);
    expect(prefix).not.toContain('\n');
  });

  it('handles prompts with leading boilerplate', () => {
    const prompt = 'You are a helpful assistant. Please implement the truncateMiddle function.';
    const prefix = extractVerifiablePromptPrefix(prompt);
    // Should skip the first few characters to avoid matching common prefixes
    expect(prefix.startsWith('You are')).toBe(false);
    expect(prompt.replace(/\s+/g, ' ').includes(prefix)).toBe(true);
  });
});

describe('createInputReadyTracker', () => {
  const PASTE_OFF = '\x1b[?2004l';
  const PASTE_ON = '\x1b[?2004h';

  it('is ready once paste mode is re-enabled after the launch command ran', () => {
    const tracker = createInputReadyTracker();
    tracker.observe(PASTE_ON, ''); // the launch shell's own paste mode — not ready
    expect(tracker.ready).toBe(false);
    tracker.observe(PASTE_OFF, ''); // shell turned it off to run the command
    expect(tracker.ready).toBe(false);
    tracker.observe(PASTE_ON, '');
    expect(tracker.ready).toBe(true);
  });

  it('latches needsTrust on either trust-gate wording', () => {
    const claude = createInputReadyTracker();
    claude.observe('', 'Is this a project you trust?');
    expect(claude.needsTrust).toBe(true);

    const agy = createInputReadyTracker();
    agy.observe('', 'Do you trust the contents of this project?\n> Yes, I trust this folder\n');
    expect(agy.needsTrust).toBe(true);
  });

  it('matches a marker split across two PTY chunks (rolling tail)', () => {
    const tracker = createInputReadyTracker();
    tracker.observe('', '> Yes, I trust th');
    expect(tracker.needsTrust).toBe(false);
    tracker.observe('', 'is folder');
    expect(tracker.needsTrust).toBe(true);
  });

  // agy enables bracketed paste on ALT-SCREEN ENTRY — before its composer, and
  // before its folder-trust gate paints — so paste mode alone raced the trust
  // menu and the prompt was pasted into it (`paste-not-rendered`).
  it('readyTextPattern: paste mode alone is not ready until the composer marker is seen', () => {
    const tracker = createInputReadyTracker({ readyTextPattern: AGY_INPUT_READY_PATTERN });
    tracker.observe(`${PASTE_OFF}${PASTE_ON}`, 'Welcome to the Antigravity CLI.\n Signing in...\n');
    expect(tracker.ready).toBe(false);

    tracker.observe('', 'Do you trust the contents of this project?\n> Yes, I trust this folder\n');
    expect(tracker.needsTrust).toBe(true);
    expect(tracker.ready).toBe(false); // still not ready while the trust menu is up

    tracker.observe('', '>\n? for shortcutsGemini 3.6 Flash · medium');
    expect(tracker.ready).toBe(true);
  });

  it('readyTextPattern: the composer marker alone is not ready without paste mode', () => {
    const tracker = createInputReadyTracker({ readyTextPattern: AGY_INPUT_READY_PATTERN });
    tracker.observe('', '? for shortcuts');
    expect(tracker.ready).toBe(false);
  });

  // The durable runner pty.spawns the TUI directly — no launch shell, so the
  // shell's paste-mode OFF never appears in the stream. The TUI's own first ON
  // is the ready signal (regression: every runner-tui claude agent died
  // `tui-not-ready` at the deadline with a live input box on screen).
  it('directLaunch: ready on the TUI\'s own first paste-mode ON, with no shell OFF ever seen', () => {
    const tracker = createInputReadyTracker({ directLaunch: true });
    expect(tracker.ready).toBe(false); // banner painting, paste mode not yet on
    tracker.observe(PASTE_ON, '');
    expect(tracker.ready).toBe(true);
  });

  it('directLaunch + readyTextPattern: still waits for the composer marker', () => {
    const tracker = createInputReadyTracker({ readyTextPattern: AGY_INPUT_READY_PATTERN, directLaunch: true });
    tracker.observe(PASTE_ON, 'Signing in...');
    expect(tracker.ready).toBe(false);
    tracker.observe('', '? for shortcuts');
    expect(tracker.ready).toBe(true);
  });
});

describe('tuiHandshake.verifyPasteRendered', () => {
  it('returns true when prefix is found in buffer', () => {
    const prefix = 'implement the truncateMiddle function';
    const buffer = 'Some TUI chrome... implement the truncateMiddle function ...more text';
    expect(verifyPasteRendered(buffer, prefix)).toBe(true);
  });

  it('returns false when prefix is not found in buffer', () => {
    const prefix = 'implement the truncateMiddle function';
    const buffer = 'Some TUI chrome without the prompt text';
    expect(verifyPasteRendered(buffer, prefix)).toBe(false);
  });

  it('handles whitespace normalization', () => {
    const prefix = 'implement the function';
    const buffer = 'implement   the\n  function';
    expect(verifyPasteRendered(buffer, prefix)).toBe(true);
  });

  it('returns true for null/empty prefix (no verification possible)', () => {
    expect(verifyPasteRendered('any buffer', null)).toBe(true);
    expect(verifyPasteRendered('any buffer', '')).toBe(true);
    expect(verifyPasteRendered('any buffer', undefined)).toBe(true);
  });

  it('returns false for non-string buffer', () => {
    expect(verifyPasteRendered(null, 'prefix')).toBe(false);
    expect(verifyPasteRendered(undefined, 'prefix')).toBe(false);
    expect(verifyPasteRendered(123, 'prefix')).toBe(false);
  });

  it('handles real-world OpenCode scenario (issue #2192)', () => {
    // Simulates the case where OpenCode was still initializing
    const prompt = 'Run /do:next --issues --swarm using the truncateMiddle helper';
    const prefix = extractVerifiablePromptPrefix(prompt);

    // Empty buffer = paste was swallowed
    expect(verifyPasteRendered('', prefix)).toBe(false);

    // Only TUI chrome = paste was swallowed
    expect(verifyPasteRendered('Ask anything... (ESC to exit)', prefix)).toBe(false);

    // Prompt text visible (with the full prompt echoed) = paste succeeded
    // The buffer would contain the actual prompt text after a successful paste
    expect(verifyPasteRendered(`Ask anything... ${prompt}`, prefix)).toBe(true);

    // Also verify partial echo (just the middle portion where the prefix is from)
    expect(verifyPasteRendered(`Ask anything... o:next --issues --swarm using the trunca...`, prefix)).toBe(true);
  });

  // Every claude-code-tui CoS agent started failing immediately after #2192
  // shipped, all with identical "paste-not-rendered" after 3 retries — 100%
  // reproduction across real agent runs (agent-65e4d17f, agent-1f0bda99,
  // agent-ec5a000c, agent-7dda893e, agent-9916b7be, agent-f5c8ca2a,
  // agent-d0fa3cdc, 2026-07-05). Root cause: Claude Code redraws/reflows a
  // pasted multi-word line using cursor-positioning escapes instead of literal
  // space bytes between words — the exact "inter-glyph cursor moves" quirk
  // already documented above (BRACKETED_PASTE_MODE_PATTERN comment) as the
  // reason createInputReadyTracker deliberately avoids literal footer-text
  // matching. #2192's verifyPasteRendered was never carved out for Claude (the
  // changelog claimed "Claude TUIs ... are unaffected" but sendPrompt/
  // attemptPaste is shared across all providers), so it inherited the same
  // trap: normalizing to a SINGLE space still requires a space to exist, and a
  // reflowed line has none. Captured verbatim (post-production-ansiStrip) from
  // agent-147ad88f's raw.txt.
  it('finds a pasted prompt whose words got glued together by Claude Code reflow (real incident)', () => {
    const prompt = 'On the tasks page when we render pending/active/blocked task cards, I want to truncate the prompt and only show the first couple of lines with an expand button\n\nBegin working on the task now.';
    const prefix = extractVerifiablePromptPrefix(prompt);
    const renderedBuffer = '⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents Opus 4.8 (1M context) │ agent-147ad88f [Pastedtext#1+3lines] paste again to expand ctrl+g to edit in Vim ──────── ❯ Onthetaskspagewhenwerenderpending/active/blockedtaskcards,Iwant totruncatethepromptandonlyshowthefirstcoupleoflineswithan expandbutton Begin working on the task now.';
    expect(verifyPasteRendered(renderedBuffer, prefix)).toBe(true);
  });
});

describe('tuiHandshake.isPasteConfirmed', () => {
  const PROMPT = 'On the tasks page when we render pending/active/blocked task cards, I want to truncate the prompt and only show the first couple of lines with an expand button\n\nBegin working on the task now.';
  const prefix = extractVerifiablePromptPrefix(PROMPT);

  // THE core regression: Claude Code collapses a multi-line paste into a
  // `[Pasted text #1 +3 lines]` chip and HIDES the body text. Verbatim
  // (ANSI-stripped) from agent-656efa6e's failed run, 2026-07-05 — the body text
  // ("On the tasks page…") is genuinely absent, only the marker + the trailing
  // "Begin working…" line survive. The old text-only gate false-failed here and
  // killed every claude-code-tui CoS agent after 3 retries. The marker is
  // authoritative proof the paste landed, so this MUST confirm.
  it('confirms a multi-line paste that Claude collapsed to a chip (body text hidden) — real incident', () => {
    const collapsedBuffer = 'Opus 4.8 │ agent-656efa6e [Pastedtext#1+3lines] paste again to expand ──────── ❯ [Pastedtext#1+3lines] ──────── Begin working on the task now. ⏵⏵ bypass permissions on (shift+tab to cycle)';
    // The body prefix really is NOT in the buffer — verifyPasteRendered alone fails…
    expect(verifyPasteRendered(collapsedBuffer, prefix)).toBe(false);
    // …but the marker proves delivery, so isPasteConfirmed confirms it.
    expect(isPasteConfirmed(collapsedBuffer, { verifiablePrefix: prefix, promptMarkerCount: 0 })).toBe(true);
  });

  it('confirms when the prompt text DID render inline (markerless small paste)', () => {
    const inlineBuffer = '❯ Onthetaskspagewhenwerenderpending/active/blockedtaskcards Begin working on the task now.';
    expect(isPasteConfirmed(inlineBuffer, { verifiablePrefix: prefix, promptMarkerCount: 0 })).toBe(true);
  });

  it('does NOT confirm when neither the marker nor the text appears (paste swallowed by a not-ready TUI)', () => {
    const swallowedBuffer = '❯ Try "how does PipelineEditorialChecks.jsx work?" ⏵⏵ bypass permissions on (shift+tab to cycle)';
    expect(isPasteConfirmed(swallowedBuffer, { verifiablePrefix: prefix, promptMarkerCount: 0 })).toBe(false);
  });

  it('ignores paste markers echoed from the prompt itself (count must EXCEED promptMarkerCount)', () => {
    // A transcript-analysis prompt that itself contains a `[Pasted text #1]` chip:
    // the echoed marker must not be mistaken for the TUI's own commit marker.
    const echoOnlyBuffer = '❯ [Pastedtext#1+2lines] analyze this transcript';
    expect(isPasteConfirmed(echoOnlyBuffer, { verifiablePrefix: prefix, promptMarkerCount: 1 })).toBe(false);
    // One MORE marker than the prompt carried → the TUI's genuine commit → confirmed.
    const echoPlusCommit = '❯ [Pastedtext#1+2lines] analyze this transcript [Pastedtext#2+2lines]';
    expect(isPasteConfirmed(echoPlusCommit, { verifiablePrefix: prefix, promptMarkerCount: 1 })).toBe(true);
  });

  // Issue #2228: a MULTI-LINE prompt that itself embeds a `[Pasted text #N]`
  // literal (a TUI-transcript-analysis task — the promptMarkerCount defense was
  // added for exactly this domain). Claude Code collapses the whole multi-line
  // paste into its OWN single chip and hides the body — including the prompt's
  // embedded marker. So the buffer carries only Claude's 1 chip while
  // promptMarkerCount is also 1: `count (1) > promptMarkerCount (1)` is false,
  // AND the hidden body defeats the verifyPasteRendered text fallback. Before the
  // fix this false-negatived and the agent died `paste-not-rendered` despite the
  // paste landing. The collapsed-chip chrome ("paste again to expand") proves the
  // visible marker is the TUI's own commit, so this MUST confirm.
  it('confirms a collapsed multi-line paste even when the prompt embeds a marker literal (#2228)', () => {
    // Prompt is multi-line AND embeds a `[Pasted text #1]` literal → promptMarkerCount = 1.
    const selfMarkerPrompt = 'Analyze this TUI transcript where the agent hit a paste bug:\n\n[Pasted text #1 +40 lines]\n\nExplain why the paste false-negatived.';
    const selfMarkerPrefix = extractVerifiablePromptPrefix(selfMarkerPrompt);
    const promptMarkerCount = 1;
    // Claude collapsed the whole thing to ITS OWN chip and hid the body — only the
    // marker + collapse affordance survive; the prompt body is genuinely gone.
    const collapsedBuffer = 'Opus 4.8 │ agent-2228abcd ❯ [Pastedtext#1+42lines] paste again to expand ──────── ⏵⏵ bypass permissions on (shift+tab to cycle)';
    // The count-only comparison false-negatives (1 is not > 1)…
    expect(countPasteMarkers(collapsedBuffer) > promptMarkerCount).toBe(false);
    // …and the hidden body defeats the text fallback too…
    expect(verifyPasteRendered(collapsedBuffer, selfMarkerPrefix)).toBe(false);
    // …but the collapsed-chip shape proves the paste landed, so this MUST confirm.
    expect(isPasteConfirmed(collapsedBuffer, { verifiablePrefix: selfMarkerPrefix, promptMarkerCount })).toBe(true);
  });

  it('does NOT re-introduce the echoed-marker false-positive: inline (uncollapsed) echo without collapse chrome still rejects (#2228)', () => {
    // The prompt's `[Pasted text #1]` echoed INLINE (uncollapsed) with no
    // "paste again to expand" chrome — the paste has NOT committed. The
    // collapsed-chip rescue must not fire here; the subtraction must still reject.
    const inlineEchoBuffer = '❯ [Pastedtext#1+40lines] analyze this TUI transcript where the agent hit a paste bug';
    expect(isCollapsedPasteChip(inlineEchoBuffer)).toBe(false);
    expect(isPasteConfirmed(inlineEchoBuffer, { verifiablePrefix: prefix, promptMarkerCount: 1 })).toBe(false);
  });

  it('confirms when there is nothing to verify against (no verifiable prefix)', () => {
    expect(isPasteConfirmed('anything at all', { verifiablePrefix: null, promptMarkerCount: 0 })).toBe(true);
    expect(isPasteConfirmed('anything at all', {})).toBe(true);
  });
});

describe('tuiHandshake.isCollapsedPasteChip', () => {
  it('is true only when a marker AND the "paste again to expand" affordance are both present', () => {
    expect(isCollapsedPasteChip('[Pastedtext#1+3lines] paste again to expand')).toBe(true);
    // Marker but no collapse affordance → not a collapsed chip.
    expect(isCollapsedPasteChip('[Pastedtext#1+3lines] analyze this transcript')).toBe(false);
    // Collapse affordance but no marker → nothing committed.
    expect(isCollapsedPasteChip('paste again to expand')).toBe(false);
  });

  it('tolerates the inter-glyph whitespace Claude renders (ANSI-stripped)', () => {
    expect(isCollapsedPasteChip('[Pastedtext#2+9lines] pasteagaintoexpand')).toBe(true);
  });

  it('returns false for non-string / empty input', () => {
    expect(isCollapsedPasteChip(null)).toBe(false);
    expect(isCollapsedPasteChip(undefined)).toBe(false);
    expect(isCollapsedPasteChip('')).toBe(false);
    expect(isCollapsedPasteChip(123)).toBe(false);
  });
});

// ─── Discovery: shipped-catalog parity for the TUI dispatch points ─────────
//
// Adding a coding-agent vendor means touching a spread of per-vendor `if`
// branches, and the failure mode is SILENT: the vendor ships in the seed
// catalog, its provider shows up in the UI and spawns, but a dispatch point
// nobody remembered doesn't know it — so it launches with the wrong binary or
// without its unattended-run posture and stalls on a prompt with nobody to
// answer. (Not theoretical: `resolveInjectedTuiModel` exists because the two
// model-injection sites had already drifted that way — issue #3618.)
//
// These tests DERIVE their expectations by walking `data.reference/providers.json`
// rather than hand-transcribing a vendor list, so a newly-seeded vendor that a
// builder doesn't know about FAILS here instead of diverging in production.
// Same shape as `server/cos-runner/allowedCommands.test.js` (catalog-derived
// parity) and `server/lib/cliChildEnv.test.js` (discovery of a hand-rolled
// call site). Sibling coverage for the model-injection point lives in
// `providerModels.test.js#resolveInjectedTuiModel`.
describe('tuiHandshake — parity with the shipped provider catalog', () => {
  const SEED_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../data.reference/providers.json');
  const seedProviders = Object.entries(
    JSON.parse(readFileSync(SEED_PATH, 'utf8')).providers || {}
  ).map(([id, p]) => ({ ...p, id }));
  // EVERY seeded TUI provider is walked, including one that declares no
  // `command` — that shape is exactly what `inferTuiCommand` exists to resolve,
  // so filtering it out would let a new vendor skip every check below.
  const tuiProviders = seedProviders.filter((p) => p.type === 'tui');
  // The binary a provider actually launches: its own `command`, or whatever the
  // blank-command fallback resolves its id to (what the spawners do).
  const launchCommand = (p) => p.command || inferTuiCommand(p.id);
  const tuiCommands = [...new Set(tuiProviders.map(launchCommand))];
  // Providers that name their own binary, and so can be compared against the
  // fallback. Scoped to the process-spawning types: `inferTuiCommand` is also
  // what `resolveSlashdoStyle` asks "which command will actually be spawned?",
  // which it does for CLI providers too — so they are deliberately in scope,
  // while a future non-process type that happens to carry a `command` is not.
  const PROCESS_TYPES = new Set(['tui', 'cli']);
  const withDeclaredCommand = seedProviders.filter((p) => PROCESS_TYPES.has(p.type) && Boolean(p.command));

  // Commands `applyCommandDefaults` deliberately has NO arm for, and where the
  // unattended-run posture actually comes from. Both are asserted below, so an
  // exemption can't rot into "we just forgot this vendor":
  //   - the builder must still inject nothing for it, and
  //   - the recorded alternate channel must still carry the posture in the seed.
  // A vendor absent from BOTH this map and `applyCommandDefaults` fails.
  //
  // `channel: null` is the escape hatch for a binary that genuinely needs no
  // unattended posture at all — it must carry a `reason`, so the next vendor
  // resolves this by making a documented call rather than inventing a marker
  // string to satisfy the assertion.
  const POSTURE_NOT_FROM_BUILDER = new Map([
    // claude's `--dangerously-skip-permissions` rides in the seed `args`.
    ['claude', { channel: 'args', marker: '--dangerously-skip-permissions' }],
    // opencode has no argv approval/trust gate; its permission posture is
    // configured through OPENCODE_CONFIG_CONTENT (see cliChildEnv.js).
    ['opencode', { channel: 'envVars', marker: '"permission":"allow"' }],
  ]);

  it('parses the shipped catalog (guards against a silently empty walk)', () => {
    expect(seedProviders.length).toBeGreaterThan(0);
    expect(tuiProviders.length).toBeGreaterThan(0);
    expect(withDeclaredCommand.length).toBeGreaterThan(0);
    // More than one distinct binary, or the per-command loops below prove nothing.
    expect(tuiCommands.length).toBeGreaterThan(1);
  });

  // `inferTuiCommand` is the blank-`provider.command` fallback for BOTH spawners
  // and the binary `resolveSlashdoStyle` asks about before deciding whether a
  // session can type `/do:pr`. A vendor missing from its map silently resolves
  // to `claude` — the wrong binary, told to run slash commands it doesn't have.
  //
  // Only providers that DECLARE a command can be checked here (there is nothing
  // to compare against otherwise); every seeded id happens to name its vendor,
  // which is the property this pins. A new provider that legitimately can't
  // satisfy it should be renamed to name its vendor, not exempted — the
  // fallback has no other signal to work from.
  it.each(withDeclaredCommand.map((p) => [p.id, p.command]))(
    'inferTuiCommand("%s") resolves to the catalog command "%s"',
    (id, command) => {
      expect(inferTuiCommand(id)).toBe(command);
    }
  );

  // `applyCommandDefaults` is the TUI approval/trust-argv dispatch. A vendor
  // with no arm falls through `return args` unchanged and launches interactive,
  // then stalls on its first tool-approval prompt with nobody at the keyboard.
  describe.each(tuiCommands)('applyCommandDefaults("%s")', (command) => {
    const exemption = POSTURE_NOT_FROM_BUILDER.get(command);

    if (exemption) {
      it('injects nothing (its posture comes from another channel)', () => {
        expect(applyCommandDefaults(command, [])).toEqual([]);
      });

      if (exemption.channel) {
        it(`still gets its unattended posture from the seed ${exemption.channel}`, () => {
          for (const provider of tuiProviders.filter((p) => launchCommand(p) === command)) {
            const args = provider.args || [];
            const declared = exemption.channel === 'args'
              // Exact argv membership, not a substring of the joined argv — a
              // marker that is a prefix of some longer flag would match anything.
              ? args.includes(exemption.marker)
              // The env VALUES verbatim — not JSON.stringify of the map, which
              // would re-escape the quotes inside OPENCODE_CONFIG_CONTENT's own
              // embedded JSON and never match the marker.
              : Object.values(provider.envVars || {}).join(' ').includes(exemption.marker);
            expect(declared, `${provider.id} must declare ${exemption.marker} in its ${exemption.channel}`)
              .toBe(true);
          }
        });
      } else {
        it('is recorded as needing no unattended posture at all', () => {
          expect(exemption.reason, `${command}'s channel-less exemption must carry a reason`)
            .toBeTruthy();
        });
      }
    } else {
      it('has a dispatch arm that injects an unattended-run posture', () => {
        expect(
          applyCommandDefaults(command, []),
          `No applyCommandDefaults arm for "${command}". Add one (see ensureCursorTuiArgs), `
          + 'or record why its posture arrives another way in POSTURE_NOT_FROM_BUILDER.'
        ).not.toEqual([]);
      });
    }
  });

  // Each spawn path calls applyCommandDefaults on argv that may ALREADY carry
  // the seed's posture flags, so a non-idempotent arm double-appends — codex
  // errors outright on a repeated approval flag, and every other vendor grows a
  // duplicated argv that's a coin flip on which wins.
  it.each(tuiProviders.map((p) => [p.id, launchCommand(p), p.args || []]))(
    'applyCommandDefaults is idempotent over the seed args of "%s" (%s)',
    (_id, command, args) => {
      const once = applyCommandDefaults(command, [...args]);
      expect(applyCommandDefaults(command, [...once])).toEqual(once);
    }
  );

  // End-to-end over the two dispatch points at once: a provider whose `command`
  // is blank (older stored configs, and the shape `buildTuiSpawnConfig` handles)
  // must land on exactly the same invocation as the fully-specified one.
  it.each(tuiProviders.map((p) => [p.id, p]))(
    'buildTuiInvocation("%s") is identical with and without an explicit command',
    (_id, provider) => {
      // Right-hand side is pinned to the RESOLVED binary rather than `provider`
      // as-seeded: a provider that already ships a blank command would
      // otherwise compare blank against blank and pass vacuously.
      expect(buildTuiInvocation({ ...provider, command: '' }))
        .toEqual(buildTuiInvocation({ ...provider, command: launchCommand(provider) }));
    }
  );
});
