import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/runner.js', () => ({
  createRun: vi.fn(),
  executeApiRun: vi.fn(),
  executeCliRun: vi.fn(),
  hasModelFlag: vi.fn(() => false),
  extractBakedModel: vi.fn(() => null),
  // promptRunner.js imports stopRun for the API-timeout cancel path —
  // without this mock, the timer firing would TypeError on `stopRun is
  // not a function` and crash any test that triggers the API timeout.
  stopRun: vi.fn().mockResolvedValue(undefined),
}));

// TUI runner is in lib (different module from services/runner.js) — mock it
// here so the central handler's tui branch is testable without spawning a
// real PTY. executeTuiRun is responsible for its own response cleanup
// (file-write directive + screen-scrape fallback), so the central handler
// just forwards result.text. Tests drive the cleaned text directly via the
// mock's onComplete payload.
vi.mock('./tuiPromptRunner.js', () => ({
  executeTuiRun: vi.fn(),
}));

// providers.js is a compatibility shim that throws when the toolkit hasn't
// been initialized via setAIToolkit(). Mock it so the resolveProviderAndModel
// tests can drive the active/by-id lookups directly.
vi.mock('../services/providers.js', () => ({
  getActiveProvider: vi.fn(),
  getProviderById: vi.fn(),
}));

const runner = await import('../services/runner.js');
const tuiRunner = await import('./tuiPromptRunner.js');
const providers = await import('../services/providers.js');
const { runPromptThroughProvider, resolveProviderAndModel } = await import('./promptRunner.js');

const apiProvider = (extra = {}) => ({
  id: 'mock-api', type: 'api', defaultModel: 'm-default', ...extra,
});
const cliProvider = (extra = {}) => ({
  id: 'codex', type: 'cli', defaultModel: 'm-default', timeout: 5000, ...extra,
});
const tuiProvider = (extra = {}) => ({
  id: 'claude-code-tui', type: 'tui', defaultModel: 'm-default', timeout: 5000, ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  runner.createRun.mockResolvedValue({ runId: 'run-xyz' });
  // vi.clearAllMocks() clears calls but NOT mockReturnValue overrides,
  // so the default implementations set in vi.mock() above don't auto-reset
  // between tests. Re-apply the defaults that individual tests override
  // (hasModelFlag, extractBakedModel) so a leak-over value can't poison
  // the next test's resolveEffectiveModel run.
  runner.hasModelFlag.mockReturnValue(false);
  runner.extractBakedModel.mockReturnValue(null);
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

    expect(runner.createRun).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'openai',
      model: 'gpt-5',
      prompt: 'p',
      source: 'media-prompt-refine',
    }));
    // workspacePath now also goes through (defaults to process.cwd() when
    // the caller doesn't pass `cwd`) so /runs reflects the actual spawn dir.
    expect(runner.createRun.mock.calls[0][0]).toHaveProperty('workspacePath');
  });

  it('forwards a per-call cwd through to createRun as workspacePath', async () => {
    runner.executeCliRun.mockImplementation(async (id, _p, _pr, cwd, onData, onComplete, _t) => {
      onData(cwd); // echo back the cwd so the assertion below can check it
      onComplete({ success: true });
    });

    const out = await runPromptThroughProvider({
      provider: cliProvider(),
      prompt: 'p',
      source: 't',
      cwd: '/some/other/dir',
    });

    expect(out.text).toBe('/some/other/dir');
    expect(runner.createRun).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: '/some/other/dir' })
    );
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

  it('returns the args-baked model id (not defaultModel) when extractBakedModel succeeds', async () => {
    // Regression: previously the non-honoring CLI branch fell through to
    // provider.defaultModel, so a baked args model id would never reach
    // the run record / return value. Now resolveEffectiveModel extracts
    // the args-pinned id directly.
    runner.hasModelFlag.mockReturnValue(true);
    runner.extractBakedModel.mockReturnValue('baked-in');
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

    // effectiveModel = baked-in (not defaultModel='fallback'). Clone
    // fires because baked-in !== defaultModel; the CLI receives the
    // cloned provider whose defaultModel === baked-in.
    expect(out.model).toBe('baked-in');
    expect(out.text).toBe('ran with defaultModel=baked-in');
    // Run-record side of the bugfix: createRun must persist the
    // args-baked model id so the recorded run reflects what actually
    // executed (not the caller's silently-dropped override or the
    // provider.defaultModel fallback).
    expect(runner.createRun).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'claude-code',
      model: 'baked-in',
      prompt: 'p',
      source: 't',
    }));
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

