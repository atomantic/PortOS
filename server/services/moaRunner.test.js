import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ preset: null, providers: {}, patches: [] }));
vi.mock('./moaPresets.js', () => ({ getMoaPreset: vi.fn(async () => state.preset) }));
vi.mock('./provider/providers.js', () => ({ getProviderById: vi.fn(async (id) => state.providers[id] ?? null) }));
vi.mock('./runner.js', () => ({ patchRunMetadata: vi.fn(async (runId, patch) => { state.patches.push({ runId, ...patch }); }) }));

const { runMoaPreset } = await import('./moaRunner.js');

const apiProvider = (id) => ({ id, name: `Name ${id}`, type: 'api', enabled: true, defaultModel: `${id}-model` });
const moaRecord = { id: 'moa:council', type: 'moa', moaPresetId: 'council' };
const canceled = (runId) => Object.assign(new Error('Run canceled'), { code: 'RUN_CANCELED', runId });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  state.providers = { a: apiProvider('a'), b: apiProvider('b'), c: apiProvider('c'), agg: apiProvider('agg') };
  state.preset = {
    id: 'council', name: 'Council', enabled: true, privacyFilter: 'off', advisorMaxTokens: 512,
    referenceModels: [{ providerId: 'a', temperature: 0.2 }, { providerId: 'b' }],
    aggregator: { providerId: 'agg', model: 'agg-big' },
  };
  state.patches = [];
});

