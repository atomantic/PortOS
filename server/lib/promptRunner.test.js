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
  noteFallbackStarted: vi.fn(),
  noteFallbackHandled: vi.fn(),
  noteFallbackFailed: vi.fn(),
  escalateProviderFailure: vi.fn().mockResolvedValue(undefined),
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
const { ERROR_CATEGORIES } = await import('./aiToolkit/errorDetection.js');
const { runPromptThroughProvider, resolveProviderAndModel, resolveEffectiveModel, pickConfigCorrectedModel } = await import('./promptRunner.js');

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
    runner.executeCliRun.mockImplementation(async ({ onData, onComplete }) => {
      onData('hello ');
      onData('world');
      onComplete({ success: true });
    });

    const out = await runPromptThroughProvider({
      provider: cliProvider(),
      prompt: 'p',
      source: 'test',
    });

    // `provider` is the effective provider that actually ran (reflects a
    // proactive createRun swap); here no swap, so it echoes the input.
    expect(out).toEqual({ text: 'hello world', runId: 'run-xyz', model: 'm-default', provider: cliProvider() });
    expect(runner.executeCliRun).toHaveBeenCalledTimes(1);
    expect(runner.executeApiRun).not.toHaveBeenCalled();
  });

  it('routes API providers through executeApiRun, accumulates text, resolves { text, runId, model }', async () => {
    runner.executeApiRun.mockImplementation(async ({ onData, onComplete }) => {
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

    expect(out).toEqual({ text: 'foobar', runId: 'run-xyz', model: 'gpt-test', provider: apiProvider() });
    expect(runner.executeApiRun).toHaveBeenCalledTimes(1);
    expect(runner.executeCliRun).not.toHaveBeenCalled();
  });

  it('forwards screenshots to executeApiRun for a vision/multimodal call', async () => {
    runner.executeApiRun.mockImplementation(async ({ onComplete }) => onComplete({ success: true }));

    await runPromptThroughProvider({
      provider: apiProvider(),
      prompt: 'describe',
      source: 'test',
      model: 'gpt-vision',
      screenshots: ['a.png', 'b.png'],
    });

    expect(runner.executeApiRun).toHaveBeenCalledWith(
      expect.objectContaining({ screenshots: ['a.png', 'b.png'] }),
    );
  });

  it('defaults screenshots to [] when omitted', async () => {
    runner.executeApiRun.mockImplementation(async ({ onComplete }) => onComplete({ success: true }));

    await runPromptThroughProvider({ provider: apiProvider(), prompt: 'p', source: 'test' });

    expect(runner.executeApiRun).toHaveBeenCalledWith(
      expect.objectContaining({ screenshots: [] }),
    );
  });

  it('runs the fallbackModel (not the primary model) when createRun proactively swaps to a fallback', async () => {
    // Primary is benched at call time, so the toolkit createRun swaps to an
    // API fallback and surfaces the configured fallbackModel. The run must
    // execute that model on the fallback — NOT the primary's resolved model
    // (the leak that sent `codex-configured-default` to LM Studio). This is
    // the common caller path (no pre-created runId), distinct from the
    // runtime-retry path covered below.
    const fallback = apiProvider({ id: 'fb-api', defaultModel: 'fb-default' });
    runner.createRun.mockResolvedValue({
      runId: 'run-fb',
      provider: fallback,
      fallbackModel: 'pinned-fb',
    });
    let ranModel;
    runner.executeApiRun.mockImplementation(async ({ model, onData, onComplete }) => {
      ranModel = model;
      onData('ok');
      onComplete({ success: true });
    });

    const out = await runPromptThroughProvider({
      provider: cliProvider({ defaultModel: 'codex-configured-default' }),
      prompt: 'p',
      source: 'test',
    });

    expect(runner.executeApiRun).toHaveBeenCalledTimes(1);
    expect(runner.executeCliRun).not.toHaveBeenCalled();
    expect(ranModel).toBe('pinned-fb');
    expect(out.model).toBe('pinned-fb');
    // The resolved result reports the proactively-swapped provider (not the
    // requested one), so callers can detect a swap even though usedFallback
    // stays unset on this path.
    expect(out.provider).toEqual(fallback);
  });

  it('forwards the provider id + model + source to createRun', async () => {
    runner.executeApiRun.mockImplementation(async ({ onData, onComplete }) => {
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
    runner.executeCliRun.mockImplementation(async ({ workspacePath, onData, onComplete }) => {
      onData(workspacePath); // echo back the cwd so the assertion below can check it
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
    runner.executeApiRun.mockImplementation(async ({ onData, onComplete }) => {
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
    runner.executeCliRun.mockImplementation(async ({ provider: providerArg, onData, onComplete }) => {
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
    runner.executeCliRun.mockImplementation(async ({ provider: providerArg, onData, onComplete }) => {
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
    runner.executeCliRun.mockImplementation(async ({ provider: providerArg, onData, onComplete }) => {
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
    runner.executeCliRun.mockImplementation(async ({ provider: providerArg, onData, onComplete }) => {
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
    runner.executeCliRun.mockImplementation(async ({ onComplete }) => {
      onComplete({ success: false });
    });

    await expect(runPromptThroughProvider({
      provider: cliProvider(),
      prompt: 'p',
      source: 't',
    })).rejects.toThrow(/CLI execution failed/);
  });

  it('rejects when CLI onComplete reports a non-zero error', async () => {
    runner.executeCliRun.mockImplementation(async ({ onComplete }) => {
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
    runner.executeApiRun.mockImplementation(async ({ onComplete }) => {
      onComplete({ success: false });
    });

    await expect(runPromptThroughProvider({
      provider: apiProvider(),
      prompt: 'p',
      source: 't',
    })).rejects.toThrow(/API execution failed/);
  });

  it('rejects when API onComplete reports a non-zero error', async () => {
    runner.executeApiRun.mockImplementation(async ({ onComplete }) => {
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
    runner.executeCliRun.mockImplementation(async ({ onData, onComplete }) => {
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
    runner.executeApiRun.mockImplementation(async ({ onData, onComplete }) => {
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
    runner.executeApiRun.mockImplementation(async ({ onData, onComplete }) => {
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
    tuiRunner.executeTuiRun.mockImplementation(async ({ onData, onComplete }) => {
      onData('chrome chunk ');
      onData('more chrome');
      onComplete({ success: true, exitCode: 0, text: 'once upon a time' });
    });

    const out = await runPromptThroughProvider({
      provider: tuiProvider(),
      prompt: 'tell me a story',
      source: 'pipeline-text-stage',
    });

    expect(out).toEqual({ text: 'once upon a time', runId: 'run-xyz', model: 'm-default', provider: tuiProvider() });
    expect(tuiRunner.executeTuiRun).toHaveBeenCalledTimes(1);
    expect(runner.executeCliRun).not.toHaveBeenCalled();
    expect(runner.executeApiRun).not.toHaveBeenCalled();
  });

  it('passes cwd + timeout overrides through to executeTuiRun', async () => {
    tuiRunner.executeTuiRun.mockImplementation(async ({ onData, onComplete }) => {
      onData('ok');
      onComplete({ success: true });
    });

    await runPromptThroughProvider({
      provider: tuiProvider(),
      prompt: 'p', source: 't',
      cwd: '/tmp/some-other-repo',
      timeout: 60000,
    });

    const opts = tuiRunner.executeTuiRun.mock.calls[0][0];
    expect(opts.workspacePath).toBe('/tmp/some-other-repo'); // workspacePath option
    expect(opts.timeout).toBe(60000);                         // timeout option
  });

  it('returns result.text from executeTuiRun (which owns its own response cleanup)', async () => {
    tuiRunner.executeTuiRun.mockImplementation(async ({ onData, onComplete }) => {
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
    tuiRunner.executeTuiRun.mockImplementation(async ({ onData, onComplete }) => {
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
    tuiRunner.executeTuiRun.mockImplementation(async ({ onComplete }) => {
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
    runner.executeApiRun.mockImplementation(async ({ onData, onComplete }) => {
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
    runner.executeCliRun.mockImplementation(async ({ onComplete }) => {
      onComplete({ success: false, error: 'Process exited with code 1' });
    });
    runner.executeApiRun.mockImplementation(async ({ onData, onComplete }) => {
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
    // fallbackProvider exposes the full provider object that actually ran
    // so attribution callers (stageRunner persisting runId for history /
    // restore) can record providerId without re-picking the fallback.
    expect(out.fallbackProvider).toMatchObject({ id: 'fallback-api', name: 'Fallback API' });

    // Primary was marked unavailable before retry; fallback was looked up
    // and used; the deferred autoFixer task was cancelled.
    expect(status.markUnavailable).toHaveBeenCalledWith('primary-cli', expect.objectContaining({
      reason: expect.any(String),
    }));
    expect(status.getFallbackProvider).toHaveBeenCalledWith('primary-cli', expect.any(Object));
    // The fallback lifecycle is announced up front (so a slow fallback can't
    // outrun the backstop timer) and resolved on success.
    expect(autoFixer.noteFallbackStarted).toHaveBeenCalledWith({
      provider: 'Primary CLI',
      model: 'primary-model',
    });
    expect(autoFixer.noteFallbackHandled).toHaveBeenCalledWith({
      provider: 'Primary CLI',
      model: 'primary-model',
    });
    expect(autoFixer.noteFallbackFailed).not.toHaveBeenCalled();
  });

  it('does NOT bench the provider on a model-not-found (request-specific bad model id), but still falls back for this call', async () => {
    const status = mockToolkitWithFallback();

    // Primary API fails with a model-not-found — a bad model id in the request,
    // not a provider outage. The provider must stay available for its other
    // (valid) models; only this call falls back.
    runner.executeApiRun
      .mockImplementationOnce(async ({ onComplete }) => {
        onComplete({ success: false, error: "model 'bogus' not found", errorAnalysis: { category: ERROR_CATEGORIES.MODEL_NOT_FOUND } });
      })
      .mockImplementationOnce(async ({ onData, onComplete }) => {
        onData('fallback content');
        onComplete({ success: true });
      });

    const out = await runPromptThroughProvider({ provider: primaryApi, prompt: 'p', source: 'test' });

    expect(out.text).toBe('fallback content');
    expect(out.usedFallback).toBe(true);
    // The carve-out: the provider was NOT benched (mirrors CONTENT_REFUSAL).
    expect(status.markUnavailable).not.toHaveBeenCalled();
    // …but the failing call still recovered via the fallback.
    expect(status.getFallbackProvider).toHaveBeenCalledWith('primary-api', expect.any(Object));
  });

  it('runs the configured fallbackModel on the fallback (never the primary model) when one is pinned', async () => {
    const status = mockToolkitWithFallback();
    // Provider-level fallback that pins a specific model to run on the fallback.
    status.getFallbackProvider.mockReturnValue({
      provider: fallbackApi,
      source: 'provider',
      model: 'pinned-fb-model',
    });

    runner.executeCliRun.mockImplementation(async ({ onComplete }) => {
      onComplete({ success: false, error: 'Process exited with code 1' });
    });
    let ranModel;
    runner.executeApiRun.mockImplementation(async ({ model, onData, onComplete }) => {
      ranModel = model;
      onData('fallback content');
      onComplete({ success: true });
    });

    const out = await runPromptThroughProvider({
      provider: primaryCli,
      prompt: 'p',
      source: 'test',
    });

    expect(out.usedFallback).toBe(true);
    // The pinned fallbackModel must reach the fallback run — NOT the primary's
    // 'primary-model' (the leak this fix closes), and NOT the fallback's own
    // 'fb-model' default (the pin must win).
    expect(ranModel).toBe('pinned-fb-model');
    expect(out.model).toBe('pinned-fb-model');
  });

  it('retries with fallback when primary API fails', async () => {
    mockToolkitWithFallback();

    let calls = 0;
    runner.executeApiRun.mockImplementation(async ({ provider: providerArg, onData, onComplete }) => {
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

  it('uses runner-provided errorAnalysis when marking the failed provider', async () => {
    const status = mockToolkitWithFallback();
    const runnerErrorAnalysis = {
      hasError: true,
      category: 'usage-limit',
      message: 'Usage limit reset at 5pm',
      waitTime: 12345,
    };

    runner.executeCliRun.mockImplementation(async ({ onComplete }) => {
      onComplete({
        success: false,
        error: 'plain wrapper error',
        errorAnalysis: runnerErrorAnalysis,
      });
    });
    runner.executeApiRun.mockImplementation(async ({ onData, onComplete }) => {
      onData('recovered');
      onComplete({ success: true });
    });

    await runPromptThroughProvider({
      provider: primaryCli,
      prompt: 'p',
      source: 'test',
    });

    expect(status.markUsageLimit).toHaveBeenCalledWith('primary-cli', {
      message: 'Usage limit reset at 5pm',
      waitTime: 12345,
    });
    expect(status.markUnavailable).not.toHaveBeenCalled();
  });

  it('does NOT suppress the investigation task when the fallback ALSO fails (both errors must surface)', async () => {
    mockToolkitWithFallback();

    runner.executeCliRun.mockImplementation(async ({ onComplete }) => {
      onComplete({ success: false, error: 'primary boom' });
    });
    runner.executeApiRun.mockImplementation(async ({ onComplete }) => {
      onComplete({ success: false, error: 'fallback also boom' });
    });

    await expect(runPromptThroughProvider({
      provider: primaryCli,
      prompt: 'p',
      source: 'test',
    })).rejects.toThrow(/fallback also boom/);

    // noteFallbackHandled is reserved for SUCCESSFUL fallback. When both fail,
    // the primary's suppression is released via noteFallbackFailed (the
    // fallback provider's own failure already queued its investigation task).
    expect(autoFixer.noteFallbackStarted).toHaveBeenCalledWith({ provider: 'Primary CLI', model: 'primary-model' });
    expect(autoFixer.noteFallbackFailed).toHaveBeenCalledWith({ provider: 'Primary CLI', model: 'primary-model' });
    expect(autoFixer.noteFallbackHandled).not.toHaveBeenCalled();
  });

  it('rethrows the original error when no fallback is available', async () => {
    mockToolkitWithFallback(null);

    runner.executeCliRun.mockImplementation(async ({ onComplete }) => {
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
    runner.executeCliRun.mockImplementation(async ({ onComplete }) => {
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
    runner.executeCliRun.mockImplementation(async ({ onComplete }) => {
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

    runner.executeApiRun.mockImplementation(async ({ provider: providerArg, onData, onComplete }) => {
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

    runner.executeCliRun.mockImplementation(async ({ provider: providerArg, onComplete }) => {
      // Intermediate fails on first attempt.
      onComplete({ success: false, error: `intermediate boom (${providerArg.id})` });
    });
    runner.executeApiRun.mockImplementation(async ({ onData, onComplete }) => {
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

    runner.executeCliRun.mockImplementation(async ({ onComplete }) => {
      onComplete({ success: false, error: 'primary boom' });
    });
    runner.executeApiRun.mockImplementation(async ({ onData, onComplete }) => {
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

    runner.executeCliRun.mockImplementation(async ({ onComplete }) => {
      onComplete({ success: false, error: 'primary boom' });
    });
    runner.executeApiRun.mockImplementation(async ({ onData, onComplete }) => {
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
    runner.executeCliRun.mockImplementation(async ({ onComplete }) => {
      onComplete({ success: false, error: "You've hit your usage limit. Try again in 5 hours" });
    });
    runner.executeApiRun.mockImplementation(async ({ onData, onComplete }) => {
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

  it('coalesces a 10-concurrent-failure storm into one provider-map read + one mark-unavailable', async () => {
    // Acceptance for [coalesce-fallback-provider-failure-storm]: when a
    // stuck provider has N simultaneous in-flight calls, the per-provider
    // mark-and-pick (getAllProviders + markUnavailable) must run ONCE for
    // the whole storm — not once per failing call — while every call still
    // recovers via its own fallback run.
    const status = mockToolkitWithFallback();
    // clearAllMocks() resets call history but NOT mockImplementation, so a
    // throwing noteFallbackHandled impl set by an earlier test would leak in
    // here as best-effort-suppressed stderr. Reset it to a clean no-op.
    autoFixer.noteFallbackHandled.mockImplementation(() => {});

    // Gate the provider-map read so the first failure's mark-and-pick stays
    // in-flight long enough for all 10 failures to pile onto it. Without
    // this hold the first could settle before later calls reach their catch,
    // defeating the coalescing the test means to assert.
    let releaseGetAll;
    const getAllGate = new Promise((resolve) => { releaseGetAll = resolve; });
    providers.getAllProviders.mockReturnValue(
      getAllGate.then(() => ({ activeProvider: null, providers: [primaryCli, primaryApi, fallbackApi] }))
    );

    runner.executeCliRun.mockImplementation(async ({ onComplete }) => {
      onComplete({ success: false, error: 'storm boom' });
    });
    runner.executeApiRun.mockImplementation(async ({ onData, onComplete }) => {
      onData('fallback content');
      onComplete({ success: true });
    });

    const calls = Array.from({ length: 10 }, () => runPromptThroughProvider({
      provider: primaryCli,
      prompt: 'p',
      source: 'test',
    }));

    // Let every call fail its primary run and register on the shared
    // in-flight mark-and-pick, THEN release the gated read.
    await new Promise((r) => setTimeout(r, 0));
    releaseGetAll();

    const results = await Promise.all(calls);

    // Every call recovered through its own fallback run.
    expect(results).toHaveLength(10);
    for (const out of results) {
      expect(out.text).toBe('fallback content');
      expect(out.usedFallback).toBe(true);
    }
    expect(runner.executeApiRun).toHaveBeenCalledTimes(10);

    // ...but the storm read the provider map and benched the provider once.
    expect(providers.getAllProviders).toHaveBeenCalledTimes(1);
    expect(status.getFallbackProvider).toHaveBeenCalledTimes(1);
    expect(status.markUnavailable).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// pickConfigCorrectedModel — pure Tier-1 (config/env) model corrector.
// =============================================================================

describe('pickConfigCorrectedModel', () => {
  it('returns null when the provider carries no enumerable models list', () => {
    expect(pickConfigCorrectedModel({ id: 'p', defaultModel: 'x' }, 'x')).toBeNull();
    expect(pickConfigCorrectedModel({ id: 'p', models: null }, 'x')).toBeNull();
  });

  it('picks a different valid generation model, excluding the failed id', () => {
    const p = { id: 'p', models: ['broken-model', 'good-model', 'other-model'] };
    expect(pickConfigCorrectedModel(p, 'broken-model')).toBe('good-model');
  });

  it('skips embedding-only models so a generation call is never corrected onto one', () => {
    const p = { id: 'p', models: ['broken-model', 'nomic-embed-text:latest', 'qwen3.6:35b'] };
    expect(pickConfigCorrectedModel(p, 'broken-model')).toBe('qwen3.6:35b');
  });

  it('returns null when the only alternatives are the failed id and/or embedding models', () => {
    expect(pickConfigCorrectedModel({ id: 'p', models: ['broken-model'] }, 'broken-model')).toBeNull();
    expect(pickConfigCorrectedModel({ id: 'p', models: ['broken-model', 'nomic-embed-text'] }, 'broken-model')).toBeNull();
  });
});

// =============================================================================
// Tiered fallback cascade (issue #2342) — a model-not-found failure attempts a
// deterministic Tier-1 config/env correction (retry the SAME provider with a
// valid listed model) BEFORE escalating to a Tier-3 fallback provider, and only
// an unrecovered failure escalates to a Tier-4 investigation task.
// =============================================================================

describe('promptRunner — Tier 1 config/env correction (issue #2342)', () => {
  const fallbackApi = apiProvider({ id: 'fallback-api', name: 'Fallback API', defaultModel: 'fb-model' });

  function mockToolkitWithFallback(fallback = fallbackApi) {
    const isAvailable = vi.fn().mockReturnValue(true);
    const markUnavailable = vi.fn().mockResolvedValue(undefined);
    const markUsageLimit = vi.fn().mockResolvedValue(undefined);
    const getFallbackProvider = vi.fn().mockReturnValue(fallback ? { provider: fallback, source: 'provider' } : null);
    toolkitState.getAIToolkitInstance.mockReturnValue({
      services: { providerStatus: { isAvailable, markUnavailable, markUsageLimit, getFallbackProvider } },
    });
    providers.getAllProviders.mockResolvedValue({ activeProvider: null, providers: fallback ? [fallback] : [] });
    return { isAvailable, markUnavailable, markUsageLimit, getFallbackProvider };
  }

  it('recovers a model-not-found by retrying the SAME provider with a valid listed model (never reaching Tier 3)', async () => {
    const status = mockToolkitWithFallback();
    const primary = apiProvider({ id: 'primary-api', name: 'Primary API', defaultModel: 'primary-model', models: ['primary-model', 'good-model'] });

    runner.executeApiRun.mockImplementation(async ({ model, onData, onComplete }) => {
      if (model === 'primary-model') {
        onComplete({ success: false, error: "model 'primary-model' not found", errorAnalysis: { category: ERROR_CATEGORIES.MODEL_NOT_FOUND } });
      } else {
        onData('corrected content');
        onComplete({ success: true });
      }
    });

    const out = await runPromptThroughProvider({ provider: primary, prompt: 'p', source: 'test' });

    expect(out.text).toBe('corrected content');
    expect(out.usedFallback).toBe(true);
    expect(out.fixTier).toBe(1);
    expect(out.fixStrategy).toBe('config/env');
    // Recovered on the SAME provider with the corrected model — Tier 3 untouched.
    expect(out.fallbackProvider).toMatchObject({ id: 'primary-api' });
    expect(out.model).toBe('good-model');
    expect(status.getFallbackProvider).not.toHaveBeenCalled();
    expect(status.markUnavailable).not.toHaveBeenCalled();
    // The primary's investigation task was suppressed up front and resolved.
    expect(autoFixer.noteFallbackStarted).toHaveBeenCalledWith({ provider: 'Primary API', model: 'primary-model' });
    expect(autoFixer.noteFallbackHandled).toHaveBeenCalledWith({ provider: 'Primary API', model: 'primary-model' });
    expect(autoFixer.noteFallbackFailed).not.toHaveBeenCalled();
  });

  it('declines Tier 1 when no alternative model exists and falls through to the Tier-3 fallback provider', async () => {
    const status = mockToolkitWithFallback();
    // Only the failed model is listed → pickConfigCorrectedModel returns null.
    const primary = apiProvider({ id: 'primary-api', name: 'Primary API', defaultModel: 'primary-model', models: ['primary-model'] });

    runner.executeApiRun.mockImplementation(async ({ provider: p, onData, onComplete }) => {
      if (p.id === 'primary-api') {
        onComplete({ success: false, error: 'model missing', errorAnalysis: { category: ERROR_CATEGORIES.MODEL_NOT_FOUND } });
      } else {
        onData('fallback content');
        onComplete({ success: true });
      }
    });

    const out = await runPromptThroughProvider({ provider: primary, prompt: 'p', source: 'test' });

    expect(out.text).toBe('fallback content');
    expect(out.usedFallback).toBe(true);
    expect(out.fixTier).toBe(3);
    expect(out.fixStrategy).toBe('constrained-agent-retry');
    expect(out.fallbackProvider).toMatchObject({ id: 'fallback-api' });
    // Tier 3 engaged: the fallback was looked up (MODEL_NOT_FOUND stays unbenched).
    expect(status.getFallbackProvider).toHaveBeenCalledWith('primary-api', expect.any(Object));
    expect(status.markUnavailable).not.toHaveBeenCalled();
  });

  it('escalates to Tier 3 when the Tier-1 corrected retry ALSO fails, and cancels both queued tasks on recovery', async () => {
    mockToolkitWithFallback();
    const primary = apiProvider({ id: 'primary-api', name: 'Primary API', defaultModel: 'primary-model', models: ['primary-model', 'good-model'] });

    runner.executeApiRun.mockImplementation(async ({ provider: p, model, onData, onComplete }) => {
      if (p.id === 'primary-api') {
        // Both the primary model AND the Tier-1 corrected model fail on this provider.
        onComplete({ success: false, error: `still broken (${model})`, errorAnalysis: { category: ERROR_CATEGORIES.MODEL_NOT_FOUND } });
      } else {
        onData('fallback content');
        onComplete({ success: true });
      }
    });

    const out = await runPromptThroughProvider({ provider: primary, prompt: 'p', source: 'test' });

    expect(out.text).toBe('fallback content');
    expect(out.fixTier).toBe(3);
    // Both the primary key and the Tier-1 corrected-model key are cancelled so a
    // fully-recovered action leaves ZERO investigation tasks.
    expect(autoFixer.noteFallbackHandled).toHaveBeenCalledWith({ provider: 'Primary API', model: 'primary-model' });
    expect(autoFixer.noteFallbackHandled).toHaveBeenCalledWith({ provider: 'Primary API', model: 'good-model' });
    expect(autoFixer.noteFallbackFailed).not.toHaveBeenCalled();
  });

  it('escalates once and releases both suppressed keys when the corrected retry fails and no fallback exists', async () => {
    mockToolkitWithFallback(null); // no fallback available
    const primary = apiProvider({ id: 'primary-api', name: 'Primary API', defaultModel: 'primary-model', models: ['primary-model', 'good-model'] });

    runner.executeApiRun.mockImplementation(async ({ onComplete }) => {
      onComplete({ success: false, error: 'model gone', errorAnalysis: { category: ERROR_CATEGORIES.MODEL_NOT_FOUND } });
    });

    await expect(runPromptThroughProvider({ provider: primary, prompt: 'p', source: 'test' }))
      .rejects.toThrow(/model gone/);

    // Both the primary AND the pre-suppressed corrected-retry key were
    // suppressed, so nothing incidental would surface the failure — the cascade
    // escalates exactly one investigation task explicitly, then releases both
    // keys so the in-flight set doesn't leak.
    expect(autoFixer.noteFallbackStarted).toHaveBeenCalledWith({ provider: 'Primary API', model: 'primary-model' });
    expect(autoFixer.noteFallbackStarted).toHaveBeenCalledWith({ provider: 'Primary API', model: 'good-model' });
    expect(autoFixer.escalateProviderFailure).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ provider: 'Primary API', model: 'primary-model' }),
    }));
    expect(autoFixer.noteFallbackFailed).toHaveBeenCalledWith({ provider: 'Primary API', model: 'primary-model' });
    expect(autoFixer.noteFallbackFailed).toHaveBeenCalledWith({ provider: 'Primary API', model: 'good-model' });
    expect(autoFixer.noteFallbackHandled).not.toHaveBeenCalled();
  });

  it('skips Tier 1 for a CLI provider whose model flag is baked into args (override ignored)', async () => {
    // providerHonorsModelOverride is false when the CLI has a baked --model, so
    // the "corrected" model would silently be the same failed one. Tier 1 must
    // decline and the cascade fall through to the fallback provider instead.
    runner.hasModelFlag.mockReturnValue(true); // args carry a baked model flag
    const status = mockToolkitWithFallback();
    const primary = { id: 'primary-cli', name: 'Primary CLI', type: 'cli', defaultModel: 'baked-model', timeout: 5000, args: ['--model', 'baked-model'], models: ['baked-model', 'good-model'] };

    let primaryCalls = 0;
    runner.executeCliRun.mockImplementation(async ({ onComplete }) => {
      primaryCalls += 1;
      onComplete({ success: false, error: 'model not found', errorAnalysis: { category: ERROR_CATEGORIES.MODEL_NOT_FOUND } });
    });
    runner.executeApiRun.mockImplementation(async ({ onData, onComplete }) => {
      onData('fallback content');
      onComplete({ success: true });
    });

    const out = await runPromptThroughProvider({ provider: primary, prompt: 'p', source: 'test' });

    // No same-provider corrected retry (primary ran once), straight to Tier 3.
    expect(primaryCalls).toBe(1);
    expect(out.fixTier).toBe(3);
    expect(status.getFallbackProvider).toHaveBeenCalledWith('primary-cli', expect.any(Object));
  });

  it('does NOT attempt a Tier-1 correction for non-model failure categories', async () => {
    const status = mockToolkitWithFallback();
    // A rate-limit (Tier 3) failure must skip the config/env correction even
    // though the provider lists an alternative model.
    const primary = apiProvider({ id: 'primary-api', name: 'Primary API', defaultModel: 'primary-model', models: ['primary-model', 'good-model'] });

    let primaryCalls = 0;
    runner.executeApiRun.mockImplementation(async ({ provider: p, onData, onComplete }) => {
      if (p.id === 'primary-api') {
        primaryCalls += 1;
        onComplete({ success: false, error: 'rate limited', errorAnalysis: { category: ERROR_CATEGORIES.RATE_LIMIT } });
      } else {
        onData('fallback content');
        onComplete({ success: true });
      }
    });

    const out = await runPromptThroughProvider({ provider: primary, prompt: 'p', source: 'test' });

    // The primary provider ran exactly once (no Tier-1 corrected retry) before
    // going straight to the Tier-3 fallback.
    expect(primaryCalls).toBe(1);
    expect(out.fixTier).toBe(3);
    expect(status.getFallbackProvider).toHaveBeenCalledWith('primary-api', expect.any(Object));
  });

  it('escalates explicitly when a Tier-1 pre-execution throw leaves no survivor and no fallback exists', async () => {
    // The corrected retry throws BEFORE execution (createRun rejects), so its
    // onRunFailed never queues a task. With no fallback either, the primary's
    // pre-suppressed backstop task would be swallowed — so the cascade must
    // escalate exactly one investigation task explicitly.
    mockToolkitWithFallback(null); // no fallback
    const primary = apiProvider({ id: 'primary-api', name: 'Primary API', defaultModel: 'primary-model', models: ['primary-model', 'good-model'] });

    runner.createRun
      .mockResolvedValueOnce({ runId: 'run-primary' })       // primary run
      .mockRejectedValueOnce(new Error('provider disabled')); // corrected retry: pre-execution throw
    runner.executeApiRun.mockImplementation(async ({ onComplete }) => {
      onComplete({ success: false, error: 'model gone', errorAnalysis: { category: ERROR_CATEGORIES.MODEL_NOT_FOUND } });
    });

    await expect(runPromptThroughProvider({ provider: primary, prompt: 'p', source: 'test' }))
      .rejects.toThrow(/model gone/);

    expect(autoFixer.escalateProviderFailure).toHaveBeenCalledWith(expect.objectContaining({
      code: 'AI_PROVIDER_EXECUTION_FAILED',
      context: expect.objectContaining({ provider: 'Primary API', model: 'primary-model' }),
    }));
    expect(autoFixer.noteFallbackStarted).toHaveBeenCalledWith({ provider: 'Primary API', model: 'primary-model' });
  });

  it('keys the Tier-1 corrected-retry task on the run that actually ran when createRun proactively swaps', async () => {
    // The corrected retry's createRun proactively swaps to a different provider,
    // which then fails — its queued task is keyed on the SWAPPED provider/model,
    // so the recovery must cancel THAT key (not the pre-run guess).
    const swapped = apiProvider({ id: 'swapped-api', name: 'Swapped API', defaultModel: 'swapped-model' });
    mockToolkitWithFallback(); // fallback available for the Tier-3 recovery
    const primary = apiProvider({ id: 'primary-api', name: 'Primary API', defaultModel: 'primary-model', models: ['primary-model', 'good-model'] });

    runner.createRun
      .mockResolvedValueOnce({ runId: 'run-primary' })                      // primary
      .mockResolvedValueOnce({ runId: 'run-corrected', provider: swapped }) // corrected retry swaps
      .mockResolvedValue({ runId: 'run-fb' });                             // fallback run
    runner.executeApiRun.mockImplementation(async ({ provider: p, onData, onComplete }) => {
      if (p.id === 'primary-api') {
        onComplete({ success: false, error: 'model gone', errorAnalysis: { category: ERROR_CATEGORIES.MODEL_NOT_FOUND } });
      } else if (p.id === 'swapped-api') {
        onComplete({ success: false, error: 'swapped also failed', errorAnalysis: { category: ERROR_CATEGORIES.MODEL_NOT_FOUND } });
      } else {
        onData('fallback content');
        onComplete({ success: true });
      }
    });

    const out = await runPromptThroughProvider({ provider: primary, prompt: 'p', source: 'test' });

    expect(out.text).toBe('fallback content');
    expect(out.fixTier).toBe(3);
    expect(autoFixer.noteFallbackHandled).toHaveBeenCalledWith({ provider: 'Swapped API', model: 'swapped-model' });
    expect(autoFixer.noteFallbackHandled).toHaveBeenCalledWith({ provider: 'Primary API', model: 'primary-model' });
  });

  it('does NOT engage Tier 1 for a category-less failure even when the provider lists alternatives', async () => {
    // Regression: a failure with no errorAnalysis has category === undefined,
    // which must NOT match the model-not-found guard (the `undefined ===
    // ERROR_CATEGORIES.MODEL_NOT_SUPPORTED` footgun). The primary must run once,
    // then go straight to Tier 3 — never a same-provider model swap.
    const status = mockToolkitWithFallback();
    const primary = apiProvider({ id: 'primary-api', name: 'Primary API', defaultModel: 'primary-model', models: ['primary-model', 'good-model'] });

    let primaryCalls = 0;
    runner.executeApiRun.mockImplementation(async ({ provider: p, onData, onComplete }) => {
      if (p.id === 'primary-api') {
        primaryCalls += 1;
        onComplete({ success: false, error: 'exited with code 1' }); // no errorAnalysis
      } else {
        onData('fallback content');
        onComplete({ success: true });
      }
    });

    const out = await runPromptThroughProvider({ provider: primary, prompt: 'p', source: 'test' });

    expect(primaryCalls).toBe(1);
    expect(out.fixTier).toBe(3);
    expect(status.getFallbackProvider).toHaveBeenCalledWith('primary-api', expect.any(Object));
  });
});

describe('resolveEffectiveModel — embedding-model skip', () => {
  it('skips an embedding-first models list when defaultModel is null (the nomic-embed-text fallback bug)', () => {
    // Mirrors the real Ollama provider: defaultModel null, embedding model
    // listed first. A generation/fallback run must NOT resolve the embedding.
    const ollama = {
      id: 'ollama', type: 'api', defaultModel: null,
      models: ['nomic-embed-text:latest', 'qwen3.6:35b', 'gpt-oss:20b'],
    };
    expect(resolveEffectiveModel(ollama, null)).toBe('qwen3.6:35b');
  });

  it('still honors an explicit defaultModel', () => {
    const p = { id: 'ollama', type: 'api', defaultModel: 'llama3.2:latest', models: ['nomic-embed-text:latest', 'llama3.2:latest'] };
    expect(resolveEffectiveModel(p, null)).toBe('llama3.2:latest');
  });

  it('falls back to models[0] only when every model is an embedding model', () => {
    const p = { id: 'ollama', type: 'api', defaultModel: null, models: ['nomic-embed-text:latest', 'mxbai-embed-large'] };
    expect(resolveEffectiveModel(p, null)).toBe('nomic-embed-text:latest');
  });

  it('skips a stale embedding-only defaultModel (older config the UI never re-edited)', () => {
    // A pre-existing local provider can carry an embedding id in defaultModel;
    // a generation/fallback run must not route to it — fall through to the
    // first generation model in the list.
    const p = { id: 'ollama', type: 'api', defaultModel: 'nomic-embed-text:latest', models: ['nomic-embed-text:latest', 'qwen3.6:35b'] };
    expect(resolveEffectiveModel(p, null)).toBe('qwen3.6:35b');
  });

  it('skips an embedding-only callerModel and falls through to a generation model', () => {
    const p = { id: 'ollama', type: 'api', defaultModel: 'qwen3.6:35b', models: ['nomic-embed-text:latest', 'qwen3.6:35b'] };
    expect(resolveEffectiveModel(p, 'nomic-embed-text:latest')).toBe('qwen3.6:35b');
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
