import { describe, it, expect, vi, beforeEach } from 'vitest';
import { access } from 'node:fs/promises';
import { codeReviewSettingsSchema, sanitizeTaskMetadata } from '../lib/cosValidation.js';
import { resolveReviewerConfig, buildReviewWithArgs, isReviewerConfigFault } from '../lib/reviewerConfig.js';

vi.mock('./settings.js', () => ({ getSettings: vi.fn(), settingsEvents: { on: vi.fn() } }));
vi.mock('./providers.js', () => ({ getProviderById: vi.fn(), listProviders: vi.fn() }));
vi.mock('../lib/aiToolkitState.js', () => ({ getAIToolkitInstance: () => ({}) }));
vi.mock('./aiProvider.js', () => ({ callProviderAISimple: vi.fn() }));
vi.mock('../lib/cliProviderRun.js', () => ({ runCliProviderPrompt: vi.fn() }));
vi.mock('./lmStudioManager.js', () => ({ getBaseUrl: vi.fn() }));
vi.mock('./ollamaManager.js', () => ({ getBaseUrl: vi.fn(), getModelCapabilities: vi.fn() }));

const { getProviderById, listProviders } = await import('./providers.js');
const { callProviderAISimple } = await import('./aiProvider.js');
const { runCliProviderPrompt } = await import('../lib/cliProviderRun.js');
const { pickCodeReviewDefaults, runLocalCodeReview, getProviderReviewUnsupported, pickAvailableReviewerGroups, isReviewerQuotaFailure } = await import('./codeReview.js');

const backend = 'provider:example-gpu';
const provider = { id: 'example-gpu', name: 'Example GPU', type: 'api', enabled: true,
  endpoint: 'https://gpu.example.com/v1', apiKey: 'example-key', defaultModel: 'default-coder',
  fallbackProvider: 'other-provider', models: ['default-coder', 'pinned-coder'] };

beforeEach(() => {
  vi.clearAllMocks();
  getProviderById.mockResolvedValue(provider);
  listProviders.mockResolvedValue([provider]);
  callProviderAISimple.mockResolvedValue({ text: 'NO FINDINGS' });
});

