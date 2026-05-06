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
const { setAIToolkit, executeCliRun } = runner;

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
