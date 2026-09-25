/**
 * The preset service (#7565): "Save as preset" stores exactly what its
 * composite runs as, a derived preset's save re-derives from the service and
 * refuses a moved connection-owned value, and "Convert to derived preset"
 * stamps a legacy record only on the fixpoint the boot backfill demands.
 *
 * Fixtures mirror `compositeProviders.test.js`; the toolkit's provider service
 * runs on a temp dir so the created record is the one `providers.json` holds.
 * Nothing is spawned; nothing is read out of a running install.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const graphState = vi.hoisted(() => ({ current: { connections: [], bindings: [], routes: [] }, enabled: true }));
const settingsState = vi.hoisted(() => ({ current: {} }));
const settingsMock = vi.hoisted(() => ({
  settingsEvents: { on: () => {}, emit: () => {} },
  getSettings: vi.fn(async () => structuredClone(settingsState.current)),
  updateSettingsWith: vi.fn(async (mutate) => { settingsState.current = await mutate(structuredClone(settingsState.current)); return settingsState.current; }),
}));
vi.mock('./settings.js', () => settingsMock);
const store = vi.hoisted(() => ({
  readGraph: vi.fn(async () => structuredClone(graphState.current)),
  applyReconciliation: vi.fn(async () => {}),
  applyServiceColumnBackfill: vi.fn(async () => {}),
  mergeServiceInstances: vi.fn(async () => {}),
}));
vi.mock('./providerGraphStore.js', () => store);
vi.mock('./providerRuntimeInstaller.js', async (importOriginal) => ({
  ...(await importOriginal()),
  peekProviderRuntimeStatuses: () => ({ pi: { installed: true, version: '1.0.0' }, claude: { installed: true, version: '2.0.0' } }),
}));
vi.mock('./providerServices.js', () => ({ listServices: vi.fn(async () => ({ services: [] })) }));
const toolkitState = vi.hoisted(() => ({ toolkit: null }));
vi.mock('../lib/aiToolkitState.js', () => ({ requireToolkit: () => toolkitState.toolkit }));

const { createProviderService } = await import('../lib/aiToolkit/providers.js');
const graph = await import('./providerGraph.js');
const composite = await import('./compositeProviders.js');
const presets = await import('./providerPresets.js');
const { buildCliChildEnv } = await import('../lib/cliChildEnv.js');
const { buildTuiInvocation } = await import('../lib/tuiHandshake.js');

const uuid = (n) => `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}`;
const NIM = {
  id: uuid(1), revision: 1, enabled: true, credentialVia: 'stored', kind: 'gateway:nvidia-nim', label: 'NVIDIA NIM (free)', slug: 'nvidia-nim-free', definitionId: 'nvidia-nim', plan: 'free',
  transports: { openai: { baseUrl: 'https://integrate.api.nvidia.com/v1' } }, credentials: { apiKey: 'nim-key' },
  catalog: { state: 'known', models: ['nvidia/example-nemotron', 'meta/example-llama'] },
};
const OLLAMA = {
  id: uuid(3), revision: 1, enabled: true, credentialVia: 'stored', kind: 'ollama', label: 'Ollama', slug: 'ollama', definitionId: 'ollama', plan: 'local',
  transports: { openai: { baseUrl: 'http://127.0.0.1:11434/v1' }, anthropic: { baseUrl: 'http://127.0.0.1:11434' } },
  credentials: { ANTHROPIC_AUTH_TOKEN: 'ollama' }, catalog: { state: 'known', models: ['example-llama'] },
};

let dataDir;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'portos-presets-'));
  toolkitState.toolkit = { services: { providers: createProviderService({ dataDir, providersCacheTtlMs: 0, onProvidersSaved: () => graph.onProvidersSaved(), resolveCompositeProvider: composite.resolveCompositeProvider }) } };
  graphState.current = { connections: [structuredClone(NIM), structuredClone(OLLAMA)], bindings: [], routes: [] };
  settingsState.current = {};
  composite.invalidateCompositeCache();
  graph.resetProviderGraphState();
  await graph.initProviderGraph();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dataDir, { recursive: true, force: true });
});

const providerService = () => toolkitState.toolkit.services.providers;

describe('createPresetFromComposite', () => {
  it('pi.tui@nvidia-nim-free → a stored, enabled preset that spawns with the composite\'s exact argv and env', async () => {
    const source = await providerService().getProviderById('pi.tui@nvidia-nim-free');
    const created = await presets.createPresetFromComposite({ compositeId: 'pi.tui@nvidia-nim-free', model: 'meta/example-llama', effort: 'high' });

    expect(created).toMatchObject({ id: 'pi-tui-nvidia-nim-free', harnessId: 'pi', method: 'tui', serviceId: 'nvidia-nim-free', enabled: true, defaultModel: 'meta/example-llama', effort: 'high' });
    expect(created).not.toHaveProperty('servicePlan');
    const stored = await providerService().getProviderById('pi-tui-nvidia-nim-free');
    // The saved effort is the one difference from the bare composite, and it is the caller's.
    expect(buildTuiInvocation(stored, 'meta/example-llama')).toEqual(buildTuiInvocation({ ...source, effort: 'high' }, 'meta/example-llama'));
    const env = (provider) => buildCliChildEnv({ baseEnv: { PATH: '/usr/bin' }, provider, cwd: process.cwd() });
    expect(env(stored).NVIDIA_API_KEY).toBe('nim-key');
    expect(env(stored)).toEqual(env(source));
    // A second save mints the next free id rather than colliding.
    expect((await presets.createPresetFromComposite({ compositeId: 'pi.tui@nvidia-nim-free' })).id).toBe('pi-tui-nvidia-nim-free-2');
  });

  it('carries the +bootstrap suffix as credentialBootstrapId and writes the inline object the spawner reads', async () => {
    settingsState.current = { credentialBootstraps: { 'corp-auth': { label: 'Corp', command: 'corp-auth', args: ['run'], argsSeparator: '--', harnessNames: { claude: 'claude-code' } } } };
    graphState.current.connections.push({ id: uuid(5), revision: 1, enabled: true, kind: 'api', label: 'Anthropic', slug: 'anthropic', definitionId: 'anthropic', plan: 'paid', transports: { anthropic: { baseUrl: 'https://api.anthropic.com' } }, credentials: {}, credentialVia: 'bootstrap', catalog: { state: 'unknown', models: [] } });
    composite.invalidateCompositeCache();
    const created = await presets.createPresetFromComposite({ compositeId: 'claude.cli@anthropic+corp-auth', name: 'Claude (corp)' });
    expect(created).toMatchObject({ id: 'claude-cli-anthropic-corp-auth', name: 'Claude (corp)', credentialBootstrapId: 'corp-auth', credentialBootstrap: { command: 'corp-auth', harnessId: 'claude-code', argsSeparator: '--' } });
  });

  it('refuses an ineligible composite with the resolver\'s own code, a taken id, an unlisted model and an unsupported effort', async () => {
    await expect(presets.createPresetFromComposite({ compositeId: 'pi.tui@no-such-service' })).rejects.toMatchObject({ status: 400, code: 'service-unknown' });
    await expect(presets.createPresetFromComposite({ compositeId: 'pi.tui@nvidia-nim-free', model: 'nvidia/not-listed' })).rejects.toMatchObject({ status: 400, code: 'PRESET_MODEL_UNKNOWN' });
    await expect(presets.createPresetFromComposite({ compositeId: 'direct.api@nvidia-nim-free', effort: 'high' })).rejects.toMatchObject({ status: 400, code: 'PRESET_EFFORT_UNSUPPORTED' });
    await presets.createPresetFromComposite({ compositeId: 'pi.tui@nvidia-nim-free', id: 'mine' });
    await expect(presets.createPresetFromComposite({ compositeId: 'pi.tui@nvidia-nim-free', id: 'mine' })).rejects.toMatchObject({ status: 409, code: 'PRESET_ID_TAKEN' });
  });
});

describe('materializeStoredPreset', () => {
  it('re-derives a derived preset from its service, reads a models edit as a narrowing, and refuses a moved connection-owned value', async () => {
    const created = await presets.createPresetFromComposite({ compositeId: 'claude.cli@ollama' });
    const stored = await providerService().getProviderById(created.id);

    const edited = await presets.materializeStoredPreset({ ...stored, effort: 'low', args: ['--print', '--verbose'], models: ['example-llama'] }, { updates: { effort: 'low', args: ['--print', '--verbose'], models: ['example-llama'] } });
    expect(edited).toMatchObject({ effort: 'low', args: ['--print', '--verbose'], envVars: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434', ANTHROPIC_AUTH_TOKEN: 'ollama' } });
    expect(edited.catalogNarrowing).toBeNull();

    await expect(presets.materializeStoredPreset({ ...stored, envVars: { ...stored.envVars, ANTHROPIC_BASE_URL: 'http://elsewhere.test' } }, {
      updates: { envVars: { ...stored.envVars, ANTHROPIC_BASE_URL: 'http://elsewhere.test' } },
      previous: stored,
    }))
      .rejects.toMatchObject({ status: 400, code: 'PRESET_FIELD_DERIVED', context: { fields: ['envVars.ANTHROPIC_BASE_URL'], serviceId: 'ollama' } });
    await expect(presets.materializeStoredPreset({ ...stored, serviceId: 'nowhere' })).rejects.toMatchObject({ status: 400, code: 'service-unknown' });
  });

  it('never lets a stale service catalog shrink a preset: an echoed list is not a narrowing, and a narrowing keeps ids not listed yet', async () => {
    const created = await presets.createPresetFromComposite({ compositeId: 'pi.tui@nvidia-nim-free' });
    // A record whose models got ahead of its service catalog (a newer listing
    // written onto the record). Saving the editor echoes that list back.
    const previous = { ...(await providerService().getProviderById(created.id)), models: ['meta/example-llama', 'meta/example-new'] };
    const echoed = await presets.materializeStoredPreset({ ...previous, name: 'Renamed' }, { updates: { name: 'Renamed', models: previous.models }, previous });
    expect(echoed.catalogNarrowing ?? null).toBeNull();
    expect(echoed.models).toEqual(['nvidia/example-nemotron', 'meta/example-llama']);

    const updates = { models: ['meta/example-llama', 'meta/example-new'] };
    const narrowed = await presets.materializeStoredPreset({ ...previous, ...updates }, { updates, previous: { ...previous, models: ['meta/example-llama'] } });
    expect(narrowed.catalogNarrowing).toEqual(['meta/example-llama', 'meta/example-new']);
    expect(narrowed.models).toEqual(['meta/example-llama']);
  });

  it('accepts an ordinary preset save after its NVIDIA service key changes and stores the new service value', async () => {
    const created = await presets.createPresetFromComposite({ compositeId: 'pi.tui@nvidia-nim-free' });
    const previous = await providerService().getProviderById(created.id);
    expect(previous.envVars.NVIDIA_API_KEY).toBe('nim-key');

    graphState.current.connections.find((connection) => connection.slug === 'nvidia-nim-free').credentials.apiKey = 'new-test-key';
    const updates = { ...previous, name: 'Pi on NVIDIA NIM' };
    const edited = await presets.materializeStoredPreset({ ...previous, ...updates }, { updates, previous });

    expect(edited).toMatchObject({
      name: 'Pi on NVIDIA NIM',
      serviceId: 'nvidia-nim-free',
      envVars: { NVIDIA_API_KEY: 'new-test-key' },
    });
  });
});

describe('derivePreset', () => {
  it('stamps a legacy record the graph routes onto a named instance, and refuses one whose re-derivation would change its run', async () => {
    const legacy = { id: 'claude-ollama', name: 'Claude on Ollama', type: 'cli', command: 'claude', args: ['--print'], ollamaBacked: true, enabled: true, models: ['example-llama'],
      envVars: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434', ANTHROPIC_AUTH_TOKEN: 'ollama' }, secretEnvVars: ['ANTHROPIC_AUTH_TOKEN'] };
    await providerService().createProvider(legacy);
    // The record is unmapped, so the pass its save fires imports it — as its
    // own fragment, a second instance of the daemon (import never auto-links),
    // which is the service it is then derived from in that same pass; the same
    // pass then folds that copy into the `ollama` instance it duplicates, so
    // the preset ends up naming the one service. The store double records the
    // plan and the next read serves it back.
    store.applyReconciliation.mockImplementation(async (plan) => {
      const imported = plan.imports;
      graphState.current = {
        connections: [...graphState.current.connections, ...imported.connections],
        bindings: [...graphState.current.bindings, ...imported.bindings],
        routes: [...graphState.current.routes, ...imported.routes],
      };
    });
    const derived = await presets.derivePreset('claude-ollama');
    expect(derived).toMatchObject({ harnessId: 'claude', method: 'cli', serviceId: 'ollama', command: 'claude', args: ['--print'] });
    expect(store.mergeServiceInstances).toHaveBeenCalledWith(expect.objectContaining({ absorbedSlugs: ['ollama-2'], keeper: expect.objectContaining({ slug: 'ollama' }) }));

    await providerService().createProvider({ ...legacy, id: 'claude-path', command: '/opt/bin/claude' });
    await expect(presets.derivePreset('claude-path')).rejects.toMatchObject({ status: 409, code: 'PRESET_NOT_DERIVABLE' });
    await expect(presets.derivePreset('nope')).rejects.toMatchObject({ status: 404 });
  });
});