// =============================================================================
// TUI routing — the third dispatch branch added alongside cli/api. Mirrors
// the cli/api coverage above so the central handler's tui path can't quietly
// regress (was the entry point for the Pipeline-prose crash bug).
// =============================================================================

describe('promptRunner — TUI provider routing', () => {
  it('routes TUI providers through executeTuiRun and resolves with result.text', async () => {
    tuiRunner.executeTuiRun.mockImplementation(async (id, _p, _pr, _cwd, onData, onComplete, _t) => {
      onData('chrome chunk ');
      onData('more chrome');
      onComplete({ success: true, exitCode: 0, text: 'once upon a time' });
    });

    const out = await runPromptThroughProvider({
      provider: tuiProvider(),
      prompt: 'tell me a story',
      source: 'pipeline-text-stage',
    });

    expect(out).toEqual({ text: 'once upon a time', runId: 'run-xyz', model: 'm-default' });
    expect(tuiRunner.executeTuiRun).toHaveBeenCalledTimes(1);
    expect(runner.executeCliRun).not.toHaveBeenCalled();
    expect(runner.executeApiRun).not.toHaveBeenCalled();
  });

  it('passes cwd + timeout overrides through to executeTuiRun', async () => {
    tuiRunner.executeTuiRun.mockImplementation(async (id, _p, _pr, _cwd, onData, onComplete, _t) => {
      onData('ok');
      onComplete({ success: true });
    });

    await runPromptThroughProvider({
      provider: tuiProvider(),
      prompt: 'p', source: 't',
      cwd: '/tmp/some-other-repo',
      timeout: 60000,
    });

    const args = tuiRunner.executeTuiRun.mock.calls[0];
    expect(args[3]).toBe('/tmp/some-other-repo'); // cwd positional arg
    expect(args[6]).toBe(60000);                   // timeout positional arg
  });

  it('returns result.text from executeTuiRun (which owns its own response cleanup)', async () => {
    tuiRunner.executeTuiRun.mockImplementation(async (id, _p, _pr, _cwd, onData, onComplete, _t) => {
      onData('raw with chrome');
      onComplete({ success: true, text: 'cleaned response from file' });
    });

    const out = await runPromptThroughProvider({
      provider: tuiProvider(),
      prompt: 'p', source: 't',
    });

    expect(out.text).toBe('cleaned response from file');
  });

  it('falls back to empty string when executeTuiRun omits result.text', async () => {
    tuiRunner.executeTuiRun.mockImplementation(async (id, _p, _pr, _cwd, onData, onComplete, _t) => {
      onData('streamed chrome');
      onComplete({ success: true });
    });

    const out = await runPromptThroughProvider({
      provider: tuiProvider(),
      prompt: 'p', source: 't',
    });

    expect(out.text).toBe('');
  });

  it('rejects with TUI-labeled error when executeTuiRun fires onComplete with success: false', async () => {
    tuiRunner.executeTuiRun.mockImplementation(async (id, _p, _pr, _cwd, _od, onComplete, _t) => {
      onComplete({ success: false, exitCode: 124 });
    });

    await expect(runPromptThroughProvider({
      provider: tuiProvider(),
      prompt: 'p', source: 't',
    })).rejects.toThrow(/TUI execution failed/);
  });

  it('rejects when executeTuiRun rejects (spawn failure path)', async () => {
    tuiRunner.executeTuiRun.mockRejectedValue(new Error("Failed to spawn TUI 'claude'"));
    await expect(runPromptThroughProvider({
      provider: tuiProvider(),
      prompt: 'p', source: 't',
    })).rejects.toThrow(/Failed to spawn TUI/);
  });
});

// =============================================================================
// API timeout enforcement — the toolkit's executeApiRun has no internal
// timer, so the central handler races a setTimeout against onComplete.
// Verify that a stuck API run rejects with the timeout error AND that
// stopRun is invoked for best-effort cancellation. Regression guard for
// the round-2 review finding that API callers were hanging indefinitely.
// =============================================================================

