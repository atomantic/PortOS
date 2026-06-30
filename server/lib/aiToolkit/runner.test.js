import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRunnerService } from './runner.js';

describe('AI Toolkit runner service', () => {
  const tempDirs = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('checks provider readiness through the injected hook before API fetches', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);

    const provider = {
      id: 'ollama',
      name: 'Ollama',
      endpoint: 'http://localhost:11434/v1',
      defaultModel: 'llama3'
    };
    const ensureProviderReady = vi.fn(async () => ({ success: false, error: 'service offline' }));
    const onComplete = vi.fn();
    const onRunFailed = vi.fn();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    const runner = createRunnerService({
      dataDir,
      hooks: {
        ensureProviderReady,
        onRunFailed
      }
    });

    await runner.executeApiRun({
      runId: 'run-ready-hook',
      provider,
      model: null,
      prompt: 'hello',
      workspacePath: process.cwd(),
      screenshots: [],
      onData: undefined,
      onComplete
    });

    expect(ensureProviderReady).toHaveBeenCalledWith(provider);
    expect(fetch).not.toHaveBeenCalled();
    expect(onRunFailed).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ success: false }));

    const metadata = JSON.parse(
      await readFile(join(dataDir, 'runs', 'run-ready-hook', 'metadata.json'), 'utf8')
    );
    expect(metadata).toMatchObject({
      success: false,
      errorCategory: 'unknown'
    });
  });

  const stubStreamingFetch = () => {
    const encoder = new TextEncoder();
    const chunks = [
      encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n`),
      encoder.encode('data: [DONE]\n')
    ];
    let i = 0;
    const body = {
      getReader: () => ({
        read: async () => (i < chunks.length
          ? { done: false, value: chunks[i++] }
          : { done: true, value: undefined })
      })
    };
    const fetch = vi.fn(async () => ({ ok: true, body }));
    vi.stubGlobal('fetch', fetch);
    return fetch;
  };

  const runReady = (overrides = {}) => ({
    id: 'ollama',
    name: 'Ollama',
    endpoint: 'http://localhost:11434/v1',
    defaultModel: 'llama3',
    ...overrides
  });

  it('sends num_ctx in the request body when the provider opts in', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);
    const fetch = stubStreamingFetch();

    const runner = createRunnerService({
      dataDir,
      hooks: { ensureProviderReady: async () => ({ success: true }) }
    });
    let done;
    const completed = new Promise((resolve) => { done = resolve; });
    await runner.executeApiRun({ runId: 'run-numctx', provider: runReady({ numCtx: 32768 }), model: null, prompt: 'hi', workspacePath: process.cwd(), screenshots: [], onData: undefined, onComplete: () => done() });
    await completed;

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0][1].body).num_ctx).toBe(32768);
  });

  it('omits num_ctx when the provider does not set it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);
    const fetch = stubStreamingFetch();

    const runner = createRunnerService({
      dataDir,
      hooks: { ensureProviderReady: async () => ({ success: true }) }
    });
    let done;
    const completed = new Promise((resolve) => { done = resolve; });
    await runner.executeApiRun({ runId: 'run-no-numctx', provider: runReady(), model: null, prompt: 'hi', workspacePath: process.cwd(), screenshots: [], onData: undefined, onComplete: () => done() });
    await completed;

    expect(fetch).toHaveBeenCalledTimes(1);
    expect('num_ctx' in JSON.parse(fetch.mock.calls[0][1].body)).toBe(false);
  });
});

describe('AI Toolkit runner — declared extension points', () => {
  it('setCliRunner delegates executeCliRun to the host runner and back to the built-in on null', async () => {
    const runner = createRunnerService({ dataDir: './data' });
    const builtin = runner.executeCliRun;

    const hostRunner = vi.fn(async (opts) => `host:${opts.runId}`);
    runner.setCliRunner(hostRunner);
    const result = await runner.executeCliRun({ runId: 'r1', provider: { command: 'noop' } });
    expect(result).toBe('host:r1');
    expect(hostRunner).toHaveBeenCalledTimes(1);
    // The override receives the full opts object verbatim.
    expect(hostRunner).toHaveBeenCalledWith(expect.objectContaining({ runId: 'r1' }));

    // Reverting restores the built-in implementation.
    runner.setCliRunner(null);
    expect(runner.executeCliRun).toBe(builtin);
  });

  it('setCliRunner / setTuiRunner reject non-function, non-null values', () => {
    const runner = createRunnerService({ dataDir: './data' });
    expect(() => runner.setCliRunner(42)).toThrow(/expects a function/);
    expect(() => runner.setTuiRunner('nope')).toThrow(/expects a function/);
  });

  it('setTuiRunner attaches/detaches executeTuiRun so the runs-router gate stays honest', async () => {
    const runner = createRunnerService({ dataDir: './data' });
    // No built-in TUI executor — the runs router gates on typeof === 'function'.
    expect(typeof runner.executeTuiRun).toBe('undefined');

    const tui = vi.fn(async () => 'tui-run');
    runner.setTuiRunner(tui);
    expect(typeof runner.executeTuiRun).toBe('function');
    await runner.executeTuiRun({ runId: 'tui-1' });
    expect(tui).toHaveBeenCalledTimes(1);

    runner.setTuiRunner(null);
    expect(typeof runner.executeTuiRun).toBe('undefined');
  });

  it('external-run registry drives isRunActive / stopRun and reports unknown ids as inactive', async () => {
    const runner = createRunnerService({ dataDir: './data' });
    expect(await runner.isRunActive('x')).toBe(false);

    const child = { kill: vi.fn(), killed: false };
    runner.registerExternalRun('x', child);
    expect(runner.hasExternalRun('x')).toBe(true);
    expect(await runner.isRunActive('x')).toBe(true);

    expect(await runner.stopRun('x')).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    // stopRun drops the entry, so a follow-up reports inactive.
    expect(await runner.isRunActive('x')).toBe(false);
    expect(await runner.stopRun('x')).toBe(false);
  });

  it('stopRun aborts an AbortController-style external run', async () => {
    const runner = createRunnerService({ dataDir: './data' });
    const controller = { abort: vi.fn() };
    runner.registerExternalRun('api-run', controller);
    expect(await runner.stopRun('api-run')).toBe(true);
    expect(controller.abort).toHaveBeenCalledTimes(1);
  });

  it('deleteRun kills an in-flight external run before removing its dir', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-del-'));
    const runner = createRunnerService({ dataDir });
    const child = { kill: vi.fn(), killed: false };
    runner.registerExternalRun('live', child);

    // No on-disk dir for this run, but the live process must still be killed.
    const deleted = await runner.deleteRun('live');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(runner.hasExternalRun('live')).toBe(false);
    // deleteRun returns false when the run dir doesn't exist on disk.
    expect(deleted).toBe(false);

    await rm(dataDir, { recursive: true, force: true });
  });
});
