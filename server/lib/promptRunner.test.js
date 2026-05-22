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
  // Called best-effort by promptRunner.js when createRun proactively
  // swapped to a fallback provider — the metadata patch updates the
  // run record's providerId/model so /runs attribution matches what
  // actually ran. Mocked as a no-op resolve.
  patchRunMetadata: vi.fn().mockResolvedValue(undefined),
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
// tests can drive the active/by-id lookups directly. `getAllProviders` is
// mocked too so the retry-with-fallback path (which enumerates providers to
// look up the configured fallback) can be driven directly from tests.
vi.mock('../services/providers.js', () => ({
  getActiveProvider: vi.fn(),
  getProviderById: vi.fn(),
  getAllProviders: vi.fn().mockResolvedValue({ activeProvider: null, providers: [] }),
}));

// autoFixer.js is called from runPromptThroughProvider on a successful
// fallback retry to cancel the deferred investigation task. Mock the export
// to a spy so tests can assert it was/wasn't invoked without wiring up the
// full task system.
vi.mock('../services/autoFixer.js', () => ({
  noteFallbackHandled: vi.fn(),
}));

// aiToolkitState lookups gate the retry path on a real providerStatus
// service being present. By default the mock returns null so the retry
// short-circuits and the original error is rethrown — individual tests
// override the return value to enable the retry branch.
vi.mock('./aiToolkitState.js', () => ({
  getAIToolkitInstance: vi.fn().mockReturnValue(null),
}));

const runner = await import('../services/runner.js');
const tuiRunner = await import('./tuiPromptRunner.js');
const providers = await import('../services/providers.js');
const autoFixer = await import('../services/autoFixer.js');
const toolkitState = await import('./aiToolkitState.js');
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
  // Defaults reset for fallback-path mocks too — same staleness concern.
  providers.getAllProviders.mockResolvedValue({ activeProvider: null, providers: [] });
  toolkitState.getAIToolkitInstance.mockReturnValue(null);
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

// =============================================================================
// Retry-with-fallback — when a run fails and a fallback provider is
// available, swap to it transparently instead of letting the failure
// queue an "Investigate AI provider failure" task. Regression guard for
// the issue where LM Studio / Claude Code CLI failures used to create
// noisy plan tasks even with a configured fallback.
// =============================================================================

