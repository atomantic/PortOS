import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/providers.js', () => ({
  getActiveProvider: vi.fn(),
  getProviderById: vi.fn(),
}));

vi.mock('../services/promptService.js', () => ({
  buildPrompt: vi.fn().mockResolvedValue('rendered-prompt'),
  getStage: vi.fn(),
}));

vi.mock('../services/runner.js', () => ({
  createRun: vi.fn(async () => ({ runId: 'run-abc12345' })),
  executeApiRun: vi.fn(),
  executeCliRun: vi.fn(),
  extractBakedModel: vi.fn(() => null),
  hasModelFlag: vi.fn(() => false),
  patchRunMetadata: vi.fn(async () => undefined),
}));

const providers = await import('../services/providers.js');
const prompts = await import('../services/promptService.js');
const runner = await import('../services/runner.js');
const {
  runStagedLLM,
  runInlineLLM,
  resolveModel,
  extractJson,
  DEFAULT_LARGE_CONTEXT_WINDOW,
  CODEX_CONTEXT_WINDOW,
  GEMINI_CONTEXT_WINDOW,
  GROK_CONTEXT_WINDOW,
  KIMI_CONTEXT_WINDOW,
  effectiveContextWindow,
  knownModelContextWindow,
  knownProviderContextWindow,
  resolveStageContext,
  resolveJudgeForStage,
  withLocalConcurrencyGate,
  LOCAL_LLM_MAX_CONCURRENCY,
} = await import('./stageRunner.js');

const apiProvider = (extra = {}) => ({
  id: 'mock-api', name: 'Mock', type: 'api', enabled: true, defaultModel: 'm-default', ...extra,
});
const cliProvider = (extra = {}) => ({
  id: 'codex', name: 'Codex', type: 'cli', enabled: true, defaultModel: 'm-default', timeout: 5000, ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  runner.extractBakedModel.mockReturnValue(null);
  runner.hasModelFlag.mockReturnValue(false);
});

describe('stageRunner — resolveModel', () => {
  it('returns provider.defaultModel when no hint', () => {
    expect(resolveModel({ defaultModel: 'd' }, null)).toBe('d');
    expect(resolveModel({ defaultModel: 'd' }, undefined)).toBe('d');
  });

  it('maps tier names to per-tier provider keys, falls back to defaultModel when missing', () => {
    const p = { defaultModel: 'd', lightModel: 'l', mediumModel: 'm', heavyModel: 'h' };
    expect(resolveModel(p, 'quick')).toBe('l');
    expect(resolveModel(p, 'coding')).toBe('m');
    expect(resolveModel(p, 'heavy')).toBe('h');
    expect(resolveModel(p, 'default')).toBe('d');
    expect(resolveModel({ defaultModel: 'd' }, 'heavy')).toBe('d'); // tier missing → fall back
  });

  it('returns explicit model id verbatim when not a tier name', () => {
    expect(resolveModel({ defaultModel: 'd' }, 'gpt-5-explicit')).toBe('gpt-5-explicit');
  });

  it('falls back to provider.models[0] when defaultModel is unset (no hint)', () => {
    expect(resolveModel({ models: ['m0', 'm1'] }, null)).toBe('m0');
    expect(resolveModel({ models: ['m0'], defaultModel: '' }, null)).toBe('m0');
  });

  it('falls back to provider.models[0] when both tier slot and defaultModel are unset', () => {
    expect(resolveModel({ models: ['m0', 'm1'] }, 'heavy')).toBe('m0');
  });

  it('returns null when neither defaultModel nor models[] is available', () => {
    expect(resolveModel({}, null)).toBeNull();
    expect(resolveModel({ models: [] }, null)).toBeNull();
    expect(resolveModel({}, 'heavy')).toBeNull();
  });
});

