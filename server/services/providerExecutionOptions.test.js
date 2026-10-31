import { buildVendorSpawnConfig } from '../lib/providerVendors.js';
import { PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE } from '../lib/agentExecutionProfiles.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { probeCodexModelsViaAppServer } from '../lib/aiToolkit/internal/codexModelListProbe.js';
import { probeGrokModelCatalog } from '../lib/grokModelCatalog.js';
import { getExecutionOptionCapabilities, prepareExecutionOptions } from '../lib/providerExecutionOptions.js';
import { buildCliArgs } from '../lib/cliProviderArgs.js';
import { buildTuiInvocation } from '../lib/tuiHandshake.js';
import { buildTuiShellLaunch } from '../lib/tuiShellLaunch.js';
import { resolveExecutionOptions } from '../lib/executionOptions.js';
import { executionOptionsSchema } from '../lib/aiToolkit/internal/executionOptionsValidation.js';
import { applyTaskGenerationOverrides } from '../lib/taskGenerationOverrides.js';

vi.mock('../lib/aiToolkit/internal/codexModelListProbe.js', () => ({ probeCodexModelsViaAppServer: vi.fn() }));
vi.mock('../lib/grokModelCatalog.js', () => ({ probeGrokModelCatalog: vi.fn() }));
const model = 'example-model';
const provider = { id: 'codex', command: 'codex', type: 'cli', codexAuthMode: 'chatgpt', defaultModel: model };

beforeEach(() => {
  vi.clearAllMocks();
  probeCodexModelsViaAppServer.mockResolvedValue({ accountType: 'chatgpt', requirements: null, config: {}, models: [{ id: model, serviceTiers: [{ id: 'fast' }] }] });
});

