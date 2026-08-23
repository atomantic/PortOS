import { describe, it, expect, vi, beforeEach } from 'vitest';

// The REAL toolkit envelope, deliberately: `getAllProviders()` resolves
// `{ activeProvider, providers: [...] }`, not a bare array. Mocking it as an
// array is exactly what let `resolveOpencodeTuiProvider` ship returning null for
// every runtime while its suite stayed green — the capability matrix said "no
// OpenCode TUI provider is configured" for models that had one.
const toolkitProviders = vi.fn();
vi.mock('./providers.js', async () => {
  const getAllProviders = (...args) => toolkitProviders(...args);
  return {
    getAllProviders,
    // Mirrors the real wrapper: unwrap the envelope, [] on a failed read.
    listProviders: async () => {
      const data = await getAllProviders().catch(() => null);
      return Array.isArray(data?.providers) ? data.providers : [];
    },
  };
});
vi.mock('../lib/streamingSpawn.js', () => ({ runStreamingCommand: vi.fn() }));
vi.mock('../lib/cliChildEnv.js', () => ({ buildCliChildEnv: vi.fn(() => ({ PATH: '/example/bin' })) }));

const { runStreamingCommand } = await import('../lib/streamingSpawn.js');
const { resolveOpencodeTuiProvider, runOpencodeTask } = await import('./opencodeTask.js');

const OPENCODE_OLLAMA_TUI = {
  id: 'opencode-ollama-tui', name: 'OpenCode Ollama TUI', type: 'tui', command: 'opencode', args: [], ollamaBacked: true,
};
const OPENCODE_OLLAMA_CLI = { id: 'opencode-ollama', type: 'cli', command: 'opencode', ollamaBacked: true };
const CLAUDE_OLLAMA_TUI = { id: 'claude-ollama-tui', type: 'tui', command: 'claude', ollamaBacked: true };
const OPENCODE_LLAMA_TUI = { id: 'opencode-llama-tui', type: 'tui', command: 'opencode', args: [], llamaBacked: true };

const envelope = (providers) => ({ activeProvider: 'opencode-ollama-tui', providers });

beforeEach(() => {
  vi.clearAllMocks();
  toolkitProviders.mockResolvedValue(envelope([
    OPENCODE_OLLAMA_CLI, CLAUDE_OLLAMA_TUI, OPENCODE_OLLAMA_TUI, OPENCODE_LLAMA_TUI,
  ]));
});

describe('resolveOpencodeTuiProvider', () => {
  it('finds the preset through the envelope getAllProviders actually returns', async () => {
    expect((await resolveOpencodeTuiProvider('ollama')).id).toBe('opencode-ollama-tui');
    expect((await resolveOpencodeTuiProvider('llama')).id).toBe('opencode-llama-tui');
  });

  it('matches on the provider marker, not on a hardcoded id', async () => {
    const renamed = { ...OPENCODE_OLLAMA_TUI, id: 'my-own-ollama-agent', name: 'Renamed' };
    toolkitProviders.mockResolvedValue(envelope([renamed]));
    expect((await resolveOpencodeTuiProvider('ollama')).id).toBe('my-own-ollama-agent');
  });

  it('ignores a CLI preset and a non-OpenCode TUI for the same runtime', async () => {
    toolkitProviders.mockResolvedValue(envelope([OPENCODE_OLLAMA_CLI, CLAUDE_OLLAMA_TUI]));
    expect(await resolveOpencodeTuiProvider('ollama')).toBeNull();
  });

  it('reports none for a runtime OpenCode has no namespace for', async () => {
    // LM Studio genuinely has no OpenCode preset — that is an answer, not a miss.
    expect(await resolveOpencodeTuiProvider('lmstudio')).toBeNull();
  });

  it('reads the list once when the caller already has it', async () => {
    const list = [OPENCODE_OLLAMA_TUI, OPENCODE_LLAMA_TUI];
    await resolveOpencodeTuiProvider('ollama', list);
    await resolveOpencodeTuiProvider('llama', list);
    expect(toolkitProviders).not.toHaveBeenCalled();
  });

  it('reports none rather than throwing when the provider service is unavailable', async () => {
    toolkitProviders.mockRejectedValue(new Error('toolkit not initialized'));
    expect(await resolveOpencodeTuiProvider('ollama')).toBeNull();
  });
});

describe('runOpencodeTask', () => {
  it('qualifies the model with the provider namespace so a bare id cannot route to the cloud', async () => {
    runStreamingCommand.mockResolvedValue({ success: true });
    await runOpencodeTask({
      provider: OPENCODE_OLLAMA_TUI, modelId: 'qwen2.5-coder:32b', cwd: '/tmp/sandbox', prompt: 'fix it', timeoutMs: 1000,
    });
    const [, args] = runStreamingCommand.mock.calls[0];
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('ollama/qwen2.5-coder:32b');
    // The agent is confined to the sandbox it was given.
    expect(args[args.indexOf('--dir') + 1]).toBe('/tmp/sandbox');
  });

  it('streams parsed frames and returns them for aggregation', async () => {
    runStreamingCommand.mockImplementation(async (_cmd, _args, onLine) => {
      onLine(JSON.stringify({ type: 'text', part: { type: 'text', text: 'Reading.' } }));
      onLine('not json');
      onLine(JSON.stringify({ type: 'tool', part: { type: 'tool', tool: 'write' } }));
      return { success: true };
    });
    const seen = [];
    const result = await runOpencodeTask({
      provider: OPENCODE_OLLAMA_TUI, modelId: 'm', cwd: '/tmp/s', prompt: 'p', timeoutMs: 1000,
      onEvent: (e) => seen.push(e),
    });
    expect(seen).toHaveLength(2);
    expect(result.events).toHaveLength(2);
    expect(result.success).toBe(true);
  });

  it('passes a caller cancellation signal to the streaming runner', async () => {
    runStreamingCommand.mockResolvedValue({ success: true });
    const controller = new AbortController();
    await runOpencodeTask({
      provider: OPENCODE_OLLAMA_TUI, modelId: 'm', cwd: '/tmp/s', prompt: 'p', timeoutMs: 1000,
      signal: controller.signal,
    });

    const options = runStreamingCommand.mock.calls[0][3];
    expect(options.isCancelled()).toBe(false);
    controller.abort();
    expect(options.isCancelled()).toBe(true);
  });

  it('refuses a provider that is not an OpenCode TUI', async () => {
    await expect(runOpencodeTask({ provider: CLAUDE_OLLAMA_TUI, modelId: 'm', cwd: '/tmp/s', prompt: 'p', timeoutMs: 1 }))
      .rejects.toThrow(/not an OpenCode TUI provider/);
    await expect(runOpencodeTask({ provider: null, modelId: 'm', cwd: '/tmp/s', prompt: 'p', timeoutMs: 1 }))
      .rejects.toThrow(/No OpenCode TUI provider/);
  });
});
