import { describe, expect, it, vi, beforeEach } from 'vitest';
import { join } from 'path';
vi.mock('./providers.js', () => ({ getProviderById: vi.fn() }));
vi.mock('./providerExecutionReadiness.js', () => ({ ensureProviderReadyForExecution: vi.fn().mockResolvedValue({ success: true }) }));
vi.mock('./tuiPromptRunner.js', () => ({ executeTuiRun: vi.fn() }));
vi.mock('./runner.js', () => ({ getRunsPath: vi.fn(() => '/tmp/portos-benchmark-runs') }));
vi.mock('../lib/providerModels.js', () => ({
  isOpencodeCommand: vi.fn(() => true),
  isClaudeCommand: vi.fn((command) => command === 'claude'),
}));

import { getProviderById } from './providers.js';
import { ensureProviderReadyForExecution } from './providerExecutionReadiness.js';
import { executeTuiRun } from './tuiPromptRunner.js';
import {
  buildOpenCodeAgentBenchmarkPrompt,
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

describe('runOpenCodeAgentBenchmark', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('rejects a model outside the three explicit benchmark targets', async () => {
    await expect(runOpenCodeAgentBenchmark({ backend: 'llama', modelId: 'other-model' }))
      .rejects.toMatchObject({ code: 'LOCAL_AGENT_BENCHMARK_TARGET_INVALID', status: 400 });
    expect(getProviderById).not.toHaveBeenCalled();
  });
});