describe('execution options at dispatch', () => {
  it('preserves defaults without a runtime probe or new argv', async () => {
    const prepared = await prepareExecutionOptions(provider, model);
    expect(prepared.provider).toBe(provider);
    expect(prepared.attribution.requested).toEqual({});
    expect(probeCodexModelsViaAppServer).not.toHaveBeenCalled();
    expect(buildCliArgs(prepared.provider).join(' ')).not.toContain('service_tier');
  });

  it.each(['cli', 'tui'])('carries task Fast independently of effort into verified %s argv', async (type) => {
    const selected = applyTaskGenerationOverrides({ ...provider, type }, { effort: 'high', executionOptions: { serviceTier: 'fast' } });
    const prepared = await prepareExecutionOptions(selected, model);
    const args = type === 'cli' ? buildCliArgs(prepared.provider) : buildTuiInvocation(prepared.provider, model).args;
    expect(args.filter((arg) => arg === 'service_tier="fast"')).toHaveLength(1);
    expect(args).toContain('features.fast_mode=true');
    expect(args.join(' ')).toContain('model_reasoning_effort=high');
    expect(prepared.attribution).toMatchObject({ requested: { serviceTier: 'fast' }, effective: {}, confirmation: 'requested/unconfirmed' });
    expect(provider.executionOptions).toBeUndefined();
  });

  it('carries the selected speed into the public-review recipe without changing its sandbox', async () => {
    const prepared = await prepareExecutionOptions(provider, model, { serviceTier: 'fast' });
    const { args } = buildVendorSpawnConfig(prepared.provider, { effectiveModel: model, safetyProfile: PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE });
    expect(args).toContain('service_tier="fast"');
    expect(args).toContain('workspace-write');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('refuses stale Codex options at direct CLI and TUI boundaries for another harness', () => {
    const stale = { ...provider, id: 'claude-code', command: 'claude', executionOptions: { serviceTier: 'fast' } };
    expect(() => buildCliArgs(stale)).toThrow('unsupported by this harness');
    expect(() => buildTuiInvocation({ ...stale, type: 'tui' }, model)).toThrow('unsupported by this harness');
  });

  it('pins explicit Standard over inherited Fast, including a TUI resume', async () => {
    probeCodexModelsViaAppServer.mockResolvedValue({ accountType: 'chatgpt', config: {}, requirements: { featureRequirements: { fast_mode: false } }, models: [{ id: model, serviceTiers: [] }] });
    const prepared = await prepareExecutionOptions({ ...provider, type: 'tui', args: ['resume', 'example-session'], executionOptions: { serviceTier: 'fast' } }, model, { serviceTier: 'standard' });
    const args = buildTuiInvocation(prepared.provider, model).args;
    expect(args).toContain('service_tier="default"');
    expect(args).not.toContain('features.fast_mode=true');
    expect(args).toContain('resume');
    expect(prepared.attribution.provenance).toEqual({ serviceTier: 'run' });
  });

  it('refuses conflicting provider config instead of reporting it applied', async () => {
    await expect(prepareExecutionOptions({ ...provider, args: ['-c', 'service_tier="fast"'] }, model, { serviceTier: 'standard' })).rejects.toThrow('conflicts with provider args');
  });

  it('rejects unknown options and preserves explicit Standard in precedence', () => {
    expect(executionOptionsSchema.safeParse({ arbitraryFlag: '--fast' }).success).toBe(false);
    expect(executionOptionsSchema.safeParse({ serviceTier: 'priority' }).success).toBe(false);
    expect(resolveExecutionOptions({ source: 'provider', options: { serviceTier: 'fast' } }, { source: 'task', options: { serviceTier: 'standard' } }, { source: 'run', options: {} })).toMatchObject({ requested: { serviceTier: 'standard' }, provenance: { serviceTier: 'task' } });
  });

  it.each([
    { ...provider, type: 'api' },
    { ...provider, command: 'claude' },
    { ...provider, codexAuthMode: 'api' },
  ])('refuses unsupported/fallback routes without sending a model turn', async (route) => {
    await expect(prepareExecutionOptions(route, model, { serviceTier: 'fast' })).rejects.toThrow('ChatGPT');
    expect(probeCodexModelsViaAppServer).not.toHaveBeenCalled();
  });

  it('does not treat an old runtime or unadvertised model as Fast capable', async () => {
    probeCodexModelsViaAppServer.mockResolvedValue({ accountType: 'chatgpt', config: {}, models: [{ id: model }] });
    await expect(prepareExecutionOptions(provider, model, { serviceTier: 'fast' })).rejects.toThrow('did not advertise');
    probeCodexModelsViaAppServer.mockResolvedValue({ accountType: 'chatgpt', config: {}, models: [{ id: model, serviceTiers: [] }] });
    await expect(prepareExecutionOptions(provider, model, { serviceTier: 'fast' })).rejects.toThrow('unsupported');
    expect((await getExecutionOptionCapabilities(provider, model)).options[0].values).toEqual(['standard']);
  });
});

describe('grok execution speed', () => {
  const grokModel = 'grok-4.7';
  const grokProvider = { id: 'grok-cli', command: 'grok', type: 'cli', defaultModel: grokModel };
  const catalog = {
    ids: ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6', 'grok-code-fast-1'],
    defaultModel: 'grok-4.7-build-fast',
  };

  beforeEach(() => {
    probeGrokModelCatalog.mockResolvedValue(catalog);
  });

  it('does not probe or rewrite argv when speed is unset', async () => {
    const prepared = await prepareExecutionOptions(grokProvider, grokModel);
    expect(prepared.provider).toBe(grokProvider);
    expect(probeGrokModelCatalog).not.toHaveBeenCalled();
    expect(probeCodexModelsViaAppServer).not.toHaveBeenCalled();
    const args = buildCliArgs(prepared.provider);
    expect(args).toContain(grokModel);
    expect(args.join(' ')).not.toContain('[fast=');
    expect(args).not.toContain('--fast');
    expect(args.join(' ')).not.toContain('service_tier');
  });

  it.each(['cli', 'tui'])('requests Fast as a model setting on %s without a Codex flag', async (type) => {
    const prepared = await prepareExecutionOptions(
      { ...grokProvider, type, effort: 'high' },
      grokModel,
      { serviceTier: 'fast' },
    );
    const args = type === 'cli'
      ? buildCliArgs(prepared.provider)
      : buildTuiInvocation(prepared.provider, grokModel).args;
    expect(args).toContain('grok-4.7[fast=true]');
    expect(args).not.toContain('grok-4.7-build-fast');
    expect(args).not.toContain('--fast');
    expect(args.join(' ')).not.toContain('service_tier');
    expect(prepared.provider.defaultModel).toBe(grokModel);
    expect(prepared.provider.executionOptionSupport).toMatchObject({
      modelBase: 'grok-4.7', authMode: 'grok', serviceTier: ['standard', 'fast'],
    });
    if (type === 'tui') {
      expect(args).toContain('--effort');
      expect(args).toContain('high');
      expect(args).not.toContain('grok-4.7[fast=true] high');
    }
  });

  it('keeps the public-review sandbox and sends explicit Standard over an inherited Fast', async () => {
    const prepared = await prepareExecutionOptions(
      { ...grokProvider, executionOptions: { serviceTier: 'fast' } },
      grokModel,
      { serviceTier: 'standard' },
    );
    const { args } = buildVendorSpawnConfig(prepared.provider, {
      effectiveModel: grokModel,
      effort: 'high',
      safetyProfile: PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE,
    });
    expect(args).toContain('grok-4.7[fast=false]');
    expect(args).not.toContain('grok-4.7[fast=true]');
    expect(args).toEqual(expect.arrayContaining(['--sandbox', 'workspace', '--permission-mode', 'acceptEdits', '--effort', 'high']));
    expect(args).not.toContain('--fast');
    expect(args.join(' ')).not.toContain('service_tier');
    expect(prepared.attribution.provenance).toEqual({ serviceTier: 'run' });
  });

  it('maps a selected flat fast id and the configured-default sentinel back to the advertised base', async () => {
    const flat = await prepareExecutionOptions(grokProvider, 'grok-4.7-build-fast', { serviceTier: 'standard' });
    expect(flat.provider.defaultModel).toBe('grok-4.7-build-fast');
    expect(buildCliArgs(flat.provider)).toContain('grok-4.7[fast=false]');

    const sentinel = await prepareExecutionOptions(
      { ...grokProvider, type: 'tui', defaultModel: 'grok-configured-default' },
      'grok-configured-default',
      { serviceTier: 'fast' },
    );
    expect(sentinel.provider.defaultModel).toBe('grok-4.7-build-fast');
    expect(sentinel.provider.executionOptionSupport.modelBase).toBe('grok-4.7');
    expect(buildTuiShellLaunch(sentinel.provider).commandLine).toContain('grok-4.7[fast=true]');
    expect(buildTuiInvocation(sentinel.provider, 'grok-configured-default').args).toContain('grok-4.7[fast=true]');
  });

  it('refuses a model that did not advertise a fast sibling', async () => {
    await expect(prepareExecutionOptions(grokProvider, 'grok-4.6', { serviceTier: 'fast' })).rejects.toThrow('did not advertise');
    await expect(prepareExecutionOptions(grokProvider, 'grok-code-fast-1', { serviceTier: 'fast' })).rejects.toThrow('did not advertise');
    expect(buildCliArgs({ ...grokProvider, defaultModel: 'grok-code-fast-1' })).toContain('grok-code-fast-1');
  });

  it('refuses API, gateway, bootstrap, and baked model pins without probing', async () => {
    const cases = [
      { ...grokProvider, id: 'grok', type: 'api' },
      { ...grokProvider, gatewayBacked: true },
      { ...grokProvider, credentialBootstrapId: 'boot' },
      { ...grokProvider, args: ['--model', 'grok-4.7'] },
      { ...grokProvider, args: ['grok-4.7-build-fast'] },
    ];
    for (const route of cases) {
      probeGrokModelCatalog.mockClear();
      await expect(prepareExecutionOptions(route, grokModel, { serviceTier: 'fast' })).rejects.toThrow(/Grok Build CLI or TUI|baked model pin/);
      expect(probeGrokModelCatalog).not.toHaveBeenCalled();
      expect(probeCodexModelsViaAppServer).not.toHaveBeenCalled();
    }
  });

  it('names a probe failure instead of treating it as a missing fast tier', async () => {
    probeGrokModelCatalog.mockResolvedValue(null);
    await expect(prepareExecutionOptions(grokProvider, grokModel, { serviceTier: 'fast' })).rejects.toThrow('could not verify');
  });

  it('refuses a tier when the launch argv already pins a model', () => {
    const pinned = {
      ...grokProvider,
      args: ['--model', 'grok-4.7'],
      executionOptions: { serviceTier: 'fast' },
      executionOptionSupport: { modelBase: 'grok-4.7' },
    };
    expect(() => buildCliArgs(pinned)).toThrow('baked model pin');
    expect(() => buildTuiInvocation({ ...pinned, type: 'tui' }, grokModel)).toThrow('baked model pin');
  });
});