describe('runMoaPreset', () => {
  it('dispatches every advisor before any settles, tool-free and bounded, then the aggregator on the tail-assembled prompt', async () => {
    const pending = {};
    const calls = [];
    const runPrompt = vi.fn((args) => {
      calls.push(args);
      if (args.provider.id === 'agg') return Promise.resolve({ text: 'final', runId: 'run-agg', model: 'agg-big', provider: args.provider });
      pending[args.provider.id] = deferred();
      return pending[args.provider.id].promise;
    });
    const running = runMoaPreset({ provider: moaRecord, prompt: 'PROMPT', source: 'ask', completion: { temperature: 0.4 } }, { runPrompt });
    await vi.waitFor(() => expect(Object.keys(pending).sort()).toEqual(['a', 'b']));
    const advisorCalls = calls.filter((c) => c.provider.id !== 'agg');
    expect(advisorCalls.every((c) => c.completion && c.prompt.startsWith('PROMPT') && c.signal instanceof AbortSignal)).toBe(true);
    expect(advisorCalls[0].completion).toEqual({ maxTokens: 512, temperature: 0.2 });
    expect(advisorCalls[1].completion).toEqual({ maxTokens: 512 });
    pending.a.resolve({ text: 'alpha view', runId: 'run-a' });
    pending.b.resolve({ text: 'beta view', runId: 'run-b' });

    const result = await running;
    const aggregatorCall = calls.find((c) => c.provider.id === 'agg');
    expect(aggregatorCall).toMatchObject({ model: 'agg-big', completion: { temperature: 0.4 } });
    expect(aggregatorCall.prompt.startsWith('PROMPT')).toBe(true);
    expect(aggregatorCall.prompt).toMatch(/alpha view[\s\S]*beta view/);
    expect(result).toMatchObject({ text: 'final', runId: 'run-agg', moa: { presetId: 'council', aggregatorRunId: 'run-agg' } });
    expect(state.patches).toEqual(expect.arrayContaining([
      { runId: 'run-a', moa: expect.objectContaining({ role: 'reference', parentRunId: 'run-agg', presetId: 'council' }) },
      { runId: 'run-b', moa: expect.objectContaining({ role: 'reference', parentRunId: 'run-agg' }) },
      { runId: 'run-agg', moa: expect.objectContaining({ role: 'aggregator', references: [expect.objectContaining({ runId: 'run-a', ok: true }), expect.objectContaining({ runId: 'run-b', ok: true })] }) },
    ]));
  });

  it('tolerates a failed and an ineligible advisor, and fails only when the aggregator does', async () => {
    state.preset.referenceModels.push({ providerId: 'missing' });
    const runPrompt = vi.fn(async (args) => {
      if (args.provider.id === 'a') throw Object.assign(new Error('upstream 500'), { runId: 'run-a' });
      if (args.provider.id === 'b') return { text: 'beta view', runId: 'run-b' };
      return { text: 'final', runId: 'run-agg' };
    });
    const result = await runMoaPreset({ provider: moaRecord, prompt: 'P', source: 'ask', completion: {} }, { runPrompt });
    expect(runPrompt).toHaveBeenCalledTimes(3);
    expect(result.moa.references.map((r) => [r.ok, r.error ?? null])).toEqual([[false, 'upstream 500'], [true, null], [false, 'provider "missing" was not found']]);
    expect(runPrompt.mock.calls.at(-1)[0].prompt).toContain('<moa-advisory responded="1" of="3">');

    runPrompt.mockImplementation(async (args) => {
      if (args.provider.id === 'agg') throw Object.assign(new Error('aggregator down'), { runId: 'run-agg2' });
      return { text: 'view', runId: `run-${args.provider.id}` };
    });
    await expect(runMoaPreset({ provider: moaRecord, prompt: 'P', source: 'ask', completion: {} }, { runPrompt })).rejects.toThrow('aggregator down');
    expect(state.patches.findLast((p) => p.runId === 'run-a')?.moa.parentRunId).toBe('run-agg2');
  });

  it('cancels every in-flight advisor and skips the aggregator when the caller aborts', async () => {
    const controller = new AbortController();
    const runPrompt = vi.fn((args) => new Promise((resolve, reject) => {
      args.signal.addEventListener('abort', () => reject(canceled(`run-${args.provider.id}`)));
    }));
    const running = runMoaPreset({ provider: moaRecord, prompt: 'P', source: 'ask', signal: controller.signal, completion: {} }, { runPrompt });
    await vi.waitFor(() => expect(runPrompt).toHaveBeenCalledTimes(2));
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: 'RUN_CANCELED' });
    expect(runPrompt).toHaveBeenCalledTimes(2);
  });

  it('treats a Stop on one advisor run as a Stop on the whole MoA run', async () => {
    const stops = {};
    const bAborted = vi.fn();
    const runPrompt = vi.fn((args) => new Promise((resolve, reject) => {
      // The Runs page's Stop rejects that one run; it never touches our signal.
      stops[args.provider.id] = () => reject(canceled(`run-${args.provider.id}`));
      args.signal.addEventListener('abort', () => { if (args.provider.id === 'b') bAborted(); reject(canceled(`run-${args.provider.id}`)); });
    }));
    const running = runMoaPreset({ provider: moaRecord, prompt: 'P', source: 'ask', completion: {} }, { runPrompt });
    await vi.waitFor(() => expect(Object.keys(stops)).toHaveLength(2));
    stops.a();
    await expect(running).rejects.toMatchObject({ code: 'RUN_CANCELED' });
    expect(bAborted).toHaveBeenCalledTimes(1);
    expect(runPrompt).toHaveBeenCalledTimes(2);
  });

  it('gates every dispatch on the caller admission check and stops the run when it refuses', async () => {
    const runPrompt = vi.fn(async (args) => ({ text: 'ok', runId: `run-${args.provider.id}` }));
    const beforeExecute = vi.fn(async () => {});
    await runMoaPreset({ provider: moaRecord, prompt: 'P', source: 'ask', beforeExecute }, { runPrompt });
    expect(beforeExecute.mock.calls.map(([meta]) => meta.provider.id)).toEqual(['a', 'b']);
    expect(runPrompt.mock.calls.at(-1)[0].beforeExecute).toBe(beforeExecute);

    runPrompt.mockClear();
    const refusing = vi.fn(async () => { throw new Error('over budget'); });
    await expect(runMoaPreset({ provider: moaRecord, prompt: 'P', source: 'ask', beforeExecute: refusing }, { runPrompt })).rejects.toThrow('over budget');
    expect(runPrompt).not.toHaveBeenCalled();

    await expect(runMoaPreset({ provider: moaRecord, prompt: 'P', source: 'ask', completion: {}, beforeExecute: refusing }, { runPrompt })).rejects.toThrow('over budget');
    await expect(runMoaPreset({ provider: moaRecord, prompt: 'P', source: 'ask', completion: {}, responseSchema: () => true }, { runPrompt })).rejects.toThrow(/does not support responseSchema/);
  });

  it('gives advisors a real deadline when the caller passes no stall bound', async () => {
    const runPrompt = vi.fn(async (args) => ({ text: 'ok', runId: `run-${args.provider.id}` }));
    await runMoaPreset({ provider: moaRecord, prompt: 'P', source: 'ask', timeout: 0 }, { runPrompt });
    const advisorTimeout = runPrompt.mock.calls[0][0].timeout;
    expect(advisorTimeout(state.providers.a)).toBeUndefined();
    expect(runPrompt.mock.calls.at(-1)[0].timeout).toBe(0);
    runPrompt.mockClear();
    await runMoaPreset({ provider: moaRecord, prompt: 'P', source: 'ask', timeout: 9000 }, { runPrompt });
    expect(runPrompt.mock.calls[0][0].timeout(state.providers.a)).toBe(9000);
  });

  it('runs the aggregator directly when the preset is disabled, streamed and pinned for a streaming caller', async () => {
    state.preset.enabled = false;
    const onData = vi.fn();
    const runPrompt = vi.fn(async () => ({ text: 'direct', runId: 'run-agg' }));
    const result = await runMoaPreset({ provider: moaRecord, prompt: 'P', source: 'ask', onData, responseSchema: null, model: 'ignored' }, { runPrompt });
    expect(runPrompt).toHaveBeenCalledTimes(1);
    expect(runPrompt.mock.calls[0][0]).toMatchObject({ provider: state.providers.agg, prompt: 'P', model: 'agg-big', onData, allowFallback: false });
    expect(runPrompt.mock.calls[0][0].completion).toBeUndefined();
    expect(result.text).toBe('direct');
  });

  it('refuses an aggregator that is another MoA preset, a CLI, or image input, before any run', async () => {
    const runPrompt = vi.fn();
    state.providers.agg = { id: 'agg', type: 'moa' };
    await expect(runMoaPreset({ provider: moaRecord, prompt: 'P', source: 'ask', completion: {} }, { runPrompt })).rejects.toMatchObject({ code: 'MOA_MEMBER_INVALID' });
    state.providers.agg = { id: 'agg', type: 'cli', enabled: true, defaultModel: 'x' };
    await expect(runMoaPreset({ provider: moaRecord, prompt: 'P', source: 'ask', completion: {} }, { runPrompt })).rejects.toThrow(/not an API provider/);
    await expect(runMoaPreset({ provider: moaRecord, prompt: 'P', source: 'ask', screenshots: ['x.png'] }, { runPrompt })).rejects.toMatchObject({ code: 'MOA_IMAGES_UNSUPPORTED' });
    expect(runPrompt).not.toHaveBeenCalled();
  });

  it('scrubs the advisor text it returns under the display filter but injects it raw', async () => {
    state.preset.privacyFilter = 'display';
    const runPrompt = vi.fn(async (args) => (args.provider.id === 'agg'
      ? { text: 'final', runId: 'run-agg' }
      : { text: 'mail someone@example.com', runId: `run-${args.provider.id}` }));
    const result = await runMoaPreset({ provider: moaRecord, prompt: 'P', source: 'ask', completion: {} }, { runPrompt });
    expect(result.moa.references[0].text).toBe('mail <email>');
    expect(runPrompt.mock.calls.at(-1)[0].prompt).toContain('someone@example.com');
  });
});
