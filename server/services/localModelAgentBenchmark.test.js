import { describe, expect, it, vi, beforeEach } from 'vitest';
import { writeFile } from 'fs/promises';

vi.mock('./providers.js', () => ({ getProviderById: vi.fn() }));
vi.mock('../lib/bufferedSpawn.js', () => ({
  bufferedSpawn: vi.fn(),
  prepareCliSpawn: vi.fn((command, args) => ({ command, args })),
}));
vi.mock('../lib/cliChildEnv.js', () => ({ buildCliChildEnv: vi.fn(() => ({ PATH: '/example/bin' })) }));
vi.mock('../lib/providerModels.js', () => ({
  isOpencodeCommand: vi.fn(() => true),
  prefixOpencodeModel: vi.fn((_provider, model) => `llama/${model}`),
}));

import { getProviderById } from './providers.js';
import { bufferedSpawn } from '../lib/bufferedSpawn.js';
import { buildCliChildEnv } from '../lib/cliChildEnv.js';
import {
  OPENCODE_AGENT_BENCHMARK_PROMPT,
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
    bufferedSpawn.mockImplementation(async (_command, args) => {
      const dir = args[args.indexOf('--dir') + 1];
      await writeFile(`${dir}/PORTOS_AGENT_BENCHMARK.txt`, 'PORTOS_AGENT_BENCHMARK_OK');
      return {
        success: true,
        code: 0,
        signal: null,
        stdout: [
          JSON.stringify({ type: 'tool_use', part: { type: 'tool' } }),
          JSON.stringify({ type: 'text', text: 'PORTOS_AGENT_BENCHMARK_OK' }),
          JSON.stringify({ type: 'step_finish', part: { tokens: { output: 9 } } }),
        ].join('\n'),
        stderr: '',
        timedOut: false,
      };
    });
  });

  it('runs the named target in a scratch workspace and returns task rates', async () => {
    const result = await runOpenCodeAgentBenchmark({ backend: 'llama', modelId: 'qwen3.8-27b-dflash2' });

    expect(result).toMatchObject({
      backend: 'llama',
      modelId: 'qwen3.8-27b-dflash2',
      providerId: 'opencode-llama-tui',
      completed: true,
      toolCalls: 1,
      outputTokens: 9,
      error: null,
    });
    expect(result.taskCharsPerSecond).toBeGreaterThan(0);
    expect(result.taskTokensPerSecond).toBeGreaterThan(0);
    expect(buildCliChildEnv).toHaveBeenCalledWith(expect.objectContaining({ model: 'qwen3.8-27b-dflash2', guard: true }));
    expect(bufferedSpawn).toHaveBeenCalledWith('opencode', expect.arrayContaining([
      'run', '--format', 'json', '--auto', '--model', 'llama/qwen3.8-27b-dflash2', OPENCODE_AGENT_BENCHMARK_PROMPT,
    ]), expect.objectContaining({ timeoutMs: 600000, env: { PATH: '/example/bin' } }));
  });

  it('rejects a model outside the three explicit benchmark targets', async () => {
    await expect(runOpenCodeAgentBenchmark({ backend: 'llama', modelId: 'other-model' }))
      .rejects.toMatchObject({ code: 'LOCAL_AGENT_BENCHMARK_TARGET_INVALID', status: 400 });
    expect(getProviderById).not.toHaveBeenCalled();
  });
});
