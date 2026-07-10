import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'fs';

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
  const realPlatform = process.platform;
  const setPlatform = (p) => Object.defineProperty(process, 'platform', { value: p, configurable: true });
  afterEach(() => setPlatform(realPlatform));

  it('is a stdin no-op on POSIX (prompt delivered via /dev/stdin)', () => {
    setPlatform('darwin');
    const args = ['--prompt-file', '/dev/stdin'];
    const res = prepareGrokPromptFile(args, 'hello');
    expect(res.useStdin).toBe(true);
    expect(res.args).toBe(args);
  });

  it('is a no-op for a non-grok argv even on Windows', () => {
    setPlatform('win32');
    const args = ['-p', '-'];
    const res = prepareGrokPromptFile(args, 'hello');
    expect(res.useStdin).toBe(true);
    expect(res.args).toEqual(['-p', '-']);
  });

  it('writes a temp file and rewrites the separated sentinel on Windows', () => {
    setPlatform('win32');
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
    setPlatform('win32');
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
    setPlatform('win32');
    const mk = () => prepareGrokPromptFile(['--prompt-file', '/dev/stdin'], 'x');
    const a = mk(); const b = mk();
    const fileA = a.args[a.args.indexOf('--prompt-file') + 1];
    const fileB = b.args[b.args.indexOf('--prompt-file') + 1];
    expect(fileA).not.toBe(fileB);
    a.cleanup(); b.cleanup();
  });
});
