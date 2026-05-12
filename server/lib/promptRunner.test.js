import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/runner.js', () => ({
  createRun: vi.fn(),
  executeApiRun: vi.fn(),
  executeCliRun: vi.fn(),
  hasModelFlag: vi.fn(() => false),
}));

const runner = await import('../services/runner.js');
const { runPromptThroughProvider } = await import('./promptRunner.js');

const apiProvider = (extra = {}) => ({
  id: 'mock-api', type: 'api', defaultModel: 'm-default', ...extra,
});
const cliProvider = (extra = {}) => ({
  id: 'codex', type: 'cli', defaultModel: 'm-default', timeout: 5000, ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  runner.createRun.mockResolvedValue({ runId: 'run-xyz' });
});

describe('promptRunner — happy paths', () => {
  it('routes CLI providers through executeCliRun, accumulates text, resolves { text, runId, model }', async () => {
    runner.executeCliRun.mockImplementation(async (id, _p, _pr, _cwd, onData, onComplete, _t) => {
      onData('hello ');
      onData('world');
      onComplete({ success: true });
    });

    const out = await runPromptThroughProvider({
      provider: cliProvider(),
      prompt: 'p',
      source: 'test',
    });

    expect(out).toEqual({ text: 'hello world', runId: 'run-xyz', model: 'm-default' });
    expect(runner.executeCliRun).toHaveBeenCalledTimes(1);
    expect(runner.executeApiRun).not.toHaveBeenCalled();
  });

  it('routes API providers through executeApiRun, accumulates text, resolves { text, runId, model }', async () => {
    runner.executeApiRun.mockImplementation(async (id, _p, _m, _pr, _cwd, _ctx, onData, onComplete) => {
      onData('foo');
      onData({ text: 'bar' }); // API streams sometimes ship {text} chunks
      onComplete({ success: true });
    });

    const out = await runPromptThroughProvider({
      provider: apiProvider(),
      prompt: 'p',
      source: 'test',
      model: 'gpt-test',
    });

    expect(out).toEqual({ text: 'foobar', runId: 'run-xyz', model: 'gpt-test' });
    expect(runner.executeApiRun).toHaveBeenCalledTimes(1);
    expect(runner.executeCliRun).not.toHaveBeenCalled();
  });

  it('forwards the provider id + model + source to createRun', async () => {
    runner.executeApiRun.mockImplementation(async (id, _p, _m, _pr, _cwd, _ctx, onData, onComplete) => {
      onData('ok');
      onComplete({ success: true });
    });

    await runPromptThroughProvider({
      provider: apiProvider({ id: 'openai' }),
      prompt: 'p',
      source: 'media-prompt-refine',
      model: 'gpt-5',
    });

    expect(runner.createRun).toHaveBeenCalledWith({
      providerId: 'openai',
      model: 'gpt-5',
      prompt: 'p',
      source: 'media-prompt-refine',
    });
  });

  it('reuses a caller-supplied runId (no createRun round-trip)', async () => {
    runner.executeApiRun.mockImplementation(async (id, _p, _m, _pr, _cwd, _ctx, onData, onComplete) => {
      onData('ok');
      onComplete({ success: true });
    });

    const out = await runPromptThroughProvider({
      provider: apiProvider(),
      prompt: 'p',
      source: 't',
      runId: 'caller-supplied-run',
    });

    expect(out.runId).toBe('caller-supplied-run');
    expect(runner.createRun).not.toHaveBeenCalled();
  });

  it('passes a CLI provider clone with overridden defaultModel for codex (which honors --model)', async () => {
    runner.executeCliRun.mockImplementation(async (id, providerArg, _p, _cwd, onData, onComplete, _t) => {
      onData(`ran with model=${providerArg.defaultModel}`);
      onComplete({ success: true });
    });

    const out = await runPromptThroughProvider({
      provider: cliProvider({ defaultModel: 'old' }), // id: 'codex'
      prompt: 'p',
      source: 't',
      model: 'new',
    });

    expect(out.text).toBe('ran with model=new');
  });

  it('clones non-codex CLI providers with the model override when args have no baked-in model flag', async () => {
    // Post-#222: runner.js#buildCliArgs honors `provider.defaultModel`
    // for codex / claude-code / gemini-cli when the user hasn't already
    // baked a model flag into provider.args. So the clone is safe and
    // the run record correctly reflects the user's selection.
    runner.hasModelFlag.mockReturnValue(false);
    runner.executeCliRun.mockImplementation(async (id, providerArg, _p, _cwd, onData, onComplete, _t) => {
      onData(`ran with defaultModel=${providerArg.defaultModel}`);
      onComplete({ success: true });
    });

    const out = await runPromptThroughProvider({
      provider: { id: 'claude-code', type: 'cli', defaultModel: 'old', timeout: 5000, args: [] },
      prompt: 'p',
      source: 't',
      model: 'user-picked-this',
    });

    expect(out.text).toBe('ran with defaultModel=user-picked-this');
  });

  it('does NOT clone CLI providers when args have a baked-in --model flag (args win)', async () => {
    // When the user has pinned a model in provider.args, runner.js
    // suppresses its own --model injection. Per-call override is
    // silently dropped and the args-baked model wins — keep the run
    // record honest by not pretending the override applied.
    runner.hasModelFlag.mockReturnValue(true);
    runner.executeCliRun.mockImplementation(async (id, providerArg, _p, _cwd, onData, onComplete, _t) => {
      onData(`ran with defaultModel=${providerArg.defaultModel}`);
      onComplete({ success: true });
    });

    const out = await runPromptThroughProvider({
      provider: { id: 'claude-code', type: 'cli', defaultModel: 'fallback', timeout: 5000, args: ['--model', 'baked-in'] },
      prompt: 'p',
      source: 't',
      model: 'user-picked-this',
    });

    expect(out.text).toBe('ran with defaultModel=fallback');
  });
});

