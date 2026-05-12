import { describe, it, expect, vi, beforeEach } from 'vitest';
import EventEmitter from 'events';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: vi.fn() };
});

vi.mock('../lib/fileUtils.js', () => ({
  ensureDir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue('{}'),
}));

const { spawn } = await import('child_process');
const runner = await import('./runner.js');
const { setAIToolkit, executeCliRun, buildCliArgs, hasModelFlag, extractBakedModel } = runner;

// Minimal toolkit stub that satisfies executeCliRun's expectations
function fakeToolkit() {
  return {
    services: {
      runner: { _portosActiveRuns: new Map() },
      errorDetection: null,
    },
  };
}

function makeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.kill = vi.fn();
  child.killed = false;
  return child;
}

beforeEach(() => {
  vi.clearAllMocks();
  setAIToolkit(fakeToolkit(), { dataDir: '/tmp/test-runner' });
});

describe('executeCliRun — Codex sentinel suppression', () => {
  it('omits --model when defaultModel is codex-configured-default', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);

    const provider = {
      id: 'codex',
      command: 'codex',
      args: [],
      defaultModel: 'codex-configured-default',
      timeout: 5000,
    };

    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('output'));
      child.emit('close', 0);
    });

    await executeCliRun('run-1', provider, 'test prompt', '/workspace');

    const [, capturedArgs] = spawn.mock.calls.at(-1);
    expect(capturedArgs).not.toContain('--model');
    expect(capturedArgs).not.toContain('codex-configured-default');
    // Should still have the exec subcommand and stdin marker
    expect(capturedArgs).toContain('exec');
    expect(capturedArgs).toContain('-');
  });

  it('passes --model when a real model name is provided', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);

    const provider = {
      id: 'codex',
      command: 'codex',
      args: [],
      defaultModel: 'o4-mini',
      timeout: 5000,
    };

    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('output'));
      child.emit('close', 0);
    });

    await executeCliRun('run-2', provider, 'test prompt', '/workspace');

    const [, capturedArgs] = spawn.mock.calls.at(-1);
    const modelIdx = capturedArgs.indexOf('--model');
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(capturedArgs[modelIdx + 1]).toBe('o4-mini');
  });
});

describe('buildCliArgs — claude-code defaultModel honoring', () => {
  it('appends --model <id> after `-p -` for claude-code', () => {
    const provider = { id: 'claude-code', command: 'claude', args: [], defaultModel: 'claude-opus-4-7' };
    const args = buildCliArgs(provider);
    expect(args).toEqual(['-p', '-', '--model', 'claude-opus-4-7']);
  });

  it('omits --model when defaultModel is unset', () => {
    const provider = { id: 'claude-code', command: 'claude', args: [], defaultModel: null };
    const args = buildCliArgs(provider);
    expect(args).toEqual(['-p', '-']);
  });

  it('respects a user-baked --model in provider.args and does NOT duplicate', () => {
    const provider = {
      id: 'claude-code',
      command: 'claude',
      args: ['--model', 'claude-sonnet-4-5'],
      defaultModel: 'claude-opus-4-7',
    };
    const args = buildCliArgs(provider);
    // baked model wins, no extra trailing flag
    expect(args).toEqual(['--model', 'claude-sonnet-4-5', '-p', '-']);
    expect(args.filter((a) => a === '--model').length).toBe(1);
  });

  it('respects a user-baked --model=value joined form', () => {
    const provider = {
      id: 'claude-code',
      command: 'claude',
      args: ['--model=claude-sonnet-4-5'],
      defaultModel: 'claude-opus-4-7',
    };
    const args = buildCliArgs(provider);
    expect(args).toEqual(['--model=claude-sonnet-4-5', '-p', '-']);
  });
});

describe('buildCliArgs — gemini-cli defaultModel honoring', () => {
  it('appends -m <id> for gemini-cli', () => {
    const provider = { id: 'gemini-cli', command: 'gemini', args: [], defaultModel: 'gemini-2.5-pro' };
    const args = buildCliArgs(provider);
    expect(args).toEqual(['-m', 'gemini-2.5-pro']);
  });

  it('omits -m when defaultModel is unset', () => {
    const provider = { id: 'gemini-cli', command: 'gemini', args: [], defaultModel: null };
    const args = buildCliArgs(provider);
    expect(args).toEqual([]);
  });

  it('respects a user-baked -m in provider.args', () => {
    const provider = {
      id: 'gemini-cli',
      command: 'gemini',
      args: ['-m', 'gemini-2.0-flash'],
      defaultModel: 'gemini-2.5-pro',
    };
    const args = buildCliArgs(provider);
    expect(args).toEqual(['-m', 'gemini-2.0-flash']);
    expect(args.filter((a) => a === '-m').length).toBe(1);
  });

  it('respects a user-baked --model in provider.args (long-form)', () => {
    const provider = {
      id: 'gemini-cli',
      command: 'gemini',
      args: ['--model', 'gemini-2.0-flash'],
      defaultModel: 'gemini-2.5-pro',
    };
    const args = buildCliArgs(provider);
    expect(args).toEqual(['--model', 'gemini-2.0-flash']);
  });
});

describe('buildCliArgs — codex (regression coverage for the existing logic)', () => {
  it('omits --model when defaultModel is the sentinel', () => {
    const provider = { id: 'codex', command: 'codex', args: [], defaultModel: 'codex-configured-default' };
    const args = buildCliArgs(provider);
    expect(args).toEqual(['exec', '-']);
  });

  it('appends --model when a real model is given', () => {
    const provider = { id: 'codex', command: 'codex', args: [], defaultModel: 'o4-mini' };
    const args = buildCliArgs(provider);
    expect(args).toEqual(['exec', '--model', 'o4-mini', '-']);
  });
});