describe('configured provider reviewers', () => {
  it('selects the first fallback group whose reviewers are not paused', () => {
    expect(pickAvailableReviewerGroups({ reviewerFallbackGroups: [['ollama'], ['codex']], reviewerHealth: { ollama: { pausedUntil: 200 } } }, 100)).toEqual(['codex']);
    expect(pickAvailableReviewerGroups({ reviewerFallbackGroups: [['ollama'], ['codex']], reviewerHealth: { ollama: { pausedUntil: 50 } } }, 100)).toEqual(['ollama']);
  });

  it('persists repeated tier memberships and explicit disable without adding task-local fallback schemas', () => {
    const raw = { reviewers: ['codex'], reviewerFallbackGroups: [[backend, 'codex'], [backend]], usernames: ['example-bot'] };
    const settings = codeReviewSettingsSchema.parse(raw);
    expect(pickCodeReviewDefaults({ codeReview: settings })).toMatchObject({
      reviewers: [backend, 'codex'], reviewerFallbackGroups: [[backend, 'codex'], [backend]], usernames: ['example-bot'],
    });
    const cleared = codeReviewSettingsSchema.parse({ ...raw, reviewerFallbackGroups: [] });
    expect(pickCodeReviewDefaults({ codeReview: cleared })).toMatchObject({ reviewers: [], reviewerFallbackGroups: [], usernames: ['example-bot'] });
    expect(codeReviewSettingsSchema.safeParse({ reviewerFallbackGroups: [[]] }).success).toBe(false);
    expect(sanitizeTaskMetadata({ reviewerFallbackGroups: [[backend]], reviewers: ['codex'] })).not.toHaveProperty('reviewerFallbackGroups');
  });

  it('recognizes quota and usage allowance failures without classifying ordinary review failures', () => {
    expect(isReviewerQuotaFailure('429 rate limit exceeded')).toBe(true);
    expect(isReviewerQuotaFailure('monthly usage allowance exhausted')).toBe(true);
    expect(isReviewerQuotaFailure('syntax findings returned')).toBe(false);
  });

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
    const { buildLocalReviewerInstructions } = await import('./cosTaskPrompts.js');
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
    expect(await runLocalCodeReview({ backend, diff: 'example diff' })).toMatchObject({ ok: false, code: 'REVIEWER_UNAVAILABLE' });
    expect(callProviderAISimple).not.toHaveBeenCalled();
    expect(runCliProviderPrompt).not.toHaveBeenCalled();
  });

  it('runs saved provider model/effort defaults through the CLI recipe and task overrides', async () => {
    const cli = { ...provider, type: 'tui', command: 'claude' };
    getProviderById.mockResolvedValue(cli);
    runCliProviderPrompt.mockResolvedValue({ text: '{"type":"result","result":"NO FINDINGS"}', partial: false, streamFormat: 'stream-json' });
    const settings = codeReviewSettingsSchema.parse({
      reviewers: [backend], providerModels: { [backend]: 'pinned-coder' }, providerEfforts: { [backend]: 'HIGH' },
      claudeEffort: 'medium',
    });
    const defaults = pickCodeReviewDefaults({ codeReview: settings });
    expect(defaults.providerEfforts).toEqual({ [backend]: 'high' });
    const task = sanitizeTaskMetadata(resolveReviewerConfig({}, defaults, defaults.reviewers));
    expect(task.reviewerEfforts).toEqual({ [backend]: 'high', claude: 'medium' });
    const result = await runLocalCodeReview({ backend, model: task.reviewerModels[backend], effort: task.reviewerEfforts[backend], diff: 'example diff', cwd: '/mock/caller/cwd' });
    expect(result).toMatchObject({ ok: true, findings: 'NO FINDINGS', effort: 'high' });
    const args = runCliProviderPrompt.mock.calls[0][0];
    expect(args).toMatchObject({ provider: { ...cli, effort: 'high' }, model: 'pinned-coder', cwd: '/mock/caller/cwd' });
    expect(args).not.toHaveProperty('safetyProfile');
    expect(callProviderAISimple).not.toHaveBeenCalled();

    const override = resolveReviewerConfig({ reviewerEfforts: { [backend]: 'low' } }, defaults, defaults.reviewers);
    await runLocalCodeReview({ backend, model: override.reviewerModels[backend], effort: override.reviewerEfforts[backend], diff: 'example diff' });
    expect(runCliProviderPrompt.mock.lastCall[0]).toMatchObject({ provider: { id: provider.id, effort: 'low' }, model: 'pinned-coder' });
    const cleared = resolveReviewerConfig({ reviewerModels: {}, reviewerEfforts: {} }, defaults, defaults.reviewers);
    expect(cleared).toMatchObject({ reviewerModels: {}, reviewerEfforts: {} });
    await runLocalCodeReview({ backend, model: cleared.reviewerModels[backend], effort: cleared.reviewerEfforts[backend], diff: 'example diff' });
    expect(runCliProviderPrompt.mock.lastCall[0]).toMatchObject({ provider: cli, model: 'default-coder' });
    expect(runCliProviderPrompt.mock.lastCall[0].provider).not.toHaveProperty('effort');

    runCliProviderPrompt.mockResolvedValue({ text: '{"type":"result","is_error":true,"result":"incomplete"}', partial: false, streamFormat: 'stream-json' });
    expect(await runLocalCodeReview({ backend, diff: 'example diff' })).toMatchObject({ ok: false });
    runCliProviderPrompt.mockResolvedValue({ text: 'NO FINDINGS', partial: true });
    expect(await runLocalCodeReview({ backend, diff: 'example diff' })).toMatchObject({ ok: false });
  });

  // #7720: a bootstrap-credentialed harness has a maintained no-tool recipe and
  // must be usable as a reviewer, not refused at selection time. The record
  // reaches the CLI spawn with its `credentialBootstrap` intact — that is what
  // `applyCredentialBootstrap` wraps under the gate's no-tool profile, so the
  // bootstrap mints the credential into the harness it execs. A record that
  // instead PRINTS assignments supplies them through `bootstrapEnv`, which the
  // wrap does not replace.
  it('runs a bootstrap reviewer on the wrap alone, and passes minted env when the record prints one', async () => {
    const cli = { ...provider, type: 'cli', command: 'claude', credentialBootstrap: { command: 'example-wrapper', args: ['run'] } };
    getProviderById.mockResolvedValue(cli);
    listProviders.mockResolvedValue([cli]);
    runCliProviderPrompt.mockResolvedValue({ text: 'NO FINDINGS', partial: false });
    expect(await getProviderReviewUnsupported()).toEqual({});
    expect(await runLocalCodeReview({ backend, diff: 'example diff' })).toMatchObject({ ok: true, findings: 'NO FINDINGS' });
    expect(runCliProviderPrompt).toHaveBeenCalledWith(expect.objectContaining({
      provider: expect.objectContaining({ credentialBootstrap: cli.credentialBootstrap }),
      bootstrapEnv: {},
      cwd: expect.any(String),
    }));

    cli.credentialBootstrap.envCommand = [process.execPath, '-e', 'console.log("ANTHROPIC_AUTH_TOKEN=example-minted-token")'];
    expect(await getProviderReviewUnsupported()).toEqual({});
    expect(await runLocalCodeReview({ backend, diff: 'example diff' })).toMatchObject({ ok: true, findings: 'NO FINDINGS' });
    expect(runCliProviderPrompt).toHaveBeenCalledWith(expect.objectContaining({
      bootstrapEnv: { ANTHROPIC_AUTH_TOKEN: 'example-minted-token' },
      cwd: expect.any(String),
    }));

    // A credential command that FAILS is still a failed review, not a silent
    // spawn with no credential.
    cli.credentialBootstrap.envCommand = [process.execPath, '-e', 'console.error("example-secret"); process.exit(1)'];
    runCliProviderPrompt.mockClear();
    expect(await runLocalCodeReview({ backend, diff: 'example diff' })).toMatchObject({
      ok: false, error: 'Reviewer credential setup or execution failed.',
    });
    expect(runCliProviderPrompt).not.toHaveBeenCalled();
  });

  it('refuses an unsupported effort before invoking the provider', async () => {
    getProviderById.mockResolvedValue({ ...provider, type: 'tui', command: 'codex', defaultModel: 'gpt-6-astra' });
    expect(await runLocalCodeReview({ backend, effort: 'minimal', diff: 'example diff' })).toMatchObject({ ok: false, error: expect.stringContaining('reasoning effort') });
    expect(callProviderAISimple).not.toHaveBeenCalled();
    expect(runCliProviderPrompt).not.toHaveBeenCalled();
  });

  it('allows custom configured harnesses for repository review in caller cwd, but refuses unsupported transport types', async () => {
    const customHarness = { ...provider, type: 'cli', command: 'custom-agent' };
    getProviderById.mockResolvedValue(customHarness);
    runCliProviderPrompt.mockResolvedValue({ text: 'NO FINDINGS', partial: false });
    const result = await runLocalCodeReview({ backend, diff: 'example diff', cwd: '/worktree/checkout' });
    expect(result).toMatchObject({ ok: true, findings: 'NO FINDINGS' });
    expect(runCliProviderPrompt).toHaveBeenCalledWith(expect.objectContaining({
      provider: customHarness,
      cwd: '/worktree/checkout',
    }));

    // An invalid provider transport type is refused
    getProviderById.mockResolvedValue({ ...provider, type: 'unsupported-transport' });
    expect(await runLocalCodeReview({ backend, diff: 'example diff' })).toMatchObject({
      ok: false, code: 'REVIEWER_UNSUPPORTED', error: expect.stringContaining('not a supported review transport'),
    });
  });

  it('refuses unsupported harnesses for public claim review and isolates supported ones in temp dir', async () => {
    const { runLocalClaimCommentReview } = await import('./codeReview.js');
    // Custom harness without tool-free recipe fails closed for public claim comments
    getProviderById.mockResolvedValue({ ...provider, type: 'cli', command: 'custom-agent' });
    const refused = await runLocalClaimCommentReview({
      backend,
      comments: [{ login: 'contributor', body: 'taking this issue' }],
    });
    expect(refused).toMatchObject({
      ok: false,
      code: 'REVIEWER_UNSUPPORTED',
      error: expect.stringContaining('no enforced tool-free'),
    });

    // Supported CLI harness (e.g. claude) runs with safetyProfile and temporary directory
    const supportedCli = { ...provider, type: 'cli', command: 'claude' };
    getProviderById.mockResolvedValue(supportedCli);
    runCliProviderPrompt.mockResolvedValue({
      text: '{"claimant":"contributor","suspicious":false}',
      partial: false,
    });
    const ran = await runLocalClaimCommentReview({
      backend,
      comments: [{ login: 'contributor', body: 'taking this issue' }],
    });
    expect(ran).toMatchObject({ ok: true, claimant: 'contributor', suspicious: false });
    const lastCall = runCliProviderPrompt.mock.lastCall[0];
    expect(lastCall).toMatchObject({
      provider: supportedCli,
      safetyProfile: 'public-review-gate',
    });
    await expect(access(lastCall.cwd)).rejects.toThrow();
  });

  // #7660: a reviewer that can never answer used to be indistinguishable from
  // one that timed out, so the claim gate waited out an outage with no end and
  // every PR stalled looking like it was merely pending.
  it('separates a configuration fault from a reviewer that ran and failed', async () => {
    expect(isReviewerConfigFault('REVIEWER_UNSUPPORTED')).toBe(true);
    expect(isReviewerConfigFault('REVIEWER_UNAVAILABLE')).toBe(true);
    expect(isReviewerConfigFault('NO_MODEL')).toBe(true);
    callProviderAISimple.mockResolvedValue({ error: 'upstream timed out' });
    const ranAndFailed = await runLocalCodeReview({ backend, diff: 'example diff' });
    expect(ranAndFailed.ok).toBe(false);
    expect(isReviewerConfigFault(ranAndFailed.code)).toBe(false);
  });

  describe('getProviderReviewUnsupported', () => {
    it('names only the enabled providers with unsupported review transports', async () => {
      listProviders.mockResolvedValue([
        provider,
        { ...provider, id: 'hosted-harness', type: 'cli', command: 'custom-agent' },
        { ...provider, id: 'invalid-transport', type: 'unsupported-type' },
        { ...provider, id: 'switched-off', type: 'unsupported-type', enabled: false },
      ]);
      const unsupported = await getProviderReviewUnsupported();
      // Capable providers (API and CLI harnesses) are absent from the map
      expect(unsupported['provider:example-gpu']).toBeUndefined();
      expect(unsupported['provider:hosted-harness']).toBeUndefined();
      expect(unsupported).toEqual({ 'provider:invalid-transport': 'REVIEWER_UNSUPPORTED' });
      // A disabled provider is already badged `disabled` by the picker's own
      // provider-record check; reporting it here would badge one fact twice.
      expect(unsupported['provider:switched-off']).toBeUndefined();
    });

    it('agrees with what the dispatch actually does, rather than keeping its own copy of the rule', async () => {
      const harness = { ...provider, id: 'hosted-harness', type: 'cli', command: 'custom-agent' };
      listProviders.mockResolvedValue([harness]);
      getProviderById.mockResolvedValue(harness);
      runCliProviderPrompt.mockResolvedValue({ text: 'NO FINDINGS', partial: false });
      const warned = await getProviderReviewUnsupported();
      const ran = await runLocalCodeReview({ backend: 'provider:hosted-harness', diff: 'example diff' });
      expect(warned['provider:hosted-harness']).toBe(ran.code);
    });

    it('reports nothing when the provider store cannot be read', async () => {
      listProviders.mockRejectedValue(new Error('provider store unreadable'));
      expect(await getProviderReviewUnsupported()).toEqual({});
    });
  });
});
