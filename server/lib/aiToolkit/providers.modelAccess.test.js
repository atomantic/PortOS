import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createProviderService } from './providers.js';
import { applyModelAccess } from './internal/modelAccess.js';

// Temp dir, NOT a cwd-rooted one — see providerStatus.test.js (#3823).
let TEST_DATA_DIR;

const NVIDIA_CATALOG = ['meta/llama-3.1-8b-instruct', 'nvidia/nemotron-4-340b-instruct', 'moonshotai/kimi-k2.5'];

/** The shipped NVIDIA shape: a gateway `api` record plus its OpenCode CLI/TUI wrappers. */
const nvidiaInstall = (modelAccess) => ({
  activeProvider: 'nvidia-nim',
  providers: {
    'nvidia-nim': {
      id: 'nvidia-nim', name: 'NVIDIA NIM', type: 'api',
      endpoint: 'https://integrate.api.nvidia.com/v1', apiKey: 'nvapi-test',
      models: NVIDIA_CATALOG, ...(modelAccess ? { modelAccess } : {}),
    },
    'opencode-nvidia-nim': {
      id: 'opencode-nvidia-nim', name: 'NVIDIA NIM via OpenCode', type: 'cli',
      command: 'opencode', gatewayBacked: 'nvidia-nim', models: NVIDIA_CATALOG,
    },
    'opencode-nvidia-nim-tui': {
      id: 'opencode-nvidia-nim-tui', name: 'NVIDIA NIM via OpenCode (TUI)', type: 'tui',
      command: 'opencode', gatewayBacked: 'nvidia-nim', models: NVIDIA_CATALOG,
    },
  },
});

