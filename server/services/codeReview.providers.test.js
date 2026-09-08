import { describe, it, expect, vi, beforeEach } from 'vitest';
import { access } from 'node:fs/promises';
import { codeReviewSettingsSchema, sanitizeTaskMetadata } from '../lib/cosValidation.js';
import { resolveReviewerConfig, buildReviewWithArgs } from '../lib/reviewerConfig.js';
import { buildLocalReviewerInstructions } from './cosTaskPrompts.js';

vi.mock('./settings.js', () => ({ getSettings: vi.fn(), settingsEvents: { on: vi.fn() } }));
vi.mock('./providers.js', () => ({ getProviderById: vi.fn() }));
vi.mock('../lib/aiToolkitState.js', () => ({ getAIToolkitInstance: () => ({}) }));
vi.mock('./aiProvider.js', () => ({ callProviderAISimple: vi.fn() }));
vi.mock('../lib/cliProviderRun.js', () => ({ runCliProviderPrompt: vi.fn() }));
vi.mock('./lmStudioManager.js', () => ({ getBaseUrl: vi.fn() }));
vi.mock('./ollamaManager.js', () => ({ getBaseUrl: vi.fn(), getModelCapabilities: vi.fn() }));

const { getProviderById } = await import('./providers.js');
const { callProviderAISimple } = await import('./aiProvider.js');
const { runCliProviderPrompt } = await import('../lib/cliProviderRun.js');
const { pickCodeReviewDefaults, runLocalCodeReview } = await import('./codeReview.js');

const backend = 'provider:example-gpu';
const provider = { id: 'example-gpu', name: 'Example GPU', type: 'api', enabled: true,
  endpoint: 'https://gpu.example.com/v1', apiKey: 'example-key', defaultModel: 'default-coder',
  fallbackProvider: 'other-provider', models: ['default-coder', 'pinned-coder'] };

beforeEach(() => {
  vi.clearAllMocks();
  getProviderById.mockResolvedValue(provider);
  callProviderAISimple.mockResolvedValue({ text: 'NO FINDINGS' });
});

describe('configured provider reviewers', () => {
  it('keeps a saved provider/model through settings, task metadata, prompt generation and execution', async () => {
    const settings = codeReviewSettingsSchema.parse({ reviewers: ['codex', backend],
      providerModels: { [backend]: 'pinned-coder' }, codexModel: 'example-cloud-model',
      optionalReviewers: [backend], reviewerMaxRounds: { [backend]: 1 } });
    const defaults = pickCodeReviewDefaults({ codeReview: settings });
    const config = resolveReviewerConfig({}, defaults, defaults.reviewers);
    const task = sanitizeTaskMetadata(config);
    expect(task.reviewers).toEqual([backend, 'codex']);
    expect(task.reviewerModels).toEqual({ [backend]: 'pinned-coder', codex: 'example-cloud-model' });
    expect(task.optionalReviewers).toEqual([backend]);
    expect(task.reviewerMaxRounds).toEqual({ [backend]: 1 });
    const instructions = buildLocalReviewerInstructions(task.reviewers, task.reviewerModels);
    expect(instructions).toContain(backend);
    expect(instructions).toContain('pinned-coder');
    expect(buildReviewWithArgs(task.reviewers)).not.toContain(backend);
    const result = await runLocalCodeReview({ backend, model: task.reviewerModels[backend], diff: 'diff --git a/example.js b/example.js' });
    expect(result).toMatchObject({ ok: true, backend, model: 'pinned-coder', findings: 'NO FINDINGS' });
    expect(getProviderById).toHaveBeenCalledWith('example-gpu');
    expect(callProviderAISimple).toHaveBeenCalledWith(
      expect.objectContaining({ id: provider.id, endpoint: provider.endpoint, apiKey: provider.apiKey, fallbackProvider: null }),
      'pinned-coder', expect.stringContaining('untrusted contributor-controlled data'),
      expect.objectContaining({ allowModelRecovery: false }),
    );
    expect(runCliProviderPrompt).not.toHaveBeenCalled();
    expect(resolveReviewerConfig({ reviewerModels: {} }, defaults, defaults.reviewers).reviewerModels).toEqual({});
  });

  it('uses only this provider default when unpinned and returns provider failure without substitution', async () => {
    callProviderAISimple.mockResolvedValue({ error: 'Selected model is unavailable' });
    expect(await runLocalCodeReview({ backend, diff: 'example diff' })).toMatchObject({ ok: false, error: 'Selected model is unavailable' });
    expect(callProviderAISimple).toHaveBeenCalledTimes(1);
    expect(callProviderAISimple.mock.calls[0][1]).toBe('default-coder');
  });

  it.each([null, { ...provider, enabled: false }])('refuses a missing or disabled provider before inference', async record => {
    getProviderById.mockResolvedValue(record);
    expect(await runLocalCodeReview({ backend, diff: 'example diff' })).toMatchObject({ ok: false });
    expect(callProviderAISimple).not.toHaveBeenCalled();
    expect(runCliProviderPrompt).not.toHaveBeenCalled();
  });

  it('uses the maintained no-tool CLI recipe in disposable scratch and accepts only a final result', async () => {
    const cli = { ...provider, type: 'tui', command: 'claude' };
    getProviderById.mockResolvedValue(cli);
    runCliProviderPrompt.mockResolvedValue({ text: '{"type":"result","result":"NO FINDINGS"}', partial: false, streamFormat: 'stream-json' });
    const result = await runLocalCodeReview({ backend, model: 'pinned-coder', diff: 'example diff' });
    expect(result).toMatchObject({ ok: true, findings: 'NO FINDINGS' });
    const args = runCliProviderPrompt.mock.calls[0][0];
    expect(args).toMatchObject({ provider: cli, model: 'pinned-coder', safetyProfile: 'public-review-gate' });
    await expect(access(args.cwd)).rejects.toThrow();
    expect(callProviderAISimple).not.toHaveBeenCalled();

    runCliProviderPrompt.mockResolvedValue({ text: '{"type":"result","is_error":true,"result":"incomplete"}', partial: false, streamFormat: 'stream-json' });
    expect(await runLocalCodeReview({ backend, diff: 'example diff' })).toMatchObject({ ok: false });
    runCliProviderPrompt.mockResolvedValue({ text: 'NO FINDINGS', partial: true });
    expect(await runLocalCodeReview({ backend, diff: 'example diff' })).toMatchObject({ ok: false });
  });

  it('refuses an unsupported harness instead of spawning it with ordinary agent permissions', async () => {
    getProviderById.mockResolvedValue({ ...provider, type: 'cli', command: 'custom-agent' });
    expect(await runLocalCodeReview({ backend, diff: 'example diff' })).toMatchObject({ ok: false, error: expect.stringContaining('no enforced tool-free') });
    expect(runCliProviderPrompt).not.toHaveBeenCalled();
    expect(callProviderAISimple).not.toHaveBeenCalled();
  });
});
