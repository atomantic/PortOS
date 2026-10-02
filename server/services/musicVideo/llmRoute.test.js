/**
 * Which LLM a Music Video text stage runs on (#9545): request pin > the brief's
 * saved pin > an eligible TUI provider > the active provider. The registry and
 * the runner's model resolution are doubled; nothing calls a real provider.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const registry = { providers: [], active: null };
vi.mock('../providers.js', () => ({
  listProviders: vi.fn(async () => registry.providers),
  getActiveProvider: vi.fn(async () => registry.active),
}));
vi.mock('../promptRunner.js', () => ({
  // Like the real helper: a known id resolves, anything else falls back to the active provider.
  resolveProviderAndModel: vi.fn(async ({ providerId, model } = {}) => {
    const provider = registry.providers.find((p) => p.id === providerId) || registry.active;
    return { provider, selectedModel: model || provider?.defaultModel || null };
  }),
}));
vi.mock('../../lib/tuiShellLaunch.js', () => ({
  buildTuiShellLaunch: (provider) => (provider.unlaunchable ? null : { commandLine: provider.command, env: {} }),
}));
vi.mock('./projects.js', () => ({ mutateProjectRecord: vi.fn() }));

const { resolveMusicVideoLlm, recordLlmRoute, effortArg } = await import('./llmRoute.js');
const { mutateProjectRecord } = await import('./projects.js');

const api = (id, extra = {}) => ({ id, type: 'api', enabled: true, defaultModel: 'api-model', ...extra });
const tui = (id, extra = {}) => ({ id, type: 'tui', enabled: true, command: 'claude', defaultModel: 'tui-model', ...extra });

beforeEach(() => {
  registry.providers = [];
  registry.active = null;
  vi.clearAllMocks();
});

describe('resolveMusicVideoLlm', () => {
  it('prefers an eligible TUI over the active API provider when nothing is pinned, and the active TUI over the first', async () => {
    registry.providers = [api('cloud'), tui('first-tui'), tui('active-tui')];
    registry.active = registry.providers[0];
    expect((await resolveMusicVideoLlm()).route).toMatchObject({ providerId: 'first-tui', transport: 'tui', source: 'tui-preferred' });

    registry.active = registry.providers[2];
    expect((await resolveMusicVideoLlm()).route.providerId).toBe('active-tui');
  });

  it('skips a TUI that is disabled, cannot run on this hardware, or cannot be launched, then uses the active provider', async () => {
    registry.providers = [
      tui('off', { enabled: false }),
      tui('wrong-os', { hardwareRequirements: { platforms: ['plan9'] } }),
      tui('stub', { unlaunchable: true }),
      api('cloud'),
    ];
    registry.active = registry.providers[3];
    const { provider, route } = await resolveMusicVideoLlm();
    expect(provider.id).toBe('cloud');
    expect(route).toMatchObject({ providerId: 'cloud', transport: 'api', source: 'active', effort: null });
  });

  it('keeps a request pin authoritative — an API pin is not replaced by an available TUI', async () => {
    registry.providers = [tui('tui-1'), api('cloud')];
    registry.active = registry.providers[0];
    const { provider, selectedModel, route } = await resolveMusicVideoLlm({ providerId: 'cloud', model: 'big', effort: 'high' });
    expect([provider.id, selectedModel]).toEqual(['cloud', 'big']);
    // API providers have no effort control, so the effective effort is none.
    expect(route).toMatchObject({ source: 'pinned', transport: 'api', effort: null });
  });

  it('applies the brief pin when the request pins nothing, with effort clamped to the provider ladder', async () => {
    registry.providers = [api('cloud'), tui('tui-1')];
    registry.active = registry.providers[0];
    const automation = { llm: { providerId: 'tui-1', model: 'opus', effort: 'ultra' } };
    const { route } = await resolveMusicVideoLlm({ automation });
    // `ultra` is not on the Claude ladder: it runs at the nearest level below.
    expect(route).toEqual({ providerId: 'tui-1', model: 'opus', effort: 'max', transport: 'tui', source: 'brief' });
    expect(effortArg(route)).toEqual({ effort: 'max' });

    // A request pin beats the saved brief pin.
    expect((await resolveMusicVideoLlm({ automation, providerId: 'cloud' })).route).toMatchObject({ providerId: 'cloud', source: 'pinned' });
  });

  it('reports the pin it replaced when the saved provider no longer exists', async () => {
    registry.providers = [api('cloud'), tui('tui-1')];
    registry.active = registry.providers[0];
    const { route } = await resolveMusicVideoLlm({ automation: { llm: { providerId: 'deleted-provider' } } });
    expect(route).toMatchObject({ providerId: 'tui-1', source: 'tui-preferred', requestedProviderId: 'deleted-provider' });
  });

  it('survives a registry with no providers at all', async () => {
    expect(await resolveMusicVideoLlm()).toEqual({ provider: null, selectedModel: null, route: null });
  });
});

describe('recordLlmRoute', () => {
  const route = { providerId: 'tui-1', model: 'opus', effort: 'high', transport: 'tui', source: 'tui-preferred' };

  it('stores the route on a project that has an automation brief, keeping the other stage', async () => {
    mutateProjectRecord.mockImplementation(async (_id, transform) => transform({ automation: { tools: [], routes: { plan: { providerId: 'p' } } } }));
    const project = await recordLlmRoute('mv-1', 'castAndSets', route);
    expect(project.automation.routes.plan).toEqual({ providerId: 'p' });
    expect(project.automation.routes.castAndSets).toMatchObject(route);
  });

  it('writes nothing for a manual project, and a failed write never fails the stage', async () => {
    mutateProjectRecord.mockImplementationOnce(async (_id, transform) => transform({ name: 'manual' }));
    expect(await recordLlmRoute('mv-1', 'plan', route)).toBeNull();
    mutateProjectRecord.mockRejectedValueOnce(new Error('db down'));
    expect(await recordLlmRoute('mv-1', 'plan', route)).toBeNull();
  });
});
