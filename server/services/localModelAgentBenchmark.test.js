import { describe, expect, it, vi, beforeEach } from 'vitest';
import { join } from 'path';
import { readFileSync } from 'node:fs';
vi.mock('./provider/providers.js', () => ({ getProviderById: vi.fn() }));
vi.mock('./provider/providerExecutionReadiness.js', () => ({ ensureProviderReadyForExecution: vi.fn().mockResolvedValue({ success: true }) }));
vi.mock('./tuiPromptRunner.js', () => ({ executeTuiRun: vi.fn() }));
vi.mock('./runner.js', () => ({ getRunsPath: vi.fn(() => '/tmp/portos-benchmark-runs'), stopRun: vi.fn(async () => true) }));
vi.mock('../lib/heavyJobClaim.js', () => ({ claimHeavyLocalJob: vi.fn() }));
vi.mock('./mtplxServerManager.js', () => ({ runOnMtplxCheckpoint: vi.fn() }));

import { claimHeavyLocalJob } from '../lib/heavyJobClaim.js';
import { getProviderById } from './provider/providers.js';
import { ensureProviderReadyForExecution } from './provider/providerExecutionReadiness.js';
import { runOnMtplxCheckpoint } from './mtplxServerManager.js';
import { stopRun } from './runner.js';
import { executeTuiRun } from './tuiPromptRunner.js';
import {
  buildOpenCodeAgentBenchmarkPrompt,
  cancelOpenCodeAgentBenchmark,
  runOpenCodeAgentBenchmark,
  summarizeOpenCodeEvents,
} from './localModelAgentBenchmark.js';

describe('summarizeOpenCodeEvents', () => {
  it('counts assistant text, tool calls, and output tokens without counting tool input', () => {
    const output = [
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'PORTOS_' } }),
      JSON.stringify({ type: 'tool_use', part: { type: 'tool', tool: 'bash', input: 'secret-looking command' } }),
      JSON.stringify({ type: 'text', text: 'AGENT_BENCHMARK_OK' }),
      JSON.stringify({ type: 'step_finish', part: { tokens: { output: 12 } } }),
    ].join('\n');
    expect(summarizeOpenCodeEvents(output)).toEqual({ assistantChars: 25, toolCalls: 1, outputTokens: 12 });
  });

  it('keeps token rate unavailable when OpenCode exposes no usage', () => {
    expect(summarizeOpenCodeEvents(JSON.stringify({ type: 'text', text: 'done' })))
      .toEqual({ assistantChars: 4, toolCalls: 0, outputTokens: null });
  });
});

const { providers: seeds } = JSON.parse(readFileSync(new URL('../../data.reference/providers.json', import.meta.url), 'utf8'));