describe('promptRunner — retry-with-fallback', () => {
  // Reuse the top-level factories so the retry tests pick up future
  // changes to the canonical provider shapes — only overriding fields
  // these tests assert on (id + name, since noteFallbackHandled keys on
  // the display name).
  const fallbackApi = apiProvider({ id: 'fallback-api', name: 'Fallback API', defaultModel: 'fb-model' });
  const primaryCli = cliProvider({ id: 'primary-cli', name: 'Primary CLI', defaultModel: 'primary-model' });
  const primaryApi = apiProvider({ id: 'primary-api', name: 'Primary API', defaultModel: 'primary-model' });

  function mockToolkitWithFallback(fallback = fallbackApi) {
    // isAvailable returns true so promptRunner's "skip if toolkit already
    // marked it" gate doesn't short-circuit the mark in these tests.
    const isAvailable = vi.fn().mockReturnValue(true);
    const markUnavailable = vi.fn().mockResolvedValue(undefined);
    const markUsageLimit = vi.fn().mockResolvedValue(undefined);
    const getFallbackProvider = vi.fn().mockReturnValue(
      fallback ? { provider: fallback, source: 'provider' } : null
    );
    toolkitState.getAIToolkitInstance.mockReturnValue({
      services: { providerStatus: { isAvailable, markUnavailable, markUsageLimit, getFallbackProvider } },
    });
    providers.getAllProviders.mockResolvedValue({
      activeProvider: null,
      providers: fallback ? [primaryCli, primaryApi, fallback] : [primaryCli, primaryApi],
    });
    return { isAvailable, markUnavailable, markUsageLimit, getFallbackProvider };
  }

  it('retries with the configured fallback and resolves with usedFallback flag when primary CLI fails', async () => {
    const status = mockToolkitWithFallback();

    // First call: primary CLI fails. Second call: fallback API succeeds.
    runner.executeCliRun.mockImplementation(async (id, _p, _pr, _cwd, _onData, onComplete, _t) => {
      onComplete({ success: false, error: 'Process exited with code 1' });
    });
    runner.executeApiRun.mockImplementation(async (id, _p, _m, _pr, _cwd, _ctx, onData, onComplete) => {
      onData('fallback content');
      onComplete({ success: true });
    });

    const out = await runPromptThroughProvider({
      provider: primaryCli,
      prompt: 'p',
      source: 'test',
    });

    expect(out.text).toBe('fallback content');
    expect(out.usedFallback).toBe(true);
    expect(out.fallbackFrom).toEqual({ id: 'primary-cli', name: 'Primary CLI' });

    // Primary was marked unavailable before retry; fallback was looked up
    // and used; the deferred autoFixer task was cancelled.
    expect(status.markUnavailable).toHaveBeenCalledWith('primary-cli', expect.objectContaining({
      reason: expect.any(String),
    }));
    expect(status.getFallbackProvider).toHaveBeenCalledWith('primary-cli', expect.any(Object));
    expect(autoFixer.noteFallbackHandled).toHaveBeenCalledWith({
      provider: 'Primary CLI',
      model: 'primary-model',
    });
  });

  it('retries with fallback when primary API fails', async () => {
    mockToolkitWithFallback();

    let calls = 0;
    runner.executeApiRun.mockImplementation(async (id, providerArg, _m, _pr, _cwd, _ctx, onData, onComplete) => {
      calls += 1;
      if (providerArg.id === 'primary-api') {
        onComplete({ success: false, error: 'upstream 500' });
      } else {
        onData('recovered');
        onComplete({ success: true });
      }
    });

    const out = await runPromptThroughProvider({
      provider: primaryApi,
      prompt: 'p',
      source: 'test',
    });

    expect(calls).toBe(2);
    expect(out.text).toBe('recovered');
    expect(out.usedFallback).toBe(true);
    expect(autoFixer.noteFallbackHandled).toHaveBeenCalledTimes(1);
  });

  it('does NOT suppress the investigation task when the fallback ALSO fails (both errors must surface)', async () => {
    mockToolkitWithFallback();

    runner.executeCliRun.mockImplementation(async (id, _p, _pr, _cwd, _onData, onComplete, _t) => {
      onComplete({ success: false, error: 'primary boom' });
    });
    runner.executeApiRun.mockImplementation(async (id, _p, _m, _pr, _cwd, _ctx, _onData, onComplete) => {
      onComplete({ success: false, error: 'fallback also boom' });
    });

    await expect(runPromptThroughProvider({
      provider: primaryCli,
      prompt: 'p',
      source: 'test',
    })).rejects.toThrow(/fallback also boom/);

    // noteFallbackHandled is reserved for SUCCESSFUL fallback — when both
    // fail the user must see both deferred investigation tasks fire.
    expect(autoFixer.noteFallbackHandled).not.toHaveBeenCalled();
  });

  it('rethrows the original error when no fallback is available', async () => {
    mockToolkitWithFallback(null);

    runner.executeCliRun.mockImplementation(async (id, _p, _pr, _cwd, _onData, onComplete, _t) => {
      onComplete({ success: false, error: 'no recovery path' });
    });

    await expect(runPromptThroughProvider({
      provider: primaryCli,
      prompt: 'p',
      source: 'test',
    })).rejects.toThrow(/no recovery path/);

    expect(runner.executeApiRun).not.toHaveBeenCalled();
    expect(autoFixer.noteFallbackHandled).not.toHaveBeenCalled();
  });

  it('rethrows when toolkit/providerStatus is not initialized (no retry path possible)', async () => {
    // Default mock returns null toolkit — no retry attempted.
    runner.executeCliRun.mockImplementation(async (id, _p, _pr, _cwd, _onData, onComplete, _t) => {
      onComplete({ success: false, error: 'init not ready' });
    });

    await expect(runPromptThroughProvider({
      provider: primaryCli,
      prompt: 'p',
      source: 'test',
    })).rejects.toThrow(/init not ready/);

    expect(autoFixer.noteFallbackHandled).not.toHaveBeenCalled();
  });

  it('strips internal effectiveProvider/effectiveModel annotations from rethrown errors', async () => {
    // No fallback → original error rethrown. The annotation fields are
    // implementation-detail-only and should never leak to callers.
    mockToolkitWithFallback(null);
    runner.executeCliRun.mockImplementation(async (id, _p, _pr, _cwd, _onData, onComplete, _t) => {
      onComplete({ success: false, error: 'plain failure' });
    });

    try {
      await runPromptThroughProvider({
        provider: primaryCli,
        prompt: 'p',
        source: 'test',
      });
      throw new Error('should have rejected');
    } catch (err) {
      expect(err.message).toMatch(/plain failure/);
      expect(err.effectiveProvider).toBeUndefined();
      expect(err.effectiveModel).toBeUndefined();
    }
  });

  it('skips re-marking when the toolkit already marked the provider unavailable (prevents double failureCount)', async () => {
    const status = mockToolkitWithFallback();
    // Simulate the toolkit's executeApiRun having already called markUsageLimit
    // before onComplete fired — providerStatus.isAvailable now returns false.
    status.isAvailable.mockReturnValue(false);

    runner.executeApiRun.mockImplementation(async (id, providerArg, _m, _pr, _cwd, _ctx, onData, onComplete) => {
      if (providerArg.id === 'primary-api') {
        onComplete({ success: false, error: 'rate limit hit' });
      } else {
        onData('recovered');
        onComplete({ success: true });
      }
    });

    await runPromptThroughProvider({
      provider: primaryApi,
      prompt: 'p',
      source: 'test',
    });

    // Fallback still ran; investigation task still suppressed; but neither
    // markUnavailable nor markUsageLimit was called from promptRunner
    // because the toolkit's runner already marked it.
    expect(status.markUnavailable).not.toHaveBeenCalled();
    expect(status.markUsageLimit).not.toHaveBeenCalled();
    expect(autoFixer.noteFallbackHandled).toHaveBeenCalledTimes(1);
  });

  it('keys noteFallbackHandled to the provider that actually ran (not the caller-intended one) when createRun proactively swapped', async () => {
    // Setup: caller asks for primary-cli, but createRun has proactively
    // swapped to a different intermediate fallback (mockedFallback in
    // runResult.provider) because primary-cli was already marked unavailable.
    // That intermediate then fails; promptRunner's catch retries with yet
    // another fallback. The cancelled-task key MUST match the intermediate
    // (what server's onRunFailed actually published) — not the caller's
    // original primary-cli.
    const intermediate = cliProvider({ id: 'intermediate-cli', name: 'Intermediate CLI', defaultModel: 'intermediate-model' });
    const finalFallback = apiProvider({ id: 'final-api', name: 'Final API', defaultModel: 'final-model' });

    const status = mockToolkitWithFallback(finalFallback);
    // Simulate createRun's proactive swap: runner.createRun returns the
    // intermediate provider rather than the caller-passed primary.
    runner.createRun.mockResolvedValueOnce({
      runId: 'run-via-intermediate',
      provider: intermediate,
    });

    runner.executeCliRun.mockImplementation(async (id, providerArg, _p, _cwd, _onData, onComplete, _t) => {
      // Intermediate fails on first attempt.
      onComplete({ success: false, error: `intermediate boom (${providerArg.id})` });
    });
    runner.executeApiRun.mockImplementation(async (id, _p, _m, _pr, _cwd, _ctx, onData, onComplete) => {
      onData('recovered via final');
      onComplete({ success: true });
    });

    await runPromptThroughProvider({
      provider: primaryCli, // caller-intended primary
      prompt: 'p',
      source: 'test',
    });

    // The deferred task in autoFixer is keyed off the provider that
    // ACTUALLY failed (intermediate), so noteFallbackHandled must use that
    // — not the caller-intended primary-cli.
    expect(autoFixer.noteFallbackHandled).toHaveBeenCalledWith({
      provider: 'Intermediate CLI',
      model: 'intermediate-model',
    });
    // markUnavailable likewise applies to the failed intermediate, not
    // the primary the caller asked for.
    expect(status.markUnavailable).toHaveBeenCalledWith('intermediate-cli', expect.any(Object));
  });

  it('rethrows pre-execution failures (e.g. createRun throwing) without retry — there is no investigation task to suppress', async () => {
    const status = mockToolkitWithFallback();
    // createRun throws before any execution happens (disk error, disabled
    // provider, etc.). No onRunFailed event will fire, so no deferred
    // investigation task exists. The retry path must NOT engage.
    runner.createRun.mockRejectedValueOnce(new Error('Provider is disabled'));

    await expect(runPromptThroughProvider({
      provider: primaryCli,
      prompt: 'p',
      source: 'test',
    })).rejects.toThrow(/Provider is disabled/);

    expect(runner.executeCliRun).not.toHaveBeenCalled();
    expect(runner.executeApiRun).not.toHaveBeenCalled();
    expect(status.markUnavailable).not.toHaveBeenCalled();
    expect(status.markUsageLimit).not.toHaveBeenCalled();
    expect(autoFixer.noteFallbackHandled).not.toHaveBeenCalled();
  });

  it('keeps the failed primary in the providersMap so provider-level fallbackProvider can be looked up', async () => {
    // Regression: an earlier attempt at the self-fallback guard removed
    // the primary from the providersMap, which broke provider-level
    // fallback selection — getFallbackProvider needs the primary entry
    // to read its `fallbackProvider` field. The guard against
    // `fallbackProvider === self` now lives in getFallbackProvider; this
    // test pins the call-site contract that the primary stays in the map.
    const status = mockToolkitWithFallback();

    runner.executeCliRun.mockImplementation(async (id, _p, _pr, _cwd, _onData, onComplete, _t) => {
      onComplete({ success: false, error: 'primary boom' });
    });
    runner.executeApiRun.mockImplementation(async (id, _p, _m, _pr, _cwd, _ctx, onData, onComplete) => {
      onData('recovered');
      onComplete({ success: true });
    });

    await runPromptThroughProvider({
      provider: primaryCli,
      prompt: 'p',
      source: 'test',
    });

    // The map passed to getFallbackProvider must contain the failed
    // primary so provider-level fallbackProvider can be read from it.
    const mapPassed = status.getFallbackProvider.mock.calls[0][1];
    expect(mapPassed).toHaveProperty('primary-cli');
  });

  it('does not turn a successful fallback into a failure when noteFallbackHandled itself throws (best-effort suppression)', async () => {
    mockToolkitWithFallback();
    autoFixer.noteFallbackHandled.mockImplementation(() => {
      throw new Error('autoFixer is offline');
    });

    runner.executeCliRun.mockImplementation(async (id, _p, _pr, _cwd, _onData, onComplete, _t) => {
      onComplete({ success: false, error: 'primary boom' });
    });
    runner.executeApiRun.mockImplementation(async (id, _p, _m, _pr, _cwd, _ctx, onData, onComplete) => {
      onData('still works');
      onComplete({ success: true });
    });

    const out = await runPromptThroughProvider({
      provider: primaryCli,
      prompt: 'p',
      source: 'test',
    });

    // Fallback ran and returned its result — the suppression failure was
    // logged but did not surface as a rejection.
    expect(out.text).toBe('still works');
    expect(out.usedFallback).toBe(true);
  });

  it('routes USAGE_LIMIT failures through markUsageLimit (parses wait time)', async () => {
    const status = mockToolkitWithFallback();
    runner.executeCliRun.mockImplementation(async (id, _p, _pr, _cwd, _onData, onComplete, _t) => {
      onComplete({ success: false, error: "You've hit your usage limit. Try again in 5 hours" });
    });
    runner.executeApiRun.mockImplementation(async (id, _p, _m, _pr, _cwd, _ctx, onData, onComplete) => {
      onData('recovered');
      onComplete({ success: true });
    });

    await runPromptThroughProvider({
      provider: primaryCli,
      prompt: 'p',
      source: 'test',
    });

    expect(status.markUsageLimit).toHaveBeenCalledWith('primary-cli', expect.objectContaining({
      waitTime: expect.any(String),
    }));
    expect(status.markUnavailable).not.toHaveBeenCalled();
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