describe('stageRunner — context windows', () => {
  it('resolves known model windows from the selected model id', () => {
    expect(knownModelContextWindow('gpt-5.5')).toBe(CODEX_CONTEXT_WINDOW);
    expect(knownModelContextWindow('gpt-5.4')).toBe(CODEX_CONTEXT_WINDOW);
    expect(knownModelContextWindow('gpt-5.4-mini')).toBe(400_000);
    expect(knownModelContextWindow('gpt-5.4-nano')).toBeNull();
    expect(knownModelContextWindow('claude-opus-4-8')).toBe(1_000_000);
    expect(knownModelContextWindow('claude-sonnet-5')).toBe(1_000_000);
    expect(knownModelContextWindow('claude-sonnet-4-6')).toBe(1_000_000);
    expect(knownModelContextWindow('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe(200_000);
    expect(knownModelContextWindow('gemini-2.5-pro')).toBe(GEMINI_CONTEXT_WINDOW);
    expect(knownModelContextWindow('unknown-model')).toBeNull();
  });

  it('resolves configured-default provider windows by provider identity', () => {
    expect(knownProviderContextWindow({ id: 'codex-tui', type: 'tui', command: 'codex' })).toBe(CODEX_CONTEXT_WINDOW);
    expect(knownProviderContextWindow({ id: 'antigravity-cli', type: 'cli', command: 'agy' })).toBe(GEMINI_CONTEXT_WINDOW);
    // Mirrors client/src/utils/providers.js — a custom grok CLI/TUI without an
    // explicit contextWindow must resolve the same 256K on both sides.
    expect(knownProviderContextWindow({ id: 'grok-cli', type: 'cli', command: 'grok' })).toBe(GROK_CONTEXT_WINDOW);
    expect(knownProviderContextWindow({ id: 'grok-tui', type: 'tui', command: 'grok' })).toBe(GROK_CONTEXT_WINDOW);
    // Kimi Code (K2's 256K window) — same on both server + client mirrors.
    expect(knownProviderContextWindow({ id: 'kimi-cli', type: 'cli', command: 'kimi' })).toBe(KIMI_CONTEXT_WINDOW);
    expect(knownProviderContextWindow({ id: 'kimi-tui', type: 'tui', command: 'kimi' })).toBe(KIMI_CONTEXT_WINDOW);
  });

  it('normalizes command paths to the basename for vendor windows (#2337)', () => {
    // Absolute path to the binary (common when the service PATH can't resolve the CLI).
    expect(knownProviderContextWindow({ id: 'custom', type: 'cli', command: '/opt/homebrew/bin/grok' })).toBe(GROK_CONTEXT_WINDOW);
    expect(knownProviderContextWindow({ id: 'custom', type: 'tui', command: '/usr/local/bin/codex' })).toBe(CODEX_CONTEXT_WINDOW);
    expect(knownProviderContextWindow({ id: 'custom', type: 'cli', command: '/opt/homebrew/bin/agy' })).toBe(GEMINI_CONTEXT_WINDOW);
    // Relative path.
    expect(knownProviderContextWindow({ id: 'custom', type: 'cli', command: './bin/codex' })).toBe(CODEX_CONTEXT_WINDOW);
    // Windows .exe suffix + backslash separators.
    expect(knownProviderContextWindow({ id: 'custom', type: 'cli', command: 'C:\\tools\\grok.exe' })).toBe(GROK_CONTEXT_WINDOW);
    expect(knownProviderContextWindow({ id: 'custom', type: 'cli', command: '/opt/homebrew/bin/kimi' })).toBe(KIMI_CONTEXT_WINDOW);
    // Unrelated custom command still falls through to null.
    expect(knownProviderContextWindow({ id: 'custom', type: 'cli', command: '/opt/homebrew/bin/mycli' })).toBeNull();
  });

  it('keeps an explicit provider contextWindow above model defaults', () => {
    expect(effectiveContextWindow(
      { type: 'tui', contextWindow: 64_000 },
      'claude-opus-4-8'
    )).toBe(64_000);
  });

  it('uses model and provider windows before provider numCtx', () => {
    expect(effectiveContextWindow(
      { type: 'api', endpoint: 'http://localhost:11434/v1', numCtx: 32_768 },
      'claude-sonnet-4-6'
    )).toBe(1_000_000);
    expect(effectiveContextWindow(
      { id: 'codex', type: 'cli', command: 'codex', numCtx: 32_768 },
      'codex-configured-default'
    )).toBe(CODEX_CONTEXT_WINDOW);
  });

  it('falls back to numCtx, large-provider default, or null', () => {
    expect(effectiveContextWindow(
      { type: 'api', endpoint: 'http://localhost:11434/v1', numCtx: 32_768 },
      'unknown-local-model'
    )).toBe(32_768);
    expect(effectiveContextWindow(
      { type: 'cli' },
      'unknown-cli-model'
    )).toBe(DEFAULT_LARGE_CONTEXT_WINDOW);
    expect(effectiveContextWindow(
      { type: 'api', endpoint: 'http://localhost:1234/v1' },
      'unknown-local-model'
    )).toBeNull();
  });

  it('budgets with the effective model when a CLI provider has a baked model flag', async () => {
    prompts.getStage.mockReturnValue(null);
    providers.getActiveProvider.mockResolvedValue(cliProvider({
      args: ['--model', 'claude-opus-4-8'],
      defaultModel: 'claude-sonnet-4-6',
    }));
    runner.hasModelFlag.mockReturnValue(true);
    runner.extractBakedModel.mockReturnValue('claude-opus-4-8');

    const context = await resolveStageContext('any-stage');
    expect(context.model).toBe('claude-opus-4-8');
    expect(context.contextWindow).toBe(1_000_000);
  });
});

describe('stageRunner — extractJson', () => {
  it('parses JSON inside markdown code fences', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('extracts the first balanced object even when prose is prepended', () => {
    expect(extractJson('Sure! Here is the data: {"a":1,"b":2} cheers.')).toEqual({ a: 1, b: 2 });
  });
  it('parses an array', () => {
    expect(extractJson('[1,2,3]')).toEqual([1, 2, 3]);
  });
  it('preserves an array-of-objects wrapper instead of grabbing the inner object', () => {
    // Regression: an "object-first then array-fallback" strategy used to
    // return `{"a":1}` from `[{"a":1},{"a":2}]`, silently dropping the
    // array wrapper. The current strategy walks balanced candidates for
    // BOTH shapes, sorts by source-text start position, and returns the
    // first that parses — so the array opener at position 0 wins over
    // the inner object opener at position 1.
    expect(extractJson('[{"a":1},{"a":2}]')).toEqual([{ a: 1 }, { a: 2 }]);
  });
  it('preserves an array-of-objects wrapper inside a fenced response', () => {
    expect(extractJson('```json\n[{"id":"x"}]\n```')).toEqual([{ id: 'x' }]);
  });
  it('still extracts a leading object when an array appears later in prose', () => {
    expect(extractJson('Sure! {"a":1} (example array later: [1,2])')).toEqual({ a: 1 });
  });
  it('skips a Codex CLI banner `[workdir, /tmp]` and returns the actual object', () => {
    // Regression: a raw `indexOf('[') < indexOf('{')` peek would prefer
    // array-mode and (in the worst case) return an inner array field
    // instead of the wrapping object. Earliest-parseable-block ordering
    // skips the banner because its contents don't parse as JSON.
    const raw = 'OpenAI Codex CLI v2.1.0\n[workdir, /tmp]\n\n{"a":1,"b":[2,3]}\n[finished]';
    expect(extractJson(raw)).toEqual({ a: 1, b: [2, 3] });
  });
  it('returns the wrapping object — not its inner array field — when both walks succeed', () => {
    // Object opener comes before the inner array opener, so the object
    // wins on earliest-start ordering.
    expect(extractJson('{"items":[1,2,3]}')).toEqual({ items: [1, 2, 3] });
  });
  it('strips a known echoed prompt before walking so the real response wins', () => {
    // Regression: Codex CLI echoes stdin to stdout, so when a stage
    // prompt contains a fenced JSON schema example, both that schema
    // AND the model's actual response are present in the captured
    // text. Picking by source order returns the schema (placeholder
    // data). Passing the prompt verbatim lets extractJson strip the
    // echo first, so the response wins.
    const prompt = 'Prompt echo:\n```json\n{"_schema":"example"}\n```';
    const raw = `${prompt}\n\nResponse:\n{"answer":42}`;
    expect(extractJson(raw, { promptToStrip: prompt })).toEqual({ answer: 42 });
  });
  it('without promptToStrip, an echoed schema block still wins on source order (documents the failure mode)', () => {
    // This is the failure mode that runStagedLLM avoids by ALWAYS
    // passing the prompt down. Kept here so future contributors who
    // bypass the stripping path know they have to provide it.
    const raw = 'Prompt echo:\n```json\n{"_schema":"example"}\n```\n\nResponse:\n{"answer":42}';
    expect(extractJson(raw)).toEqual({ _schema: 'example' });
  });
  it('throws on empty or non-string input', () => {
    expect(() => extractJson('')).toThrow(/Empty AI response/);
    expect(() => extractJson(null)).toThrow(/Empty AI response/);
  });
});

describe('stageRunner — runStagedLLM provider resolution', () => {
  it('uses the active provider when stage and overrides leave it unspecified', async () => {
    prompts.getStage.mockReturnValue(null);
    providers.getActiveProvider.mockResolvedValue(apiProvider());
    runner.executeApiRun.mockImplementation(async ({ onData, onComplete }) => {
      onData('hello');
      onComplete({ success: true });
    });
    const out = await runStagedLLM('any-stage', {});
    expect(out.providerId).toBe('mock-api');
    expect(out.content).toBe('hello');
    expect(runner.createRun).toHaveBeenCalledTimes(1);
    expect(runner.executeApiRun).toHaveBeenCalledTimes(1);
  });

  it('honors providerOverride beating stage.provider', async () => {
    prompts.getStage.mockReturnValue({ provider: 'should-not-use' });
    providers.getProviderById.mockImplementation(async (id) => (
      id === 'override-id' ? apiProvider({ id: 'override-id' }) : null
    ));
    runner.executeApiRun.mockImplementation(async ({ onData, onComplete }) => {
      onData('override-content');
      onComplete({ success: true });
    });
    const out = await runStagedLLM('s', {}, { providerOverride: 'override-id' });
    expect(out.providerId).toBe('override-id');
    expect(providers.getActiveProvider).not.toHaveBeenCalled();
  });

  it('uses stage.provider when set and no override', async () => {
    prompts.getStage.mockReturnValue({ provider: 'stage-pinned' });
    providers.getProviderById.mockImplementation(async (id) => (
      id === 'stage-pinned' ? apiProvider({ id: 'stage-pinned' }) : null
    ));
    runner.executeApiRun.mockImplementation(async ({ onData, onComplete }) => {
      onData('pinned');
      onComplete({ success: true });
    });
    const out = await runStagedLLM('s', {});
    expect(out.providerId).toBe('stage-pinned');
  });

  it('lets stage.provider beat a blanket providerDefault (pin wins over run default)', async () => {
    prompts.getStage.mockReturnValue({ provider: 'stage-pinned' });
    providers.getProviderById.mockImplementation(async (id) => (
      id === 'stage-pinned' ? apiProvider({ id: 'stage-pinned' }) : apiProvider({ id })
    ));
    runner.executeApiRun.mockImplementation(async ({ onData, onComplete }) => {
      onData('pinned');
      onComplete({ success: true });
    });
    const out = await runStagedLLM('s', {}, { providerDefault: 'run-default' });
    expect(out.providerId).toBe('stage-pinned');
    expect(providers.getActiveProvider).not.toHaveBeenCalled();
  });

  it('uses providerDefault when the stage has no pin', async () => {
    prompts.getStage.mockReturnValue(null);
    providers.getProviderById.mockImplementation(async (id) => (
      id === 'run-default' ? apiProvider({ id: 'run-default' }) : null
    ));
    runner.executeApiRun.mockImplementation(async ({ onData, onComplete }) => {
      onData('defaulted');
      onComplete({ success: true });
    });
    const out = await runStagedLLM('s', {}, { providerDefault: 'run-default' });
    expect(out.providerId).toBe('run-default');
    expect(providers.getActiveProvider).not.toHaveBeenCalled();
  });

  it('falls through to the active provider when providerDefault is unavailable (soft default)', async () => {
    prompts.getStage.mockReturnValue(null);
    providers.getProviderById.mockResolvedValue(null);
    providers.getActiveProvider.mockResolvedValue(apiProvider());
    runner.executeApiRun.mockImplementation(async ({ onData, onComplete }) => {
      onData('active');
      onComplete({ success: true });
    });
    const out = await runStagedLLM('s', {}, { providerDefault: 'gone' });
    expect(out.providerId).toBe('mock-api');
  });

  it('throws STAGE_PROVIDER_UNAVAILABLE when stage.provider is set but disabled', async () => {
    prompts.getStage.mockReturnValue({ provider: 'pinned-but-gone' });
    providers.getProviderById.mockResolvedValue(null);
    await expect(runStagedLLM('s', {})).rejects.toMatchObject({ code: 'STAGE_PROVIDER_UNAVAILABLE' });
  });

  it('throws PROVIDER_OVERRIDE_UNAVAILABLE when override is unknown', async () => {
    prompts.getStage.mockReturnValue(null);
    providers.getProviderById.mockResolvedValue(null);
    await expect(runStagedLLM('s', {}, { providerOverride: 'nope' })).rejects.toMatchObject({ code: 'PROVIDER_OVERRIDE_UNAVAILABLE' });
  });

  it('throws NO_PROVIDER when no active provider is available', async () => {
    prompts.getStage.mockReturnValue(null);
    providers.getActiveProvider.mockResolvedValue(null);
    await expect(runStagedLLM('s', {})).rejects.toMatchObject({ code: 'NO_PROVIDER' });
  });
});

// Soft model-default tier (#1558): mirrors the providerDefault provider tests
// above, one dimension over — but deliberately NOT symmetric. Precedence is
// modelOverride (hard) > explicit stage.model pin > modelDefault (soft, Series
// Autopilot's run model) > stage.model tier > provider default. The key
// asymmetry (and the bug codex caught in review): nearly every stage carries a
// *tier* value, which the run model MUST override — only an explicit model id is
// a deliberate pin that beats the run model. Each case asserts the model carried
// into the run record (out.model) = resolveEffectiveModel(provider, resolveModel(...)).
describe('stageRunner — runStagedLLM model resolution (#1558)', () => {
  const onComplete = (text) => async ({ onData, onComplete: done }) => { onData(text); done({ success: true }); };

  it('lets an explicit stage.model pin beat a blanket modelDefault (deliberate pin wins)', async () => {
    prompts.getStage.mockReturnValue({ model: 'pinned-model-id' });
    providers.getActiveProvider.mockResolvedValue(apiProvider());
    runner.executeApiRun.mockImplementation(onComplete('ok'));
    const out = await runStagedLLM('s', {}, { modelDefault: 'run-model' });
    expect(out.model).toBe('pinned-model-id');
  });

  it('lets modelDefault OVERRIDE a stage TIER value (the run model applies to unpinned/tier stages)', async () => {
    // A tier (default/quick/coding/heavy) is NOT a deliberate pin — the run model
    // must win, else launching autopilot with a model is a no-op on ~every stage.
    prompts.getStage.mockReturnValue({ model: 'heavy' });
    providers.getActiveProvider.mockResolvedValue(apiProvider({ heavyModel: 'h' }));
    runner.executeApiRun.mockImplementation(onComplete('ok'));
    const out = await runStagedLLM('s', {}, { modelDefault: 'run-model' });
    expect(out.model).toBe('run-model');
  });

  it('resolves a stage TIER normally when no modelDefault is set (unchanged behavior)', async () => {
    prompts.getStage.mockReturnValue({ model: 'heavy' });
    providers.getActiveProvider.mockResolvedValue(apiProvider({ heavyModel: 'h' }));
    runner.executeApiRun.mockImplementation(onComplete('ok'));
    const out = await runStagedLLM('s', {});
    expect(out.model).toBe('h');
  });

  it('uses modelDefault when the stage has no model field at all', async () => {
    prompts.getStage.mockReturnValue(null);
    providers.getActiveProvider.mockResolvedValue(apiProvider());
    runner.executeApiRun.mockImplementation(onComplete('ok'));
    const out = await runStagedLLM('s', {}, { modelDefault: 'run-model' });
    expect(out.model).toBe('run-model');
  });

  it('lets modelOverride (hard) beat an explicit pin, a tier, and modelDefault', async () => {
    prompts.getStage.mockReturnValue({ model: 'pinned-model-id' });
    providers.getActiveProvider.mockResolvedValue(apiProvider());
    runner.executeApiRun.mockImplementation(onComplete('ok'));
    const out = await runStagedLLM('s', {}, { modelOverride: 'hard-model', modelDefault: 'run-model' });
    expect(out.model).toBe('hard-model');
  });

  it('falls through to the provider default when no override, pin, tier, or modelDefault is set', async () => {
    prompts.getStage.mockReturnValue(null);
    providers.getActiveProvider.mockResolvedValue(apiProvider());
    runner.executeApiRun.mockImplementation(onComplete('ok'));
    const out = await runStagedLLM('s', {});
    expect(out.model).toBe('m-default');
  });
});

describe('stageRunner — runInlineLLM (#1346)', () => {
  it('runs a caller-supplied prompt with no stage (active provider, no buildPrompt)', async () => {
    providers.getActiveProvider.mockResolvedValue(apiProvider());
    let executedPrompt;
    runner.executeApiRun.mockImplementation(async ({ prompt, onData, onComplete }) => {
      executedPrompt = prompt;
      onData('{"findings": []}');
      onComplete({ success: true });
    });
    const out = await runInlineLLM('my inline prompt body', { returnsJson: true, source: 'pipeline-editorial-custom' });
    expect(out.providerId).toBe('mock-api');
    expect(out.content).toEqual({ findings: [] });
    // The prompt is passed through verbatim — buildPrompt/getStage are not consulted.
    expect(executedPrompt).toBe('my inline prompt body');
    expect(prompts.buildPrompt).not.toHaveBeenCalled();
    expect(prompts.getStage).not.toHaveBeenCalled();
  });

  it('rejects an empty prompt', async () => {
    await expect(runInlineLLM('   ')).rejects.toMatchObject({ code: 'INLINE_PROMPT_REQUIRED' });
    await expect(runInlineLLM(null)).rejects.toMatchObject({ code: 'INLINE_PROMPT_REQUIRED' });
  });
});

describe('stageRunner — runStagedLLM dispatch', () => {
  it('routes CLI providers through executeCliRun', async () => {
    prompts.getStage.mockReturnValue(null);
    providers.getActiveProvider.mockResolvedValue(cliProvider());
    runner.executeCliRun.mockImplementation(async ({ onData, onComplete }) => {
      onData('cli-output');
      onComplete({ success: true });
    });
    const out = await runStagedLLM('s', {});
    expect(out.content).toBe('cli-output');
    expect(runner.executeCliRun).toHaveBeenCalledTimes(1);
    expect(runner.executeApiRun).not.toHaveBeenCalled();
  });

  it('rejects when executeApiRun reports an error', async () => {
    prompts.getStage.mockReturnValue(null);
    providers.getActiveProvider.mockResolvedValue(apiProvider());
    runner.executeApiRun.mockImplementation(async ({ onComplete }) => {
      onComplete({ error: 'simulated 500' });
    });
    await expect(runStagedLLM('s', {})).rejects.toThrow(/simulated 500/);
  });

  it('rejects when executeCliRun reports success: false', async () => {
    prompts.getStage.mockReturnValue(null);
    providers.getActiveProvider.mockResolvedValue(cliProvider());
    runner.executeCliRun.mockImplementation(async ({ onComplete }) => {
      onComplete({ success: false, error: 'cli failed' });
    });
    await expect(runStagedLLM('s', {})).rejects.toThrow(/cli failed/);
  });

  it('parses JSON when returnsJson is true', async () => {
    prompts.getStage.mockReturnValue(null);
    providers.getActiveProvider.mockResolvedValue(apiProvider());
    runner.executeApiRun.mockImplementation(async ({ onData, onComplete }) => {
      onData('```json\n{"x":1}\n```');
      onComplete({ success: true });
    });
    const out = await runStagedLLM('s', {}, { returnsJson: true });
    expect(out.content).toEqual({ x: 1 });
  });

  it('forwards source to createRun for transcript filtering', async () => {
    prompts.getStage.mockReturnValue(null);
    providers.getActiveProvider.mockResolvedValue(apiProvider());
    runner.executeApiRun.mockImplementation(async ({ onData, onComplete }) => {
      onData('out');
      onComplete({ success: true });
    });
    await runStagedLLM('s', {}, { source: 'pipeline-text-stage' });
    expect(runner.createRun).toHaveBeenCalledWith(expect.objectContaining({ source: 'pipeline-text-stage' }));
  });

  it('passes stage.timeout to executeCliRun when set', async () => {
    prompts.getStage.mockReturnValue({ timeout: 900000 });
    providers.getActiveProvider.mockResolvedValue(cliProvider({ timeout: 5000 }));
    runner.executeCliRun.mockImplementation(async ({ onComplete }) => {
      onComplete({ success: true });
    });
    await runStagedLLM('s', {});
    // executeCliRun({ runId, provider, prompt, workspacePath, onData, onComplete, timeout })
    expect(runner.executeCliRun.mock.calls[0][0].timeout).toBe(900000);
  });

  it('falls back to provider.timeout when stage.timeout is missing', async () => {
    prompts.getStage.mockReturnValue(null);
    providers.getActiveProvider.mockResolvedValue(cliProvider({ timeout: 5000 }));
    runner.executeCliRun.mockImplementation(async ({ onComplete }) => {
      onComplete({ success: true });
    });
    await runStagedLLM('s', {});
    expect(runner.executeCliRun.mock.calls[0][0].timeout).toBe(5000);
  });

  it('coerces a legacy digit-only stringified stage.timeout to a number', async () => {
    prompts.getStage.mockReturnValue({ timeout: '900000' });
    providers.getActiveProvider.mockResolvedValue(cliProvider({ timeout: 5000 }));
    runner.executeCliRun.mockImplementation(async ({ onComplete }) => {
      onComplete({ success: true });
    });
    await runStagedLLM('s', {});
    expect(runner.executeCliRun.mock.calls[0][0].timeout).toBe(900000);
  });

  it('rejects exponent/hex/float string forms (matches parseTimeoutMs)', async () => {
    // Number('1e3') === 1000 would silently sneak past a bare Number()
    // coercion. The digit-only gate keeps the runner in lockstep with
    // the route validator and client parser.
    prompts.getStage.mockReturnValue({ timeout: '1e3' });
    providers.getActiveProvider.mockResolvedValue(cliProvider({ timeout: 5000 }));
    runner.executeCliRun.mockImplementation(async ({ onComplete }) => {
      onComplete({ success: true });
    });
    await runStagedLLM('s', {});
    expect(runner.executeCliRun.mock.calls[0][0].timeout).toBe(5000);
  });

  it('rejects zero/negative stage.timeout instead of cancelling instantly', async () => {
    prompts.getStage.mockReturnValue({ timeout: 0 });
    providers.getActiveProvider.mockResolvedValue(cliProvider({ timeout: 5000 }));
    runner.executeCliRun.mockImplementation(async ({ onComplete }) => {
      onComplete({ success: true });
    });
    await runStagedLLM('s', {});
    expect(runner.executeCliRun.mock.calls[0][0].timeout).toBe(5000);
  });

  it('honors timeoutOverride beating both stage.timeout and provider.timeout', async () => {
    prompts.getStage.mockReturnValue({ timeout: 900000 });
    providers.getActiveProvider.mockResolvedValue(cliProvider({ timeout: 5000 }));
    runner.executeCliRun.mockImplementation(async ({ onComplete }) => {
      onComplete({ success: true });
    });
    await runStagedLLM('s', {}, { timeoutOverride: 1234 });
    expect(runner.executeCliRun.mock.calls[0][0].timeout).toBe(1234);
  });

  it('rejects a non-integer stage.timeout (no silent truncation)', async () => {
    // 1000.9 must NOT round to 1000 — both parseTimeoutMs on the client
    // and z.number().int() on the server reject non-integers, so the
    // runner mirrors that. Falls back to provider default.
    prompts.getStage.mockReturnValue({ timeout: 1000.9 });
    providers.getActiveProvider.mockResolvedValue(cliProvider({ timeout: 5000 }));
    runner.executeCliRun.mockImplementation(async ({ onComplete }) => {
      onComplete({ success: true });
    });
    await runStagedLLM('s', {});
    expect(runner.executeCliRun.mock.calls[0][0].timeout).toBe(5000);
  });

  it('rejects a non-positive timeoutOverride instead of running unbounded', async () => {
    // The runner treats `0` as "no timeout" — a caller bug must not silently
    // turn into an unbounded run. Drop to stage.timeout (or provider.timeout
    // when neither is set).
    prompts.getStage.mockReturnValue(null);
    providers.getActiveProvider.mockResolvedValue(cliProvider({ timeout: 5000 }));
    runner.executeCliRun.mockImplementation(async ({ onComplete }) => {
      onComplete({ success: true });
    });
    await runStagedLLM('s', {}, { timeoutOverride: 0 });
    expect(runner.executeCliRun.mock.calls[0][0].timeout).toBe(5000);
  });

  it('rejects a too-large timeoutOverride (above 30-min cap) and falls back', async () => {
    // Matches the route validator's max: anything > 1_800_000 is invalid,
    // not silently clamped. Falls through to provider.timeout.
    prompts.getStage.mockReturnValue(null);
    providers.getActiveProvider.mockResolvedValue(cliProvider({ timeout: 5000 }));
    runner.executeCliRun.mockImplementation(async ({ onComplete }) => {
      onComplete({ success: true });
    });
    await runStagedLLM('s', {}, { timeoutOverride: 9_999_999_999 });
    expect(runner.executeCliRun.mock.calls[0][0].timeout).toBe(5000);
  });

  it('rejects a timeoutOverride below the 1s floor', async () => {
    // Internal callers (extractors / pipeline stages) bypass the route
    // validator, so the runner enforces the same min as the schema. A `1`
    // override would otherwise become a near-instant cancel.
    prompts.getStage.mockReturnValue(null);
    providers.getActiveProvider.mockResolvedValue(cliProvider({ timeout: 5000 }));
    runner.executeCliRun.mockImplementation(async ({ onComplete }) => {
      onComplete({ success: true });
    });
    await runStagedLLM('s', {}, { timeoutOverride: 999 });
    expect(runner.executeCliRun.mock.calls[0][0].timeout).toBe(5000);
  });

  it('passes effectiveTimeout into createRun so /runs metadata matches execution', async () => {
    prompts.getStage.mockReturnValue({ timeout: 900000 });
    providers.getActiveProvider.mockResolvedValue(cliProvider({ timeout: 5000 }));
    runner.executeCliRun.mockImplementation(async ({ onComplete }) => {
      onComplete({ success: true });
    });
    await runStagedLLM('s', {});
    expect(runner.createRun).toHaveBeenCalledWith(expect.objectContaining({ timeout: 900000 }));
  });

  it('falls back to provider.timeout in createRun call when no override is set', async () => {
    prompts.getStage.mockReturnValue(null);
    providers.getActiveProvider.mockResolvedValue(cliProvider({ timeout: 5000 }));
    runner.executeCliRun.mockImplementation(async ({ onComplete }) => {
      onComplete({ success: true });
    });
    await runStagedLLM('s', {});
    // /runs metadata must record what executeXxxRun actually enforces,
    // not `undefined`. The runner's per-call timeout always resolves to
    // provider.timeout when there's no stage/caller override; the run
    // record needs to mirror that.
    expect(runner.createRun).toHaveBeenCalledWith(expect.objectContaining({ timeout: 5000 }));
  });

  it('reconciles to a fallback provider when createRun returns a different provider', async () => {
    prompts.getStage.mockReturnValue(null);
    const original = cliProvider({ id: 'unavailable', timeout: 5000 });
    const fallback = cliProvider({ id: 'fallback-cli', defaultModel: 'fallback-model', timeout: 7000 });
    providers.getActiveProvider.mockResolvedValue(original);
    runner.createRun.mockResolvedValueOnce({ runId: 'run-abc12345', provider: fallback });
    runner.executeCliRun.mockImplementation(async ({ provider: providerArg, onComplete }) => {
      // Critical: execution must run against the fallback (the one createRun
      // returned), NOT the original requested provider.
      expect(providerArg.id).toBe('fallback-cli');
      onComplete({ success: true });
    });
    const out = await runStagedLLM('s', {});
    expect(out.providerId).toBe('fallback-cli');
    // /runs attribution must be patched too so the record matches execution.
    expect(runner.patchRunMetadata).toHaveBeenCalledWith(
      'run-abc12345',
      expect.objectContaining({ providerId: 'fallback-cli' })
    );
  });
});

describe('withLocalConcurrencyGate', () => {
  // Build a fn that records peak concurrency while it runs.
  const makeTracker = () => {
    const state = { active: 0, peak: 0 };
    const fn = () => {
      state.active += 1;
      state.peak = Math.max(state.peak, state.active);
      return new Promise((resolve) => setTimeout(() => { state.active -= 1; resolve('ok'); }, 5));
    };
    return { state, fn };
  };

  it('serializes concurrent calls to a LOCAL api endpoint (peak ≤ limit)', async () => {
    const provider = { type: 'api', endpoint: 'http://localhost:11434' };
    const { state, fn } = makeTracker();
    await Promise.all(Array.from({ length: 6 }, () => withLocalConcurrencyGate(provider, fn)));
    expect(state.peak).toBeLessThanOrEqual(LOCAL_LLM_MAX_CONCURRENCY);
    expect(LOCAL_LLM_MAX_CONCURRENCY).toBe(1); // default — serialized
  });

  it('does NOT gate a remote api endpoint (runs concurrently)', async () => {
    const provider = { type: 'api', endpoint: 'https://api.openai.com' };
    const { state, fn } = makeTracker();
    await Promise.all(Array.from({ length: 4 }, () => withLocalConcurrencyGate(provider, fn)));
    expect(state.peak).toBeGreaterThan(1); // ungated
  });

  it('does NOT gate CLI/TUI providers (no endpoint)', async () => {
    const provider = { type: 'cli', id: 'codex' };
    const { state, fn } = makeTracker();
    await Promise.all(Array.from({ length: 4 }, () => withLocalConcurrencyGate(provider, fn)));
    expect(state.peak).toBeGreaterThan(1);
  });

  it('releases the slot even when the gated fn throws (no deadlock)', async () => {
    const provider = { type: 'api', endpoint: 'http://127.0.0.1:1234' };
    await expect(withLocalConcurrencyGate(provider, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    // A subsequent call still acquires the freed slot and resolves.
    await expect(withLocalConcurrencyGate(provider, () => Promise.resolve('after'))).resolves.toBe('after');
  });
});

describe('stageRunner — resolveJudgeForStage (writer/judge split, #2167)', () => {
  it('resolves the stage judge pin to the pinned provider + model', async () => {
    const judge = { id: 'judge-cli', name: 'Judge', type: 'cli', enabled: true, defaultModel: 'jm-default', heavyModel: 'jm-heavy' };
    providers.getProviderById.mockResolvedValue(judge);
    const out = await resolveJudgeForStage({ provider: 'writer', model: 'default', judgeProvider: 'judge-cli', judgeModel: 'heavy' });
    expect(out.provider.id).toBe('judge-cli');
    expect(out.model).toBe('jm-heavy'); // tier mapped against the judge provider
  });

  it('throws STAGE_JUDGE_PROVIDER_UNAVAILABLE when the pinned judge is disabled/missing', async () => {
    providers.getProviderById.mockResolvedValue({ id: 'judge-cli', enabled: false });
    await expect(resolveJudgeForStage({ judgeProvider: 'judge-cli' }))
      .rejects.toMatchObject({ code: 'STAGE_JUDGE_PROVIDER_UNAVAILABLE' });
  });

  it('an explicit providerOverride beats the stage judge pin', async () => {
    const override = { id: 'override-cli', name: 'Override', type: 'cli', enabled: true, defaultModel: 'om' };
    providers.getProviderById.mockImplementation(async (id) => (id === 'override-cli' ? override : { id, enabled: true, type: 'cli', defaultModel: 'x' }));
    const out = await resolveJudgeForStage({ judgeProvider: 'judge-cli' }, { providerOverride: 'override-cli' });
    expect(out.provider.id).toBe('override-cli');
  });

  it('with no judge pin, falls back to the writer stage provider/model', async () => {
    const active = apiProvider({ id: 'writer-api', defaultModel: 'wm-default' });
    providers.getActiveProvider.mockResolvedValue(active);
    providers.getProviderById.mockResolvedValue(null);
    const out = await resolveJudgeForStage({ model: 'default' }); // no provider pin → active
    expect(out.provider.id).toBe('writer-api');
    expect(out.model).toBe('wm-default');
  });
});