describe('promptRunner — API timeout enforcement', () => {
  it('rejects with timeout error when executeApiRun never completes and calls stopRun', async () => {
    vi.useFakeTimers();
    // executeApiRun hangs — never invokes onComplete or onData.
    runner.executeApiRun.mockImplementation(() => new Promise(() => {}));

    // Kick off the call and attach the rejection assertion BEFORE advancing
    // timers — otherwise the timer-driven reject lands without a handler
    // attached and vitest flags an unhandled rejection.
    const promise = runPromptThroughProvider({
      provider: apiProvider(),
      prompt: 'p', source: 't',
      timeout: 5000,
    });
    const assertion = expect(promise).rejects.toThrow(/API execution timed out after 5000ms/);

    await vi.advanceTimersByTimeAsync(6000);
    await assertion;

    expect(runner.stopRun).toHaveBeenCalledWith('run-xyz');
    vi.useRealTimers();
  });

  it('does not call stopRun when API completes within the timeout', async () => {
    vi.useFakeTimers();
    runner.executeApiRun.mockImplementation(async (id, _p, _m, _pr, _cwd, _ctx, onData, onComplete) => {
      onData('quick');
      onComplete({ success: true });
    });

    const promise = runPromptThroughProvider({
      provider: apiProvider(),
      prompt: 'p', source: 't',
      timeout: 5000,
    });

    const out = await promise;
    expect(out.text).toBe('quick');
    // Advance time past what would have been the timeout — should not fire
    // because settle-once guards cleared the handle.
    await vi.advanceTimersByTimeAsync(10000);
    expect(runner.stopRun).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('resolveProviderAndModel', () => {
  beforeEach(() => {
    providers.getActiveProvider.mockReset();
    providers.getProviderById.mockReset();
  });

  it('uses providerId when it resolves; selectedModel falls back to defaultModel', async () => {
    providers.getProviderById.mockResolvedValue({ id: 'p-1', type: 'api', defaultModel: 'm-default' });
    const out = await resolveProviderAndModel({ providerId: 'p-1' });
    expect(providers.getProviderById).toHaveBeenCalledWith('p-1');
    expect(providers.getActiveProvider).not.toHaveBeenCalled();
    expect(out.provider?.id).toBe('p-1');
    expect(out.selectedModel).toBe('m-default');
  });

  it('caller model wins over provider.defaultModel when the provider honors overrides', async () => {
    providers.getProviderById.mockResolvedValue({ id: 'p-1', type: 'api', defaultModel: 'm-default' });
    const out = await resolveProviderAndModel({ providerId: 'p-1', model: 'm-override' });
    expect(out.selectedModel).toBe('m-override');
  });

  it('falls back to getActiveProvider when providerId lookup throws', async () => {
    providers.getProviderById.mockRejectedValue(new Error('stale id'));
    providers.getActiveProvider.mockResolvedValue({ id: 'active-1', type: 'api', defaultModel: 'm-default' });
    const out = await resolveProviderAndModel({ providerId: 'p-stale' });
    expect(out.provider?.id).toBe('active-1');
    expect(out.selectedModel).toBe('m-default');
  });

  it('falls back to getActiveProvider when providerId resolves to null', async () => {
    providers.getProviderById.mockResolvedValue(null);
    providers.getActiveProvider.mockResolvedValue({ id: 'active-1', type: 'api', defaultModel: 'm-default' });
    const out = await resolveProviderAndModel({ providerId: 'p-missing' });
    expect(out.provider?.id).toBe('active-1');
  });

  it('skips getProviderById entirely when no providerId is given', async () => {
    providers.getActiveProvider.mockResolvedValue({ id: 'active-1', type: 'api', defaultModel: 'm-default' });
    const out = await resolveProviderAndModel({});
    expect(providers.getProviderById).not.toHaveBeenCalled();
    expect(out.provider?.id).toBe('active-1');
  });

  it('returns { provider: null, selectedModel: null } when neither resolves', async () => {
    providers.getActiveProvider.mockResolvedValue(null);
    const out = await resolveProviderAndModel({});
    expect(out).toEqual({ provider: null, selectedModel: null });
  });
});
