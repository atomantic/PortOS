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
  hasModelFlag: vi.fn(() => false),
  patchRunMetadata: vi.fn(async () => undefined),
}));

const providers = await import('../services/providers.js');
const prompts = await import('../services/promptService.js');
const runner = await import('../services/runner.js');
const { runStagedLLM, resolveModel, extractJson } = await import('./stageRunner.js');

const apiProvider = (extra = {}) => ({
  id: 'mock-api', name: 'Mock', type: 'api', enabled: true, defaultModel: 'm-default', ...extra,
});
const cliProvider = (extra = {}) => ({
  id: 'codex', name: 'Codex', type: 'cli', enabled: true, defaultModel: 'm-default', timeout: 5000, ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
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
    runner.executeApiRun.mockImplementation(async (_id, _p, _m, _pr, _cwd, _shots, onData, onComplete) => {
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
    runner.executeApiRun.mockImplementation(async (_id, _p, _m, _pr, _cwd, _shots, onData, onComplete) => {
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
    runner.executeApiRun.mockImplementation(async (_id, _p, _m, _pr, _cwd, _shots, onData, onComplete) => {
      onData('pinned');
      onComplete({ success: true });
    });
    const out = await runStagedLLM('s', {});
    expect(out.providerId).toBe('stage-pinned');
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

describe('stageRunner — runStagedLLM dispatch', () => {
  it('routes CLI providers through executeCliRun', async () => {
    prompts.getStage.mockReturnValue(null);
    providers.getActiveProvider.mockResolvedValue(cliProvider());
    runner.executeCliRun.mockImplementation(async (_id, _p, _pr, _cwd, onData, onComplete, _t) => {
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
    runner.executeApiRun.mockImplementation(async (_id, _p, _m, _pr, _cwd, _shots, _onData, onComplete) => {
      onComplete({ error: 'simulated 500' });
    });
    await expect(runStagedLLM('s', {})).rejects.toThrow(/simulated 500/);
  });

  it('rejects when executeCliRun reports success: false', async () => {
    prompts.getStage.mockReturnValue(null);
    providers.getActiveProvider.mockResolvedValue(cliProvider());
    runner.executeCliRun.mockImplementation(async (_id, _p, _pr, _cwd, _onData, onComplete, _t) => {
      onComplete({ success: false, error: 'cli failed' });
    });
    await expect(runStagedLLM('s', {})).rejects.toThrow(/cli failed/);
  });

  it('parses JSON when returnsJson is true', async () => {
    prompts.getStage.mockReturnValue(null);
    providers.getActiveProvider.mockResolvedValue(apiProvider());
    runner.executeApiRun.mockImplementation(async (_id, _p, _m, _pr, _cwd, _shots, onData, onComplete) => {
      onData('```json\n{"x":1}\n```');
      onComplete({ success: true });
    });
    const out = await runStagedLLM('s', {}, { returnsJson: true });
    expect(out.content).toEqual({ x: 1 });
  });

  it('forwards source to createRun for transcript filtering', async () => {
    prompts.getStage.mockReturnValue(null);
    providers.getActiveProvider.mockResolvedValue(apiProvider());
    runner.executeApiRun.mockImplementation(async (_id, _p, _m, _pr, _cwd, _shots, onData, onComplete) => {
      onData('out');
      onComplete({ success: true });
    });
    await runStagedLLM('s', {}, { source: 'pipeline-text-stage' });
    expect(runner.createRun).toHaveBeenCalledWith(expect.objectContaining({ source: 'pipeline-text-stage' }));
  });

  it('passes stage.timeout to executeCliRun when set', async () => {
    prompts.getStage.mockReturnValue({ timeout: 900000 });
    providers.getActiveProvider.mockResolvedValue(cliProvider({ timeout: 5000 }));
    runner.executeCliRun.mockImplementation(async (_id, _p, _pr, _cwd, _onData, onComplete, _t) => {
      onComplete({ success: true });
    });
    await runStagedLLM('s', {});
    // executeCliRun(runId, provider, prompt, cwd, onData, onComplete, timeout)
    expect(runner.executeCliRun.mock.calls[0][6]).toBe(900000);
  });

  it('falls back to provider.timeout when stage.timeout is missing', async () => {
    prompts.getStage.mockReturnValue(null);
    providers.getActiveProvider.mockResolvedValue(cliProvider({ timeout: 5000 }));
    runner.executeCliRun.mockImplementation(async (_id, _p, _pr, _cwd, _onData, onComplete, _t) => {
      onComplete({ success: true });
    });
    await runStagedLLM('s', {});
    expect(runner.executeCliRun.mock.calls[0][6]).toBe(5000);
  });

  it('coerces a legacy digit-only stringified stage.timeout to a number', async () => {
    prompts.getStage.mockReturnValue({ timeout: '900000' });
    providers.getActiveProvider.mockResolvedValue(cliProvider({ timeout: 5000 }));
    runner.executeCliRun.mockImplementation(async (_id, _p, _pr, _cwd, _onData, onComplete, _t) => {
      onComplete({ success: true });
    });
    await runStagedLLM('s', {});
    expect(runner.executeCliRun.mock.calls[0][6]).toBe(900000);
  });

  it('rejects exponent/hex/float string forms (matches parseTimeoutMs)', async () => {
    // Number('1e3') === 1000 would silently sneak past a bare Number()
    // coercion. The digit-only gate keeps the runner in lockstep with
    // the route validator and client parser.
    prompts.getStage.mockReturnValue({ timeout: '1e3' });
    providers.getActiveProvider.mockResolvedValue(cliProvider({ timeout: 5000 }));
    runner.executeCliRun.mockImplementation(async (_id, _p, _pr, _cwd, _onData, onComplete, _t) => {
      onComplete({ success: true });
    });
    await runStagedLLM('s', {});
    expect(runner.executeCliRun.mock.calls[0][6]).toBe(5000);
  });

  it('rejects zero/negative stage.timeout instead of cancelling instantly', async () => {
    prompts.getStage.mockReturnValue({ timeout: 0 });
    providers.getActiveProvider.mockResolvedValue(cliProvider({ timeout: 5000 }));
    runner.executeCliRun.mockImplementation(async (_id, _p, _pr, _cwd, _onData, onComplete, _t) => {
      onComplete({ success: true });
    });
    await runStagedLLM('s', {});
    expect(runner.executeCliRun.mock.calls[0][6]).toBe(5000);
  });

  it('honors timeoutOverride beating both stage.timeout and provider.timeout', async () => {
    prompts.getStage.mockReturnValue({ timeout: 900000 });
    providers.getActiveProvider.mockResolvedValue(cliProvider({ timeout: 5000 }));
    runner.executeCliRun.mockImplementation(async (_id, _p, _pr, _cwd, _onData, onComplete, _t) => {
      onComplete({ success: true });
    });
    await runStagedLLM('s', {}, { timeoutOverride: 1234 });
    expect(runner.executeCliRun.mock.calls[0][6]).toBe(1234);
  });

  it('rejects a non-integer stage.timeout (no silent truncation)', async () => {
    // 1000.9 must NOT round to 1000 — both parseTimeoutMs on the client
    // and z.number().int() on the server reject non-integers, so the
    // runner mirrors that. Falls back to provider default.
    prompts.getStage.mockReturnValue({ timeout: 1000.9 });
    providers.getActiveProvider.mockResolvedValue(cliProvider({ timeout: 5000 }));
    runner.executeCliRun.mockImplementation(async (_id, _p, _pr, _cwd, _onData, onComplete, _t) => {
      onComplete({ success: true });
    });
    await runStagedLLM('s', {});
    expect(runner.executeCliRun.mock.calls[0][6]).toBe(5000);
  });

  it('rejects a non-positive timeoutOverride instead of running unbounded', async () => {
    // The runner treats `0` as "no timeout" — a caller bug must not silently
    // turn into an unbounded run. Drop to stage.timeout (or provider.timeout
    // when neither is set).
    prompts.getStage.mockReturnValue(null);
    providers.getActiveProvider.mockResolvedValue(cliProvider({ timeout: 5000 }));
    runner.executeCliRun.mockImplementation(async (_id, _p, _pr, _cwd, _onData, onComplete, _t) => {
      onComplete({ success: true });
    });
    await runStagedLLM('s', {}, { timeoutOverride: 0 });
    expect(runner.executeCliRun.mock.calls[0][6]).toBe(5000);
  });

  it('rejects a too-large timeoutOverride (above 30-min cap) and falls back', async () => {
    // Matches the route validator's max: anything > 1_800_000 is invalid,
    // not silently clamped. Falls through to provider.timeout.
    prompts.getStage.mockReturnValue(null);
    providers.getActiveProvider.mockResolvedValue(cliProvider({ timeout: 5000 }));
    runner.executeCliRun.mockImplementation(async (_id, _p, _pr, _cwd, _onData, onComplete, _t) => {
      onComplete({ success: true });
    });
    await runStagedLLM('s', {}, { timeoutOverride: 9_999_999_999 });
    expect(runner.executeCliRun.mock.calls[0][6]).toBe(5000);
  });

  it('rejects a timeoutOverride below the 1s floor', async () => {
    // Internal callers (extractors / pipeline stages) bypass the route
    // validator, so the runner enforces the same min as the schema. A `1`
    // override would otherwise become a near-instant cancel.
    prompts.getStage.mockReturnValue(null);
    providers.getActiveProvider.mockResolvedValue(cliProvider({ timeout: 5000 }));
    runner.executeCliRun.mockImplementation(async (_id, _p, _pr, _cwd, _onData, onComplete, _t) => {
      onComplete({ success: true });
    });
    await runStagedLLM('s', {}, { timeoutOverride: 999 });
    expect(runner.executeCliRun.mock.calls[0][6]).toBe(5000);
  });

  it('passes effectiveTimeout into createRun so /runs metadata matches execution', async () => {
    prompts.getStage.mockReturnValue({ timeout: 900000 });
    providers.getActiveProvider.mockResolvedValue(cliProvider({ timeout: 5000 }));
    runner.executeCliRun.mockImplementation(async (_id, _p, _pr, _cwd, _onData, onComplete, _t) => {
      onComplete({ success: true });
    });
    await runStagedLLM('s', {});
    expect(runner.createRun).toHaveBeenCalledWith(expect.objectContaining({ timeout: 900000 }));
  });

  it('falls back to provider.timeout in createRun call when no override is set', async () => {
    prompts.getStage.mockReturnValue(null);
    providers.getActiveProvider.mockResolvedValue(cliProvider({ timeout: 5000 }));
    runner.executeCliRun.mockImplementation(async (_id, _p, _pr, _cwd, _onData, onComplete, _t) => {
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
    runner.executeCliRun.mockImplementation(async (_id, providerArg, _pr, _cwd, _onData, onComplete, _t) => {
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
