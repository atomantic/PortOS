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
});
