import { buildVendorSpawnConfig } from '../lib/providerVendors.js';
import { PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE } from '../lib/agentExecutionProfiles.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { probeCodexModelsViaAppServer } from '../lib/aiToolkit/internal/codexModelListProbe.js';
import { getExecutionOptionCapabilities, prepareExecutionOptions } from './providerExecutionOptions.js';
import { buildCliArgs } from '../lib/cliProviderArgs.js';
import { buildTuiInvocation } from '../lib/tuiHandshake.js';
import { resolveExecutionOptions } from '../lib/executionOptions.js';
import { executionOptionsSchema } from '../lib/aiToolkit/internal/executionOptionsValidation.js';
import { applyTaskGenerationOverrides } from '../lib/taskGenerationOverrides.js';

vi.mock('../lib/aiToolkit/internal/codexModelListProbe.js', () => ({ probeCodexModelsViaAppServer: vi.fn() }));
const model = 'example-model';
const provider = { id: 'codex', command: 'codex', type: 'cli', codexAuthMode: 'chatgpt', defaultModel: model };

beforeEach(() => {
  vi.clearAllMocks();
  probeCodexModelsViaAppServer.mockResolvedValue([{ id: model, serviceTiers: [{ id: 'fast' }] }]);
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
    const prepared = await prepareExecutionOptions({ ...provider, type: 'tui', args: ['resume', 'example-session'], executionOptions: { serviceTier: 'fast' } }, model, { serviceTier: 'standard' });
    const args = buildTuiInvocation(prepared.provider, model).args;
    expect(args).toContain('service_tier="default"');
    expect(args).toContain('resume');
    expect(prepared.attribution.provenance).toEqual({ serviceTier: 'run' });
  });

  it('refuses conflicting provider config instead of reporting it applied', async () => {
    await expect(prepareExecutionOptions({ ...provider, args: ['-c', 'service_tier="fast"'] }, model, { serviceTier: 'standard' })).rejects.toThrow('ChatGPT');
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
    { ...provider, codexAuthMode: undefined },
  ])('refuses unsupported/fallback routes without sending a model turn', async (route) => {
    await expect(prepareExecutionOptions(route, model, { serviceTier: 'fast' })).rejects.toThrow('ChatGPT');
    expect(probeCodexModelsViaAppServer).not.toHaveBeenCalled();
  });

  it('does not treat an old runtime or unadvertised model as Fast capable', async () => {
    probeCodexModelsViaAppServer.mockResolvedValue([{ id: model }]);
    await expect(prepareExecutionOptions(provider, model, { serviceTier: 'fast' })).rejects.toThrow('did not advertise');
    probeCodexModelsViaAppServer.mockResolvedValue([{ id: model, serviceTiers: [] }]);
    await expect(prepareExecutionOptions(provider, model, { serviceTier: 'fast' })).rejects.toThrow('unsupported');
    expect((await getExecutionOptionCapabilities(provider, model)).options[0].values).toEqual(['standard']);
  });
});