describe('promptRunner — strictest-discriminator rejection', () => {
  it('rejects when CLI onComplete reports success: false (even with no error string)', async () => {
    runner.executeCliRun.mockImplementation(async (id, _p, _pr, _cwd, _onData, onComplete, _t) => {
      onComplete({ success: false });
    });

    await expect(runPromptThroughProvider({
      provider: cliProvider(),
      prompt: 'p',
      source: 't',
    })).rejects.toThrow(/CLI execution failed/);
  });

  it('rejects when CLI onComplete reports a non-zero error', async () => {
    runner.executeCliRun.mockImplementation(async (id, _p, _pr, _cwd, _onData, onComplete, _t) => {
      onComplete({ error: 'codex timeout' });
    });

    await expect(runPromptThroughProvider({
      provider: cliProvider(),
      prompt: 'p',
      source: 't',
    })).rejects.toThrow(/codex timeout/);
  });

  it('rejects when API onComplete reports success: false (this is the discriminator drift fix)', async () => {
    // Before the unification, API sites only checked `error` and would
    // resolve with empty text on success: false — silently swallowing
    // soft failures. The unified runner rejects on success: false too.
    runner.executeApiRun.mockImplementation(async (id, _p, _m, _pr, _cwd, _ctx, _onData, onComplete) => {
      onComplete({ success: false });
    });

    await expect(runPromptThroughProvider({
      provider: apiProvider(),
      prompt: 'p',
      source: 't',
    })).rejects.toThrow(/API execution failed/);
  });

  it('rejects when API onComplete reports a non-zero error', async () => {
    runner.executeApiRun.mockImplementation(async (id, _p, _m, _pr, _cwd, _ctx, _onData, onComplete) => {
      onComplete({ error: 'upstream 500' });
    });

    await expect(runPromptThroughProvider({
      provider: apiProvider(),
      prompt: 'p',
      source: 't',
    })).rejects.toThrow(/upstream 500/);
  });

  it('forwards executeCliRun rejection (e.g. ensureDir/spawn failure pre-onComplete)', async () => {
    runner.executeCliRun.mockRejectedValue(new Error('ensureDir failed'));
    await expect(runPromptThroughProvider({
      provider: cliProvider(),
      prompt: 'p',
      source: 't',
    })).rejects.toThrow(/ensureDir failed/);
  });

  it('forwards executeApiRun rejection (toolkit not initialized, etc.)', async () => {
    runner.executeApiRun.mockRejectedValue(new Error('AI Toolkit not initialized'));
    await expect(runPromptThroughProvider({
      provider: apiProvider(),
      prompt: 'p',
      source: 't',
    })).rejects.toThrow(/AI Toolkit not initialized/);
  });

  it('rejects unsupported provider types up-front', async () => {
    await expect(runPromptThroughProvider({
      provider: { id: 'bogus', type: 'rpc' },
      prompt: 'p',
      source: 't',
    })).rejects.toThrow(/Unsupported provider type: rpc/);
  });

  it('rejects when provider is null or missing entirely', async () => {
    await expect(runPromptThroughProvider({
      provider: null, prompt: 'p', source: 't',
    })).rejects.toThrow(/provider is required/);
    await expect(runPromptThroughProvider({
      prompt: 'p', source: 't',
    })).rejects.toThrow(/provider is required/);
  });

  it('rejects when provider.id is missing or non-string', async () => {
    await expect(runPromptThroughProvider({
      provider: { type: 'api' }, prompt: 'p', source: 't',
    })).rejects.toThrow(/provider.id must be a non-empty string/);
    await expect(runPromptThroughProvider({
      provider: { id: '', type: 'api' }, prompt: 'p', source: 't',
    })).rejects.toThrow(/provider.id must be a non-empty string/);
  });

  it('rejects when prompt or source is missing/empty', async () => {
    await expect(runPromptThroughProvider({
      provider: apiProvider(), prompt: '', source: 't',
    })).rejects.toThrow(/prompt must be a non-empty string/);
    await expect(runPromptThroughProvider({
      provider: apiProvider(), prompt: 'p', source: '',
    })).rejects.toThrow(/source must be a non-empty string/);
  });
});

