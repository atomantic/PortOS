import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync } from 'fs';
import { pinPlatform } from './testHelper.js';

import {
  GROK_API_ID,
  GROK_CLI_ID,
  GROK_TUI_ID,
  GROK_API_ENDPOINT,
  GROK_STDIN_PROMPT_PATH,
  isGrokCommand,
  isGrokCliProvider,
  isGrokTuiProvider,
  ensureGrokHeadlessArgs,
  ensureGrokTuiArgs,
  prepareGrokPromptFile,
  extractGrokFinalMessage,
  grokReviewFinishReason,
  GROK_CODE_REVIEW_JSON_SCHEMA,
  withGrokCodeReviewOutput,
  withGrokStreamingJsonOutput,
  grokSpeedTarget,
  grokServiceTierModel,
} from './grok.js';

describe('grok — constants', () => {
  it('exposes the expected ids, endpoint, and stdin prompt path', () => {
    expect(GROK_API_ID).toBe('grok');
    expect(GROK_CLI_ID).toBe('grok-cli');
    expect(GROK_TUI_ID).toBe('grok-tui');
    expect(GROK_API_ENDPOINT).toBe('https://api.x.ai/v1');
    expect(GROK_STDIN_PROMPT_PATH).toBe('/dev/stdin');
  });
});

describe('grok — isGrokCommand', () => {
  it('matches the bare binary, absolute paths, and .exe', () => {
    expect(isGrokCommand('grok')).toBe(true);
    expect(isGrokCommand('/Users/me/.local/bin/grok')).toBe(true);
    expect(isGrokCommand('C:\\tools\\grok.exe')).toBe(true);
    expect(isGrokCommand('GROK')).toBe(true);
  });
  it('rejects non-grok commands and empty/invalid input', () => {
    expect(isGrokCommand('claude')).toBe(false);
    expect(isGrokCommand('grokker')).toBe(false);
    expect(isGrokCommand('')).toBe(false);
    expect(isGrokCommand(null)).toBe(false);
    expect(isGrokCommand(undefined)).toBe(false);
  });
});

describe('grok — provider predicates', () => {
  it('identifies the cli provider by id or by cli-type command', () => {
    expect(isGrokCliProvider({ id: 'grok-cli' })).toBe(true);
    expect(isGrokCliProvider({ id: 'custom', type: 'cli', command: 'grok' })).toBe(true);
    expect(isGrokCliProvider({ id: 'grok', type: 'api', command: 'grok' })).toBe(false);
  });
  it('identifies the tui provider by id or by tui-type command', () => {
    expect(isGrokTuiProvider({ id: 'grok-tui' })).toBe(true);
    expect(isGrokTuiProvider({ id: 'custom', type: 'tui', command: 'grok' })).toBe(true);
    expect(isGrokTuiProvider({ id: 'grok-cli', type: 'cli', command: 'grok' })).toBe(false);
  });
});

describe('grok — ensureGrokHeadlessArgs', () => {
  it('injects plain output, permission bypass, model, and the stdin prompt file when a concrete model is given', () => {
    expect(ensureGrokHeadlessArgs([], 'grok-code-fast-1')).toEqual([
      '--output-format', 'plain',
      '--permission-mode', 'bypassPermissions',
      '--model', 'grok-code-fast-1',
      '--prompt-file', '/dev/stdin',
    ]);
  });

  it('omits --model when no model is given (configured-default / latest)', () => {
    expect(ensureGrokHeadlessArgs([], null)).toEqual([
      '--output-format', 'plain',
      '--permission-mode', 'bypassPermissions',
      '--prompt-file', '/dev/stdin',
    ]);
  });

  it('does not override a user-pinned output format, permission mode, model, or prompt source', () => {
    const out = ensureGrokHeadlessArgs(
      ['--output-format', 'json', '--permission-mode', 'default', '--model', 'grok-4', '--prompt-file', '/my/prompt.txt'],
      'grok-code-fast-1',
    );
    expect(out.filter((a) => a === '--output-format')).toHaveLength(1);
    expect(out.filter((a) => a === '--permission-mode')).toHaveLength(1);
    expect(out.filter((a) => a === '--model')).toHaveLength(1);
    expect(out.filter((a) => a === '--prompt-file')).toHaveLength(1);
    expect(out).toContain('grok-4');
    expect(out).not.toContain('grok-code-fast-1');
    expect(out).not.toContain('/dev/stdin');
  });

  it('treats --always-approve as an existing permission posture', () => {
    const out = ensureGrokHeadlessArgs(['--always-approve'], null);
    expect(out).not.toContain('--permission-mode');
    expect(out).toContain('--always-approve');
  });
});

describe('grok — ensureGrokTuiArgs', () => {
  it('adds bypassPermissions by default', () => {
    expect(ensureGrokTuiArgs([])).toEqual(['--permission-mode', 'bypassPermissions']);
  });
  it('is idempotent when a permission posture is already pinned', () => {
    expect(ensureGrokTuiArgs(['--permission-mode', 'auto'])).toEqual(['--permission-mode', 'auto']);
    expect(ensureGrokTuiArgs(['--always-approve'])).toEqual(['--always-approve']);
  });
});