describe('runOpenCodeAgentBenchmark', () => {
  let release;
  beforeEach(() => {
    vi.clearAllMocks();
    release = vi.fn(async () => {});
    claimHeavyLocalJob.mockResolvedValue({ ok: true, holder: null, release });
    getProviderById.mockResolvedValue({
      id: 'opencode-llama-tui',
      type: 'tui',
      command: 'opencode',
      args: [],
      llamaBacked: true,
    });
    executeTuiRun.mockImplementation(async ({ workspacePath, onComplete }) => {
      const { writeFile } = await import('fs/promises');
      await writeFile(`${workspacePath}/PORTOS_AGENT_BENCHMARK.txt`, 'PORTOS_AGENT_BENCHMARK_OK');
      onComplete({ success: true, exitCode: 0, text: 'PORTOS_AGENT_BENCHMARK_OK', duration: 25 });
    });
  });

  it('runs the named target in a scratch workspace and returns PTY completion timing', async () => {
    const result = await runOpenCodeAgentBenchmark({ backend: 'llama', modelId: 'dflash' });

    expect(result).toMatchObject({
      backend: 'llama',
      modelId: 'dflash',
      providerId: 'opencode-llama-tui',
      completed: true,
      toolCalls: null,
      outputTokens: null,
      measurementMode: 'pty-tui',
      error: null,
    });
    expect(result.taskCharsPerSecond).toBeNull();
    expect(result.taskTokensPerSecond).toBeNull();
    const invocation = executeTuiRun.mock.calls[0][0];
    expect(invocation).toEqual(expect.objectContaining({
      provider: expect.objectContaining({ defaultModel: 'dflash' }),
      prompt: buildOpenCodeAgentBenchmarkPrompt(join(invocation.workspacePath, 'PORTOS_AGENT_BENCHMARK.txt')),
      timeout: 600000,
      workspacePath: expect.any(String),
      guard: true,
    }));
  });

  // A benchmark probes whether a local model can drive an agentic task at all,
  // so "it couldn't" is the measurement — reported in `error` below — not a
  // provider incident. Reporting it fired the host's onRunFailed hook, and
  // autoFixer queued a CoS "Investigate AI provider failure" task per failed
  // benchmark run, pointing at a run record `finally` had already deleted.
  it('runs as a probe so a failed benchmark does not queue a provider investigation', async () => {
    executeTuiRun.mockImplementation(async ({ onComplete }) => {
      onComplete({ success: false, exitCode: 1, error: 'TUI exited with code 1', duration: 86 });
    });

    const result = await runOpenCodeAgentBenchmark({ backend: 'llama', modelId: 'dflash' });

    expect(executeTuiRun.mock.calls[0][0]).toEqual(expect.objectContaining({ reportFailure: false }));
    expect(result).toMatchObject({ completed: false, exitCode: 1, error: 'TUI exited with code 1' });
  });

  it('accepts the Claude Ollama TUI as a separate local harness target', async () => {
    getProviderById.mockResolvedValue({
      id: 'claude-ollama-tui',
      type: 'tui',
      command: 'claude',
      args: [],
      ollamaBacked: true,
    });

    const result = await runOpenCodeAgentBenchmark({ backend: 'claude-ollama', modelId: 'qwen3.8:27b-mlx' });

    expect(result).toMatchObject({
      backend: 'claude-ollama',
      modelId: 'qwen3.8:27b-mlx',
      providerId: 'claude-ollama-tui',
      completed: true,
      measurementMode: 'pty-tui',
    });
  });

  it('accepts the installed Qwen3-Coder Ollama target', async () => {
    getProviderById.mockResolvedValue({
      id: 'opencode-ollama-tui',
      type: 'tui',
      command: 'opencode',
      args: [],
      ollamaBacked: true,
    });

    const result = await runOpenCodeAgentBenchmark({ backend: 'ollama-coder', modelId: 'qwen3-coder:30b' });

    expect(result).toMatchObject({
      backend: 'ollama-coder',
      modelId: 'qwen3-coder:30b',
      providerId: 'opencode-ollama-tui',
      completed: true,
      measurementMode: 'pty-tui',
    });
  });

  it('wakes the MTPLX daemon before running its TUI benchmark', async () => {
    getProviderById.mockResolvedValue({
      id: 'opencode-mtplx-tui',
      type: 'tui',
      command: 'opencode',
      args: [],
      mtplxBacked: true,
      endpoint: 'http://127.0.0.1:8000/v1',
    });

    await runOpenCodeAgentBenchmark({ backend: 'mtplx', modelId: 'mtplx-qwen38-27b-optimized-speed' });

    expect(ensureProviderReadyForExecution).toHaveBeenCalledWith(expect.objectContaining({
      id: 'opencode-mtplx-tui',
      mtplxBacked: true,
    }));
    expect(executeTuiRun).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['splash', 'opencode-splash-tui', 'inkling2-mini'],
    ['mkserve', 'opencode-mkserve-tui', 'thinkingmachines/Inkling-2-Mini'],
  ])('runs the Inkling task check against the shipped %s TUI route', async (backend, providerId, modelId) => {
    getProviderById.mockResolvedValueOnce(seeds[providerId]);
    await expect(runOpenCodeAgentBenchmark({ backend, modelId })).resolves.toMatchObject({
      backend, providerId, modelId, completed: true,
    });
    expect(getProviderById).toHaveBeenCalledWith(providerId);
    expect(executeTuiRun.mock.calls[0][0].provider.defaultModel).toBe(modelId);
  });

  it('pins the served model and actual endpoint when selecting a cached MTPLX checkpoint', async () => {
    const modelId = 'example/Inkling-MTP';
    const servedModelId = 'inkling-mtp';
    const endpoint = 'http://127.0.0.1:8010/v1';
    getProviderById.mockResolvedValueOnce(seeds['opencode-mtplx-tui']);
    runOnMtplxCheckpoint.mockImplementationOnce(async (_model, run) => run(servedModelId, endpoint));
    await expect(runOpenCodeAgentBenchmark({ backend: 'mtplx', modelId })).resolves.toMatchObject({
      backend: 'mtplx', modelId, completed: true,
    });
    expect(runOnMtplxCheckpoint).toHaveBeenCalledWith(modelId, expect.any(Function), { requireCached: true, signal: expect.any(AbortSignal) });
    const { provider } = executeTuiRun.mock.calls[0][0];
    expect(provider).toMatchObject({ defaultModel: servedModelId, endpoint });
    expect(JSON.parse(provider.envVars.OPENCODE_CONFIG_CONTENT).provider.mtplx.options.baseURL).toBe(endpoint);
    expect(release).toHaveBeenCalledOnce();
  });

  it('stops the registered benchmark PTY and holds the claim until cleanup', async () => {
    const { promise: ready, resolve: markReady } = Promise.withResolvers();
    const { promise: exited, resolve: confirmExit } = Promise.withResolvers();
    executeTuiRun.mockImplementationOnce(async ({ onReady, onComplete, runId }) => {
      onReady();
      markReady(runId);
      await exited;
      onComplete({ success: false, exitCode: 130, canceled: true });
    });

    const target = { backend: 'llama', modelId: 'dflash' };
    expect(cancelOpenCodeAgentBenchmark()).toEqual({ cancelled: false });
    const run = runOpenCodeAgentBenchmark(target);
    const runId = await ready;
    expect(cancelOpenCodeAgentBenchmark()).toEqual({ cancelled: true });
    expect(stopRun).toHaveBeenCalledExactlyOnceWith(runId);
    expect(release).not.toHaveBeenCalled();
    await expect(runOpenCodeAgentBenchmark(target)).rejects.toMatchObject({ code: 'HEAVY_LOCAL_JOB_BUSY' });

    confirmExit();
    await expect(run).resolves.toEqual({ completed: false, cancelled: true });
    expect(release).toHaveBeenCalledOnce();
    expect(cancelOpenCodeAgentBenchmark()).toEqual({ cancelled: false });
    await expect(runOpenCodeAgentBenchmark(target)).resolves.toMatchObject({ completed: true });
  });

  it('skips the PTY when cancelled during runtime readiness', async () => {
    const { promise: started, resolve: markStarted } = Promise.withResolvers();
    const { promise: runtimeReady, resolve: finishReadiness } = Promise.withResolvers();
    ensureProviderReadyForExecution.mockImplementationOnce(() => {
      markStarted();
      return runtimeReady;
    });
    const run = runOpenCodeAgentBenchmark({ backend: 'llama', modelId: 'dflash' });
    await started;
    expect(cancelOpenCodeAgentBenchmark()).toEqual({ cancelled: true });
    finishReadiness({ success: true });

    await expect(run).resolves.toMatchObject({ cancelled: true });
    expect(executeTuiRun).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('refuses with 409 when another heavy local job holds the machine, before waking the runtime', async () => {
    claimHeavyLocalJob.mockResolvedValue({
      ok: false, holder: { kind: 'local-model assessment sweep' }, message: 'A sweep is running', release: async () => {},
    });

    await expect(runOpenCodeAgentBenchmark({ backend: 'llama', modelId: 'dflash' }))
      .rejects.toMatchObject({ status: 409, code: 'HEAVY_LOCAL_JOB_BUSY' });
    expect(ensureProviderReadyForExecution).not.toHaveBeenCalled();
    expect(executeTuiRun).not.toHaveBeenCalled();
  });

  it('holds the claim for the whole run and releases it on success and on failure', async () => {
    await runOpenCodeAgentBenchmark({ backend: 'llama', modelId: 'dflash' });
    expect(release).toHaveBeenCalledTimes(1);

    ensureProviderReadyForExecution.mockRejectedValueOnce(new Error('daemon exploded'));
    await expect(runOpenCodeAgentBenchmark({ backend: 'llama', modelId: 'dflash' })).rejects.toThrow('daemon exploded');
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('rejects a model outside the fixed benchmark preset', async () => {
    await expect(runOpenCodeAgentBenchmark({ backend: 'llama', modelId: 'other-model' }))
      .rejects.toMatchObject({ code: 'LOCAL_AGENT_BENCHMARK_TARGET_INVALID', status: 400 });
    expect(getProviderById).not.toHaveBeenCalled();
  });
});