describe('promptRunner — multi-chunk text accumulation', () => {
  it('accumulates many CLI string chunks in order', async () => {
    runner.executeCliRun.mockImplementation(async (id, _p, _pr, _cwd, onData, onComplete, _t) => {
      for (const c of ['a', 'b', 'c', 'd', 'e']) onData(c);
      onComplete({ success: true });
    });
    const out = await runPromptThroughProvider({
      provider: cliProvider(),
      prompt: 'p',
      source: 't',
    });
    expect(out.text).toBe('abcde');
  });

  it('accumulates mixed string + {text} API chunks in order', async () => {
    runner.executeApiRun.mockImplementation(async (id, _p, _m, _pr, _cwd, _ctx, onData, onComplete) => {
      onData('A');
      onData({ text: 'B' });
      onData({ text: 'C' });
      onData('D');
      onComplete({ success: true });
    });
    const out = await runPromptThroughProvider({
      provider: apiProvider(),
      prompt: 'p',
      source: 't',
    });
    expect(out.text).toBe('ABCD');
  });

  it('ignores non-string non-{text} chunks (e.g. heartbeat events)', async () => {
    runner.executeApiRun.mockImplementation(async (id, _p, _m, _pr, _cwd, _ctx, onData, onComplete) => {
      onData('hello');
      onData({ heartbeat: true }); // chunk with no text — ignored
      onData(null);                  // ignored
      onData(' world');
      onComplete({ success: true });
    });
    const out = await runPromptThroughProvider({
      provider: apiProvider(),
      prompt: 'p',
      source: 't',
    });
    expect(out.text).toBe('hello world');
  });
});