describe('grok — prepareGrokPromptFile', () => {
  // Captured before any pin so the restore reinstates the pristine descriptor.
  let restorePlatform = () => {};
  beforeEach(() => { restorePlatform = pinPlatform(process.platform); });
  afterEach(() => restorePlatform());

  it('is a stdin no-op on POSIX (prompt delivered via /dev/stdin)', () => {
    pinPlatform('darwin');
    const args = ['--prompt-file', '/dev/stdin'];
    const res = prepareGrokPromptFile(args, 'hello');
    expect(res.useStdin).toBe(true);
    expect(res.args).toBe(args);
  });

  it('is a no-op for a non-grok argv even on Windows', () => {
    pinPlatform('win32');
    const args = ['-p', '-'];
    const res = prepareGrokPromptFile(args, 'hello');
    expect(res.useStdin).toBe(true);
    expect(res.args).toEqual(['-p', '-']);
  });

  it('writes a temp file and rewrites the separated sentinel on Windows', () => {
    pinPlatform('win32');
    const args = ['--output-format', 'plain', '--prompt-file', '/dev/stdin'];
    const res = prepareGrokPromptFile(args, 'my prompt body');
    expect(res.useStdin).toBe(false);
    const idx = res.args.indexOf('--prompt-file') + 1;
    const file = res.args[idx];
    expect(file).not.toBe('/dev/stdin');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('my prompt body');
    res.cleanup();
    expect(existsSync(file)).toBe(false);
  });

  it('rewrites the joined --prompt-file=/dev/stdin form on Windows too', () => {
    pinPlatform('win32');
    const args = ['--output-format', 'plain', '--prompt-file=/dev/stdin'];
    const res = prepareGrokPromptFile(args, 'joined body');
    expect(res.useStdin).toBe(false);
    const rewritten = res.args.find((a) => a.startsWith('--prompt-file='));
    const file = rewritten.slice('--prompt-file='.length);
    expect(file).not.toBe('/dev/stdin');
    expect(res.args).not.toContain('--prompt-file=/dev/stdin');
    expect(readFileSync(file, 'utf8')).toBe('joined body');
    res.cleanup();
    expect(existsSync(file)).toBe(false);
  });

  it('uses a unique temp filename per call (no collision under concurrency)', () => {
    pinPlatform('win32');
    const mk = () => prepareGrokPromptFile(['--prompt-file', '/dev/stdin'], 'x');
    const a = mk(); const b = mk();
    const fileA = a.args[a.args.indexOf('--prompt-file') + 1];
    const fileB = b.args[b.args.indexOf('--prompt-file') + 1];
    expect(fileA).not.toBe(fileB);
    a.cleanup(); b.cleanup();
  });

  it('can report an uncertain prompt-file cleanup without changing best-effort callers', () => {
    pinPlatform('win32');
    const result = prepareGrokPromptFile(['--prompt-file', '/dev/stdin'], 'synthetic prompt');
    const file = result.args[result.args.indexOf('--prompt-file') + 1];
    unlinkSync(file);
    mkdirSync(file);
    try {
      expect(() => result.cleanup()).not.toThrow();
      expect(() => result.cleanup({ throwOnError: true })).toThrow();
    } finally {
      rmSync(file, { recursive: true, force: true });
    }
    expect(() => result.cleanup({ throwOnError: true })).not.toThrow();
  });
});

