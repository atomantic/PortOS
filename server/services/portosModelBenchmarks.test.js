import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('./aiProvider.js', () => ({ callProviderAISimple: vi.fn() }));
vi.mock('./modelComparison.js', () => ({ recordPortosModelBenchmark: vi.fn().mockResolvedValue(undefined) }));

import { callProviderAISimple } from './aiProvider.js';
import { recordPortosModelBenchmark } from './modelComparison.js';
import { runPortosModelBenchmark } from './portosModelBenchmarks.js';

const codexProvider = {
  id: 'codex',
  name: 'Codex CLI',
  type: 'cli',
  command: 'codex',
  textTransport: 'codex-app-server',
  textTransportEnabled: true,
  textTransportReadRiskAcknowledged: true,
  enabled: true,
  effort: 'ultra',
};

const answer = (text, extra = {}) => ({ text, usage: { inputTokens: 20, outputTokens: 2 }, ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  recordPortosModelBenchmark.mockResolvedValue(undefined);
});

it('stores the effective Codex effort and scores all five explicit tasks', async () => {
  const answers = ['175', 'PORTOS-USAGE', '2,3', '105.75', '1,4'];
  callProviderAISimple.mockImplementation(async () => answer(answers.shift(), { effort: 'max', model: 'gpt-6-sol' }));

  const result = await runPortosModelBenchmark({ provider: codexProvider, model: 'gpt-6-sol' });

  expect(result.complete).toBe(true);
  expect(result.observation).toMatchObject({
    provider: 'Codex CLI',
    model: 'gpt-6-sol',
    effort: 'max',
    billing: 'subscription',
    benchmark: 'PortOS Task Bench v1 (deterministic)',
    quality: { value: 100 },
    tokensPerRun: { value: 110 },
    tokenBasis: 'measured',
    completedTasks: 5,
    totalTasks: 5,
  });
  expect(callProviderAISimple).toHaveBeenCalledTimes(5);
  expect(recordPortosModelBenchmark).toHaveBeenCalledWith(result.observation);
  expect(JSON.stringify(result.observation)).not.toContain('PORTOS-USAGE');
});

it('keeps a safe partial record and identifies the provider status when a later task fails', async () => {
  callProviderAISimple
    .mockResolvedValueOnce(answer('175'))
    .mockResolvedValueOnce(answer('PORTOS-USAGE'))
    .mockResolvedValueOnce({ error: 'Provider returned 429: private response body', status: 429 });

  const result = await runPortosModelBenchmark({ provider: { id: 'openai', name: 'OpenAI', type: 'api' }, model: 'example-model' });

  expect(result.complete).toBe(false);
  expect(result.failureReason).toBe('Provider returned HTTP 429');
  expect(result.observation).toMatchObject({
    quality: null,
    completedTasks: 2,
    totalTasks: 5,
    notes: expect.stringContaining('Provider returned HTTP 429'),
  });
  expect(result.observation.notes).not.toContain('private response body');
  expect(recordPortosModelBenchmark).toHaveBeenCalledWith(result.observation);
});

it('returns an actionable gateway error when the first task cannot be completed', async () => {
  callProviderAISimple.mockResolvedValue({ error: 'Provider returned 401: response body', status: 401 });

  await expect(runPortosModelBenchmark({ provider: { id: 'openai', type: 'api' }, model: 'example-model' }))
    .rejects.toMatchObject({ status: 502, message: expect.stringContaining('Provider returned HTTP 401') });
  expect(recordPortosModelBenchmark).not.toHaveBeenCalled();
});