describe('provider model access', () => {
  let providerService;
  const providersPath = () => join(TEST_DATA_DIR, 'providers.json');
  const seed = (data) => writeFile(providersPath(), JSON.stringify(data));
  const stored = async () => JSON.parse(await readFile(providersPath(), 'utf8')).providers;

  beforeEach(async () => {
    TEST_DATA_DIR = await mkdtemp(join(tmpdir(), 'portos-model-access-'));
    providerService = createProviderService({ dataDir: TEST_DATA_DIR, providersFile: 'providers.json' });
  });

  afterEach(async () => {
    if (TEST_DATA_DIR) await rm(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('one gateway policy scopes the API record and both OpenCode wrappers', async () => {
    // The user's ask: NVIDIA's API, CLI and TUI options all show the entitled
    // subset. The wrappers store no policy of their own, exactly as they store
    // no API key — the gateway record owns both.
    await seed(nvidiaInstall({ mode: 'allow', patterns: ['meta/*'] }));

    const { providers } = await providerService.getAllProviders();
    for (const id of ['nvidia-nim', 'opencode-nvidia-nim', 'opencode-nvidia-nim-tui']) {
      const scoped = applyModelAccess(providers.find(p => p.id === id));
      expect(scoped.models, id).toEqual(['meta/llama-3.1-8b-instruct']);
      expect(scoped.modelCatalog, id).toEqual(NVIDIA_CATALOG);
    }
    expect(providers.find(p => p.id === 'opencode-nvidia-nim').modelAccessSource).toBe('nvidia-nim');
    expect(providers.find(p => p.id === 'nvidia-nim').modelAccessSource).toBe('own');
  });

  it('a wrapper with its own policy is not overridden by the gateway', async () => {
    const install = nvidiaInstall({ mode: 'allow', patterns: ['meta/*'] });
    install.providers['opencode-nvidia-nim'].modelAccess = { mode: 'deny', patterns: ['meta/*'] };
    await seed(install);

    const wrapper = await providerService.getProviderById('opencode-nvidia-nim');
    expect(wrapper.modelAccessSource).toBe('own');
    expect(applyModelAccess(wrapper).models).toEqual(['nvidia/nemotron-4-340b-instruct', 'moonshotai/kimi-k2.5']);
  });

  it('the resolved policy never becomes the wrapper\'s own stored one', async () => {
    // A client echoing a GET back on a PUT must not pin the inherited value:
    // `modelAccessEffective` is outside `providerSchema`, so the round-trip
    // strips it and a later edit to the gateway still reaches the wrapper.
    await seed(nvidiaInstall({ mode: 'allow', patterns: ['meta/*'] }));
    const wrapper = await providerService.getProviderById('opencode-nvidia-nim');
    await providerService.updateProvider('opencode-nvidia-nim', { name: wrapper.name });
    expect((await stored())['opencode-nvidia-nim'].modelAccess).toBeUndefined();

    await providerService.updateProvider('nvidia-nim', { modelAccess: { mode: 'allow', patterns: ['moonshotai/*'] } });
    const rescoped = applyModelAccess(await providerService.getProviderById('opencode-nvidia-nim'));
    expect(rescoped.models).toEqual(['moonshotai/kimi-k2.5']);
  });

  it('keeps the api key attached to a scoped gateway wrapper', async () => {
    // The key rides as a NON-enumerable property, so the model-access stamp has
    // to compose underneath it — a spread on the other side drops it silently
    // and every wrapper run loses its credential.
    await seed(nvidiaInstall({ mode: 'allow', patterns: ['meta/*'] }));
    expect((await providerService.getProviderById('opencode-nvidia-nim')).apiKey).toBe('nvapi-test');
  });

  it('a refresh re-learns the full catalog rather than the scoped view', async () => {
    // The policy is applied on the way out, never at write time, so the stored
    // record keeps the real catalog and clearing the policy restores it with no
    // re-probe.
    await seed(nvidiaInstall({ mode: 'allow', patterns: ['meta/*'] }));
    await providerService.updateProvider('nvidia-nim', { models: [...NVIDIA_CATALOG, 'openai/gpt-oss-120b'] });
    expect((await stored())['nvidia-nim'].models).toHaveLength(4);

    await providerService.updateProvider('nvidia-nim', { modelAccess: null });
    expect((await stored())['nvidia-nim'].modelAccess).toBeUndefined();
    expect(applyModelAccess(await providerService.getProviderById('nvidia-nim')).models).toHaveLength(4);
  });

  it('stores a normalized policy and drops one that constrains nothing', async () => {
    await seed(nvidiaInstall());
    await providerService.updateProvider('nvidia-nim', { modelAccess: { mode: 'gold-plan', patterns: ['  meta/*  ', 'meta/*'] } });
    // An unknown mode degrades to the unconstraining one rather than to an
    // arbitrary constraining one.
    expect((await stored())['nvidia-nim'].modelAccess).toEqual({ mode: 'all', patterns: ['meta/*'] });

    await providerService.updateProvider('nvidia-nim', { modelAccess: { mode: 'all', patterns: [] } });
    // A record reset to "no policy" must read exactly like one that never had
    // one, not carry an inert object.
    expect((await stored())['nvidia-nim']).not.toHaveProperty('modelAccess');
  });

  it('a create persists a policy only when it says something', async () => {
    await providerService.createProvider({ name: 'Plain', type: 'api', endpoint: 'http://localhost:1234/v1' });
    expect((await stored()).plain).not.toHaveProperty('modelAccess');

    await providerService.createProvider({
      name: 'Scoped', type: 'api', endpoint: 'http://localhost:1234/v1',
      modelAccess: { mode: 'allow', patterns: ['meta/*'] },
    });
    expect((await stored()).scoped.modelAccess).toEqual({ mode: 'allow', patterns: ['meta/*'] });
  });

  it('fans the policy across a CLI/TUI pair so both modes offer one catalog', async () => {
    await seed({ activeProvider: 'example', providers: {
      example: { id: 'example', name: 'Example', type: 'cli', command: 'example', models: NVIDIA_CATALOG },
      'example-tui': { id: 'example-tui', name: 'Example TUI', type: 'tui', command: 'example', models: NVIDIA_CATALOG },
    } });
    await providerService.updateProvider('example', { modelAccess: { mode: 'allow', patterns: ['meta/*'] } });
    expect((await stored())['example-tui'].modelAccess).toEqual({ mode: 'allow', patterns: ['meta/*'] });
  });
});