describe('grok — streaming-json final message', () => {
  const line = (event) => JSON.stringify(event);
  const text = (...chunks) => chunks.map((data) => line({ type: 'text', data }));

  // #14391: plain output returned `narration{"verdict":…}` as one string.
  it('drops narration before a tool call and keeps the answer chunks after it', () => {
    const transcript = [
      line({ type: 'available_commands', tools: [] }),
      ...text("I'll inspect", ' the code.'),
      line({ type: 'thought', data: 'thinking' }),
      line({ type: 'tool_call', toolName: 'grep' }),
      line({ type: 'tool_call_update', status: 'completed' }),
      'not json',
      ...text('{"verdict":', '"clean","findings":[]}'),
      line({ type: 'usage', usage: {} }),
      line({ type: 'end', stopReason: 'end_turn' }),
    ].join('\n');
    expect(extractGrokFinalMessage(transcript)).toBe('{"verdict":"clean","findings":[]}');
  });

  it('returns a tool-free run whole and an empty string when nothing was said', () => {
    expect(extractGrokFinalMessage(text('{"a":', '1}').join('\n'))).toBe('{"a":1}');
    expect(extractGrokFinalMessage(line({ type: 'end' }))).toBe('');
    expect(extractGrokFinalMessage(undefined)).toBe('');
  });

  // #14523: a no-tool review told to inspect the checkout emitted this shape —
  // `text` deltas, a short `thought`, no `tool_call`. The concatenation was
  // prose (no brace, fence, or verdict) and the parser must keep rejecting it.
  // The same event types carrying an exact envelope are the verdict.
  it('keeps a prose-only transcript out of the verdict and returns an exact envelope', () => {
    const prose = [
      line({ type: 'available_commands', tools: [] }),
      line({ type: 'thought', data: 'note' }),
      ...text('The diff changes a counter. ', 'I would inspect the callers next.'),
      line({ type: 'usage', usage: {} }),
      line({ type: 'end', stopReason: 'end_turn' }),
    ].join('\n');
    const extracted = extractGrokFinalMessage(prose);
    expect(extracted).toBe('The diff changes a counter. I would inspect the callers next.');
    expect(extracted).not.toMatch(/[{`]/);
    expect(extracted).not.toContain('verdict');
    expect(grokReviewFinishReason(prose)).toBe('stop');

    const envelope = '{"verdict":"clean","findings":[]}';
    const verdict = [
      line({ type: 'available_commands', tools: [] }),
      line({ type: 'thought', data: 'note' }),
      ...text(envelope.slice(0, 12), envelope.slice(12)),
      line({ type: 'end', stopReason: 'end_turn' }),
    ].join('\n');
    expect(extractGrokFinalMessage(verdict)).toBe(envelope);
    expect(grokReviewFinishReason(verdict)).toBe('stop');
    expect(grokReviewFinishReason(line({ type: 'end', stopReason: 'max_tokens' }))).toBe('length');
    expect(grokReviewFinishReason(line({ type: 'end', stopReason: 'vendor-specific' }))).toBe('unknown');
    expect(grokReviewFinishReason(undefined)).toBe('unknown');
  });

  it('replaces any pinned output format with streaming-json', () => {
    for (const pinned of [['--output-format', 'plain'], ['-o', 'json'], ['--output-format=json']]) {
      expect(withGrokStreamingJsonOutput(['--model', 'm', ...pinned, '--prompt-file', '/dev/stdin']))
        .toEqual(['--model', 'm', '--prompt-file', '/dev/stdin', '--output-format', 'streaming-json']);
    }
  });

  it('constrains a code review to streaming-json and the verdict schema', () => {
    const args = withGrokCodeReviewOutput([
      '--model', 'm', '--output-format', 'plain', '--json-schema', '{"type":"string"}', '--prompt-file', '/dev/stdin',
    ]);
    expect(args).toEqual([
      '--model', 'm', '--prompt-file', '/dev/stdin', '--output-format', 'streaming-json',
      '--json-schema', JSON.stringify(GROK_CODE_REVIEW_JSON_SCHEMA),
    ]);
    expect(JSON.parse(args.at(-1)).properties.verdict.enum).toEqual(['clean', 'findings']);
  });
});

describe('grok — speed pairing', () => {
  const ids = ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6', 'grok-code-fast-1'];

  it('advertises both tiers only when the catalog lists the base and its -build-fast sibling', () => {
    expect(grokSpeedTarget('grok-4.7', ids)).toEqual({
      model: 'grok-4.7', modelBase: 'grok-4.7', values: ['standard', 'fast'], reason: null,
    });
    expect(grokSpeedTarget('grok-4.7-build-fast', ids)).toEqual({
      model: 'grok-4.7-build-fast', modelBase: 'grok-4.7', values: ['standard', 'fast'], reason: null,
    });
  });

  it('does not treat a generic -fast id, or a model with no sibling, as a fast tier', () => {
    expect(grokSpeedTarget('grok-code-fast-1', ids).values).toEqual([]);
    expect(grokSpeedTarget('grok-code-fast-1', ids).reason).toMatch(/did not advertise/);
    expect(grokSpeedTarget('grok-4.6', ids).modelBase).toBeNull();
    expect(grokSpeedTarget('grok-configured-default', ['grok-4.6'], null).reason).toMatch(/explicit model/);
  });

  it('uses the catalog default for the configured-default sentinel', () => {
    expect(grokSpeedTarget('grok-configured-default', ids, 'grok-4.7-build-fast')).toMatchObject({
      model: 'grok-4.7-build-fast', modelBase: 'grok-4.7', values: ['standard', 'fast'],
    });
  });

  it('requests fast and standard as a model setting and does not guess a flat fast id', () => {
    expect(grokServiceTierModel('grok-4.7', 'fast', 'grok-4.7')).toBe('grok-4.7[fast=true]');
    expect(grokServiceTierModel('grok-4.7-build-fast', 'standard', 'grok-4.7')).toBe('grok-4.7[fast=false]');
    expect(grokServiceTierModel(null, 'fast', 'grok-4.7')).toBe('grok-4.7[fast=true]');
    expect(grokServiceTierModel('grok-4.7-build-fast', 'fast', null)).toBeNull();
    expect(grokServiceTierModel('grok-configured-default', 'standard', null)).toBeNull();
    expect(grokServiceTierModel('grok-code-fast-1', null, null)).toBe('grok-code-fast-1');
  });
});