describe('buildCliArgs — strips dangling --model from baseArgs before injecting', () => {
  it('drops a bare --model at end of args (claude-code) and appends the valid one', () => {
    const provider = { id: 'claude-code', command: 'claude', args: ['--model'], defaultModel: 'sonnet-3.7' };
    const args = buildCliArgs(provider);
    // Bare --model would survive into argv and conflict with our injected
    // --model sonnet-3.7. The sanitizer drops it so only the valid pair remains.
    expect(args).toEqual(['-p', '-', '--model', 'sonnet-3.7']);
  });

  it('drops a --model followed by another flag (gemini-cli) and appends the valid one', () => {
    const provider = { id: 'gemini-cli', command: 'gemini', args: ['-m', '--other'], defaultModel: 'gemini-flash' };
    const args = buildCliArgs(provider);
    expect(args).toEqual(['--other', '-m', 'gemini-flash']);
  });

  it('drops an empty joined model flag (--model=) and appends the valid one', () => {
    const provider = { id: 'claude-code', command: 'claude', args: ['--model='], defaultModel: 'sonnet-3.7' };
    const args = buildCliArgs(provider);
    expect(args).toEqual(['-p', '-', '--model', 'sonnet-3.7']);
  });

  it('drops dangling --model on codex too (regression)', () => {
    const provider = { id: 'codex', command: 'codex', args: ['--model'], defaultModel: 'o4-mini' };
    const args = buildCliArgs(provider);
    expect(args).toEqual(['exec', '--model', 'o4-mini', '-']);
  });

  it('preserves a properly-pinned --model and does NOT inject our own', () => {
    const provider = { id: 'claude-code', command: 'claude', args: ['--model', 'baked-in'], defaultModel: 'would-be-ignored' };
    const args = buildCliArgs(provider);
    expect(args).toEqual(['--model', 'baked-in', '-p', '-']);
  });
});

describe('hasModelFlag', () => {
  it('detects separated long form (--model X)', () => {
    expect(hasModelFlag(['--model', 'foo'])).toBe(true);
  });
  it('detects separated short form (-m X)', () => {
    expect(hasModelFlag(['-m', 'foo'])).toBe(true);
  });
  it('detects joined long form (--model=X)', () => {
    expect(hasModelFlag(['--model=foo'])).toBe(true);
  });
  it('detects joined short form (-m=X)', () => {
    expect(hasModelFlag(['-m=foo'])).toBe(true);
  });
  it('returns false when no model flag is present', () => {
    expect(hasModelFlag(['--other', 'foo'])).toBe(false);
    expect(hasModelFlag([])).toBe(false);
  });
  it('returns false for non-array input', () => {
    expect(hasModelFlag(null)).toBe(false);
    expect(hasModelFlag(undefined)).toBe(false);
    expect(hasModelFlag('--model foo')).toBe(false);
  });
  it('returns false for a separated flag at end of argv (no value follows)', () => {
    expect(hasModelFlag(['--model'])).toBe(false);
    expect(hasModelFlag(['-m'])).toBe(false);
    expect(hasModelFlag(['--other', '--model'])).toBe(false);
  });
  it('returns false when the value following looks like another flag', () => {
    expect(hasModelFlag(['--model', '--other'])).toBe(false);
    expect(hasModelFlag(['-m', '-x'])).toBe(false);
  });
  it('returns false for an empty joined value (--model= / -m=)', () => {
    expect(hasModelFlag(['--model='])).toBe(false);
    expect(hasModelFlag(['-m='])).toBe(false);
  });
});

describe('extractBakedModel', () => {
  it('extracts from separated long form', () => {
    expect(extractBakedModel(['--model', 'sonnet-3.7'])).toBe('sonnet-3.7');
  });
  it('extracts from separated short form', () => {
    expect(extractBakedModel(['-m', 'gemini-2.5-pro'])).toBe('gemini-2.5-pro');
  });
  it('extracts from joined long form', () => {
    expect(extractBakedModel(['--model=opus-4.7'])).toBe('opus-4.7');
  });
  it('extracts from joined short form', () => {
    expect(extractBakedModel(['-m=gemini-flash'])).toBe('gemini-flash');
  });
  it('returns null when separated form has no value following the flag', () => {
    expect(extractBakedModel(['--model'])).toBe(null);
  });
  it('returns null when the value following looks like another flag (matches hasModelFlag)', () => {
    // Without this guard, extractBakedModel would extract '--other' as the
    // model id while hasModelFlag returned false, leaving the two functions
    // out of sync. Both must agree on what counts as a real pin.
    expect(extractBakedModel(['--model', '--other'])).toBe(null);
    expect(extractBakedModel(['-m', '-x'])).toBe(null);
  });
  it('returns null when no model flag is present', () => {
    expect(extractBakedModel(['--other', 'foo'])).toBe(null);
    expect(extractBakedModel([])).toBe(null);
  });
  it('returns null for non-array input', () => {
    expect(extractBakedModel(null)).toBe(null);
    expect(extractBakedModel(undefined)).toBe(null);
  });
  it('returns the FIRST baked flag when more than one is present', () => {
    expect(extractBakedModel(['--model', 'first', '-m', 'second'])).toBe('first');
  });
});
