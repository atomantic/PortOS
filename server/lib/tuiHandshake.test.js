import { describe, it, expect } from 'vitest';
import {
  READY_POLL_INTERVAL_MS,
  READY_IDLE_THRESHOLD_MS,
  PASTE_DEADLINE_MS,
  PASTE_MARKER_POLL_MS,
  PASTE_MARKER_PATTERN,
  PASTE_TO_ENTER_MIN_DELAY_MS,
  PASTE_TO_ENTER_FALLBACK_MS,
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

  it('PASTE_MARKER_PATTERN does NOT match similar-looking but distinct text', () => {
    expect(PASTE_MARKER_PATTERN.test('[Pasted text]')).toBe(false);
    expect(PASTE_MARKER_PATTERN.test('[Pasted #1]')).toBe(false);
    expect(PASTE_MARKER_PATTERN.test('Pasted text #1')).toBe(false);
    expect(PASTE_MARKER_PATTERN.test('')).toBe(false);
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
  it('injects `--ask-for-approval never` for codex when not already present', () => {
    expect(applyCommandDefaults('codex', ['exec', '-'])).toEqual([
      '--ask-for-approval', 'never', 'exec', '-',
    ]);
  });

  it('passes codex args through unchanged when --ask-for-approval is already present', () => {
    const args = ['--ask-for-approval', 'auto-edit', 'exec', '-'];
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
    expect(out.args).toEqual(['--ask-for-approval', 'never']);
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
    expect(out.args).toEqual(['--ask-for-approval', 'never', 'exec', '-']);
  });

  it('skips --model injection when model is null/undefined/empty', () => {
    const provider = { id: 'claude', args: ['-p', '-'] };
    expect(buildTuiInvocation(provider, null).args).toEqual(['-p', '-']);
    expect(buildTuiInvocation(provider, undefined).args).toEqual(['-p', '-']);
    expect(buildTuiInvocation(provider, '').args).toEqual(['-p', '-']);
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
