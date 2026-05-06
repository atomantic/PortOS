import { describe, it, expect, vi, beforeEach } from 'vitest';
import EventEmitter from 'events';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: vi.fn() };
});

vi.mock('../../lib/fileUtils.js', () => ({
  PATHS: { data: '/tmp/wr-eval-test' },
  atomicWrite: vi.fn().mockResolvedValue(undefined),
  ensureDir: vi.fn().mockResolvedValue(undefined),
  safeJSONParse: vi.fn((v) => (typeof v === 'string' ? JSON.parse(v) : v)),
}));

vi.mock('../providers.js', () => ({
  getActiveProvider: vi.fn(),
  getProviderById: vi.fn(),
}));

vi.mock('../promptService.js', () => ({
  buildPrompt: vi.fn().mockResolvedValue('test prompt'),
  getStage: vi.fn().mockReturnValue({ stage: 'writers-room-evaluate', model: null }),
}));

vi.mock('./local.js', () => ({
  getWorkWithBody: vi.fn(),
}));

vi.mock('./characters.js', () => ({
  listCharacters: vi.fn().mockResolvedValue([]),
  mergeExtractedCharacters: vi.fn().mockResolvedValue([]),
}));

vi.mock('./settings.js', () => ({
  listSettings: vi.fn().mockResolvedValue([]),
  mergeExtractedSettings: vi.fn().mockResolvedValue([]),
}));

const { spawn } = await import('child_process');
const providers = await import('../providers.js');
const local = await import('./local.js');
const evaluator = await import('./evaluator.js');
const { runAnalysis } = evaluator;

// A minimal work manifest + body that satisfies runAnalysis's guard checks
// (WORK_ID_RE requires wr-work- followed by only hex digits and dashes)
const FAKE_WORK_ID = 'wr-work-aabbccdd-eeff-1122-3344-556677889900';
const fakeWorkManifest = {
  id: FAKE_WORK_ID,
  title: 'Test Work',
  kind: 'novel',
  status: 'drafting',
  activeDraftVersionId: 'wr-draft-v1',
  drafts: [{ id: 'wr-draft-v1', wordCount: 10, contentHash: 'abc123' }],
};

function makeChild(exitCode = 0) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { on: vi.fn(), end: vi.fn() };
  child.kill = vi.fn();
  child.killed = false;
  return child;
}

beforeEach(() => {
  vi.clearAllMocks();
  local.getWorkWithBody.mockResolvedValue({
    manifest: fakeWorkManifest,
    body: 'Once upon a time there was a test.',
  });
});

describe('evaluator buildCliInvocation — Codex sentinel suppression', () => {
  it('omits --model when the model is codex-configured-default', async () => {
    providers.getActiveProvider.mockResolvedValue({
      id: 'codex',
      type: 'cli',
      enabled: true,
      command: 'codex',
      args: [],
      defaultModel: 'codex-configured-default',
      timeout: 5000,
    });

    const child = makeChild();
    spawn.mockReturnValue(child);

    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ logline: 'a', summary: 'b', themes: [], strengths: [], issues: [], suggestions: [] })));
      child.emit('close', 0);
    });

    await runAnalysis(FAKE_WORK_ID, { kind: 'evaluate' });

    const [, capturedArgs] = spawn.mock.calls.at(-1);
    expect(capturedArgs).not.toContain('--model');
    expect(capturedArgs).not.toContain('codex-configured-default');
    // Codex exec + stdin marker must still be present
    expect(capturedArgs).toContain('exec');
    expect(capturedArgs).toContain('-');
  });

  it('passes --model when a real model name is provided', async () => {
    providers.getActiveProvider.mockResolvedValue({
      id: 'codex',
      type: 'cli',
      enabled: true,
      command: 'codex',
      args: [],
      defaultModel: 'o4-mini',
      timeout: 5000,
    });

    const child = makeChild();
    spawn.mockReturnValue(child);

    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ logline: 'a', summary: 'b', themes: [], strengths: [], issues: [], suggestions: [] })));
      child.emit('close', 0);
    });

    await runAnalysis(FAKE_WORK_ID, { kind: 'evaluate' });

    const [, capturedArgs] = spawn.mock.calls.at(-1);
    const modelIdx = capturedArgs.indexOf('--model');
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(capturedArgs[modelIdx + 1]).toBe('o4-mini');
  });
});
