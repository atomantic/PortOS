import { describe, it, expect, vi, beforeEach } from 'vitest';
import { access } from 'node:fs/promises';
import { codeReviewSettingsSchema, sanitizeTaskMetadata } from '../lib/cosValidation.js';
import { resolveReviewerConfig, buildReviewWithArgs, isReviewerConfigFault } from '../lib/reviewerConfig.js';
import { localReviewBridgeRequest } from '../lib/localReviewBridge.js';

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
const { pickCodeReviewDefaults, runLocalCodeReview, runLocalClaimCommentReview, getProviderReviewUnsupported, pickAvailableReviewerGroups, isReviewerQuotaFailure } = await import('./codeReview.js');

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

  it('runs saved provider model/effort defaults through the ordinary CLI recipe and task overrides', async () => {
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
    const result = await runLocalCodeReview({ backend, model: task.reviewerModels[backend], effort: task.reviewerEfforts[backend], diff: 'example diff' });
    expect(result).toMatchObject({ ok: true, findings: 'NO FINDINGS', effort: 'high' });
    const args = runCliProviderPrompt.mock.calls[0][0];
    expect(args).toMatchObject({ provider: { ...cli, effort: 'high' }, model: 'pinned-coder', safetyProfile: 'public-review-gate' });
    await expect(access(args.cwd)).rejects.toThrow();
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
      safetyProfile: 'public-review-gate',
    }));

    cli.credentialBootstrap.envCommand = [process.execPath, '-e', 'console.log("ANTHROPIC_AUTH_TOKEN=example-minted-token")'];
    expect(await getProviderReviewUnsupported()).toEqual({});
    expect(await runLocalCodeReview({ backend, diff: 'example diff' })).toMatchObject({ ok: true, findings: 'NO FINDINGS' });
    expect(runCliProviderPrompt).toHaveBeenCalledWith(expect.objectContaining({
      bootstrapEnv: { ANTHROPIC_AUTH_TOKEN: 'example-minted-token' },
      safetyProfile: 'public-review-gate',
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

  // #6338: a reviewer is a feedback agent, never a writer. Antigravity's only
  // maintained public-review posture may apply edits (`accept-edits`), so it
  // has no enforced no-tool recipe — every CLI review, tool-free or ordinary,
  // must refuse it (and any other unrecognized harness) rather than fall back
  // to that vendor's normal unrestricted argv, which for several CLIs is a
  // blanket `--dangerously-skip-permissions`-class flag.
  it('refuses Antigravity and custom harnesses that have no enforced no-tool review posture, in an ordinary review too', async () => {
    for (const command of ['agy', 'custom-agent']) {
      getProviderById.mockResolvedValue({ ...provider, type: 'cli', command });
      runCliProviderPrompt.mockResolvedValue({ text: 'NO FINDINGS', partial: false });
      expect(await runLocalCodeReview({ backend, model: 'pinned-coder', diff: 'example diff', cwd: process.cwd() })).toMatchObject({ ok: false, code: 'REVIEWER_UNSUPPORTED' });
      expect(runCliProviderPrompt).not.toHaveBeenCalled();
    }
  });

  it('keeps explicit tool-free review and public claim screening fail-closed for unsupported harnesses', async () => {
    getProviderById.mockResolvedValue({ ...provider, type: 'cli', command: 'custom-agent' });
    const claimRequest = localReviewBridgeRequest({ kind: 'claim-review', backend, diff: 'example diff', toolFree: false }, process.cwd());
    expect(await runLocalCodeReview(claimRequest)).toMatchObject({ ok: false, code: 'REVIEWER_UNSUPPORTED' });
    expect(await runLocalClaimCommentReview({ backend, comments: [{ login: 'example-user', type: 'User', body: 'I will work on this' }] })).toMatchObject({ ok: false, code: 'REVIEWER_UNSUPPORTED' });
    expect(runCliProviderPrompt).not.toHaveBeenCalled();
  });

  it('isolates an explicitly tool-free review even when a repository was supplied', async () => {
    getProviderById.mockResolvedValue({ ...provider, type: 'cli', command: 'claude' });
    runCliProviderPrompt.mockResolvedValue({ text: 'NO FINDINGS', partial: false });
    const claimRequest = localReviewBridgeRequest({ kind: 'claim-review', backend, diff: 'example diff' }, process.cwd());
    expect(await runLocalCodeReview(claimRequest)).toMatchObject({ ok: true });
    const args = runCliProviderPrompt.mock.lastCall[0];
    expect(args.safetyProfile).toBe('public-review-gate');
    expect(args.cwd).not.toBe(process.cwd());
    await expect(access(args.cwd)).rejects.toThrow();
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
    // #6338: every CLI reviewer now needs a maintained no-tool posture, so a
    // harness this install doesn't recognize (no `supportsPublicReviewProvider`
    // recipe) is reported unsupported too — it would otherwise fall back to
    // that vendor's unrestricted argv.
    it('names missing CLI commands and unfamiliar harnesses with no enforced no-tool posture', async () => {
      listProviders.mockResolvedValue([
        provider,
        { ...provider, id: 'hosted-harness', type: 'cli', command: 'custom-agent' },
        { ...provider, id: 'no-command', type: 'cli' },
        { ...provider, id: 'switched-off', type: 'cli', command: 'custom-agent', enabled: false },
      ]);
      const unsupported = await getProviderReviewUnsupported();
      // The capable provider is ABSENT rather than false, so "nobody fetched
      // this map" and "nothing is wrong here" read the same to a picker.
      expect(unsupported).toEqual({
        'provider:no-command': 'REVIEWER_UNSUPPORTED',
        'provider:hosted-harness': 'REVIEWER_UNSUPPORTED',
      });
      expect(unsupported['provider:example-gpu']).toBeUndefined();
      // A disabled provider is already badged `disabled` by the picker's own
      // provider-record check; reporting it here would badge one fact twice.
      expect(unsupported['provider:switched-off']).toBeUndefined();
    });

    it('agrees with what the dispatch actually does, rather than keeping its own copy of the rule', async () => {
      const harness = { ...provider, id: 'hosted-harness', type: 'cli', command: 'custom-agent' };
      listProviders.mockResolvedValue([harness]);
      getProviderById.mockResolvedValue(harness);
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
