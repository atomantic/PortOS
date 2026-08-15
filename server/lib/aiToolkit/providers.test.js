import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createProviderService, isOllamaBackedProvider } from './providers.js';

// Temp dir, NOT a cwd-rooted one — see providerStatus.test.js (#3823).
let TEST_DATA_DIR;

describe('Provider Service', () => {
  let providerService;

  beforeEach(async () => {
    TEST_DATA_DIR = await mkdtemp(join(tmpdir(), 'portos-providers-'));

    providerService = createProviderService({
      dataDir: TEST_DATA_DIR,
      providersFile: 'providers.json'
    });
  });

  afterEach(async () => {
    if (TEST_DATA_DIR) await rm(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('should create a provider', async () => {
    const provider = await providerService.createProvider({
      name: 'Test Provider',
      type: 'cli',
      command: 'test',
      args: ['--version']
    });

    expect(provider).toBeDefined();
    expect(provider.id).toBe('test-provider');
    expect(provider.name).toBe('Test Provider');
    expect(provider.type).toBe('cli');
  });

  it('should get all providers', async () => {
    await providerService.createProvider({
      name: 'Test Provider 1',
      type: 'cli',
      command: 'test1'
    });

    await providerService.createProvider({
      name: 'Test Provider 2',
      type: 'api',
      endpoint: 'https://api.example.com'
    });

    const { providers } = await providerService.getAllProviders();
    expect(providers).toHaveLength(2);
  });

  it('should set active provider', async () => {
    const newProvider = await providerService.createProvider({
      name: 'Test Provider',
      type: 'cli',
      command: 'test'
    });

    const active = await providerService.setActiveProvider(newProvider.id);
    expect(active).toBeDefined();
    expect(active.id).toBe(newProvider.id);

    const activeProvider = await providerService.getActiveProvider();
    expect(activeProvider.id).toBe(newProvider.id);
  });

  it('should update a provider', async () => {
    const newProvider = await providerService.createProvider({
      name: 'Test Provider',
      type: 'cli',
      command: 'test'
    });

    const updated = await providerService.updateProvider(newProvider.id, {
      command: 'updated-test'
    });

    expect(updated.command).toBe('updated-test');
  });

  it('should delete a provider', async () => {
    const newProvider = await providerService.createProvider({
      name: 'Test Provider',
      type: 'cli',
      command: 'test'
    });

    const deleted = await providerService.deleteProvider(newProvider.id);
    expect(deleted).toBe(true);

    const retrieved = await providerService.getProviderById(newProvider.id);
    expect(retrieved).toBeNull();
  });

  it('should throw error for duplicate provider', async () => {
    await providerService.createProvider({
      name: 'Test Provider',
      type: 'cli',
      command: 'test'
    });

    await expect(
      providerService.createProvider({
        name: 'Test Provider',
        type: 'cli',
        command: 'test'
      })
    ).rejects.toThrow('Provider with this ID already exists');
  });

  // Guards the regression noted in CLAUDE.md: `updateProvider` uses spread so
  // existing providers preserve custom fields, but `createProvider` has an
  // explicit field list. A field added to the schema without being added to
  // `createProvider` would silently disappear on the create → save → load
  // round-trip. Exhaust every field in the explicit list.
  it('round-trips every field defined by createProvider through save + reload', async () => {
    const seed = {
      id: 'parity-fixture',
      name: 'Parity Fixture',
      type: 'tui',
      command: 'codex',
      args: ['exec', '--full-auto'],
      endpoint: 'https://api.example.com/v1',
      apiKey: 'sk-test-secret',
      models: ['model-a', 'model-b', 'model-c'],
      defaultModel: 'model-a',
      lightModel: 'model-b',
      mediumModel: 'model-a',
      heavyModel: 'model-c',
      fallbackProvider: 'fallback-provider-id',
      fallbackModel: 'fallback-model-id',
      numCtx: 32768,
      contextWindow: 1000000,
      timeout: 600000,
      enabled: false,
      envVars: { OPENAI_BASE_URL: 'https://example.com', LOG_LEVEL: 'debug' },
      secretEnvVars: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
      headlessArgs: ['--quiet', '--no-color'],
      tuiPromptDelayMs: 5000,
      tuiIdleTimeoutMs: 120000,
    };

    const created = await providerService.createProvider(seed);

    // First-pass: createProvider itself returns the full record
    for (const key of Object.keys(seed)) {
      expect(created[key]).toStrictEqual(seed[key]);
    }

    // Second-pass: after a fresh service instance reads from disk, every field
    // must survive the JSON write + parse round-trip
    const reloadedService = createProviderService({
      dataDir: TEST_DATA_DIR,
      providersFile: 'providers.json'
    });
    const reloaded = await reloadedService.getProviderById('parity-fixture');

    expect(reloaded).not.toBeNull();
    for (const key of Object.keys(seed)) {
      expect(reloaded[key]).toStrictEqual(seed[key]);
    }
  });

  describe('getSampleProviders', () => {
    it('should return sample providers from default sample file', async () => {
      // No providers created yet — all samples should be returned
      const samples = await providerService.getSampleProviders();
      expect(Array.isArray(samples)).toBe(true);
      expect(samples.length).toBeGreaterThan(0);
      // Should include claude-code-bedrock from the default sample
      const bedrock = samples.find(p => p.id === 'claude-code-bedrock');
      expect(bedrock).toBeDefined();
      expect(bedrock.name).toBe('Claude Code CLI: Bedrock');
      expect(samples.find(p => p.id === 'codex-tui')?.contextWindow).toBe(1000000);
      expect(samples.find(p => p.id === 'antigravity-cli')?.contextWindow).toBe(1048576);
      // Kimi Code process providers ship disabled with the K2 256K window.
      expect(samples.find(p => p.id === 'kimi-cli')?.contextWindow).toBe(256000);
      expect(samples.find(p => p.id === 'kimi-tui')?.command).toBe('kimi');
    });

    it('should exclude providers already in user config', async () => {
      // Create a provider with an ID that matches a sample
      await providerService.createProvider({
        id: 'claude-code',
        name: 'Claude Code CLI',
        type: 'cli',
        command: 'claude'
      });

      const samples = await providerService.getSampleProviders();
      const claudeCode = samples.find(p => p.id === 'claude-code');
      expect(claudeCode).toBeUndefined();
    });

    it('should overlay host app sample over toolkit defaults', async () => {
      // Pre-create providers.json with one existing provider so loadProviders
      // doesn't bootstrap from sampleFile
      const providersPath = join(TEST_DATA_DIR, 'providers-overlay.json');
      await writeFile(providersPath, JSON.stringify({
        activeProvider: 'existing',
        providers: {
          existing: { id: 'existing', name: 'Existing', type: 'cli', command: 'test' }
        }
      }));

      // Create a host app sample with a unique provider
      const samplePath = join(TEST_DATA_DIR, 'custom-sample.json');
      await writeFile(samplePath, JSON.stringify({
        activeProvider: 'custom-cli',
        providers: {
          'custom-cli': {
            id: 'custom-cli',
            name: 'Custom CLI',
            type: 'cli',
            command: 'custom',
            args: [],
            models: [],
            timeout: 300000,
            enabled: true
          }
        }
      }));

      const serviceWithSample = createProviderService({
        dataDir: TEST_DATA_DIR,
        providersFile: 'providers-overlay.json',
        sampleFile: samplePath
      });

      const samples = await serviceWithSample.getSampleProviders();
      const custom = samples.find(p => p.id === 'custom-cli');
      expect(custom).toBeDefined();
      expect(custom.name).toBe('Custom CLI');
      // 'existing' should NOT appear (already in user's config)
      const existing = samples.find(p => p.id === 'existing');
      expect(existing).toBeUndefined();
    });
  });

  describe('Codex provider auto-migration', () => {
    const CODEX_SENTINEL = 'codex-configured-default';

    const writeProvidersFile = async (data) => {
      await writeFile(
        join(TEST_DATA_DIR, 'providers.json'),
        JSON.stringify(data, null, 2)
      );
    };

    const readProvidersFile = async () => {
      const { readFile } = await import('fs/promises');
      const raw = await readFile(join(TEST_DATA_DIR, 'providers.json'), 'utf-8');
      return JSON.parse(raw);
    };

    it('preserves a real Codex model selection on first read', async () => {
      await writeProvidersFile({
        activeProvider: 'codex',
        providers: {
          codex: {
            id: 'codex',
            name: 'Codex CLI',
            type: 'cli',
            command: 'codex',
            args: ['exec', '--full-auto'],
            models: ['gpt-5.2', 'gpt-5-codex'],
            defaultModel: 'gpt-5.2',
            lightModel: 'gpt-5',
            mediumModel: 'gpt-5.2',
            heavyModel: 'gpt-5.2'
          }
        }
      });

      const codex = await providerService.getProviderById('codex');
      expect(codex.models).toEqual(['gpt-5.2', 'gpt-5-codex']);
      expect(codex.defaultModel).toBe('gpt-5.2');
      expect(codex.lightModel).toBe('gpt-5');
      expect(codex.mediumModel).toBe('gpt-5.2');
      expect(codex.heavyModel).toBe('gpt-5.2');

      const onDisk = await readProvidersFile();
      expect(onDisk.providers.codex.defaultModel).toBe('gpt-5.2');
      expect(onDisk.providers.codex.models).toEqual(['gpt-5.2', 'gpt-5-codex']);
    });

    it('migrates a sentinel-only Codex CLI config to selectable tiers', async () => {
      await writeProvidersFile({
        activeProvider: 'codex',
        providers: {
          codex: {
            id: 'codex',
            name: 'Codex CLI',
            type: 'cli',
            command: 'codex',
            args: ['exec'],
            models: [CODEX_SENTINEL],
            defaultModel: CODEX_SENTINEL,
            lightModel: CODEX_SENTINEL,
            mediumModel: CODEX_SENTINEL,
            heavyModel: CODEX_SENTINEL,
            contextWindow: 1000000
          }
        }
      });

      const codex = await providerService.getProviderById('codex');
      expect(codex.models).toEqual(['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol']);
      expect(codex.defaultModel).toBe('gpt-5.6-terra');
      expect(codex.lightModel).toBe('gpt-5.6-luna');
      expect(codex.mediumModel).toBe('gpt-5.6-terra');
      expect(codex.heavyModel).toBe('gpt-5.6-sol');
    });

    it('migrates a sentinel-only Codex TUI config to selectable tiers', async () => {
      await writeProvidersFile({
        activeProvider: 'codex-tui',
        providers: {
          'codex-tui': {
            id: 'codex-tui',
            name: 'Codex TUI',
            type: 'tui',
            command: 'codex',
            models: [CODEX_SENTINEL],
            defaultModel: CODEX_SENTINEL,
            lightModel: CODEX_SENTINEL,
            mediumModel: CODEX_SENTINEL,
            heavyModel: CODEX_SENTINEL,
          },
        },
      });

      const codexTui = await providerService.getProviderById('codex-tui');
      expect(codexTui.models).toEqual(['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol']);
      expect(codexTui.defaultModel).toBe('gpt-5.6-terra');
      expect(codexTui.lightModel).toBe('gpt-5.6-luna');
      expect(codexTui.mediumModel).toBe('gpt-5.6-terra');
      expect(codexTui.heavyModel).toBe('gpt-5.6-sol');
    });

    it('does not touch non-codex providers', async () => {
      await writeProvidersFile({
        activeProvider: 'claude-code',
        providers: {
          'claude-code': {
            id: 'claude-code',
            name: 'Claude Code',
            type: 'cli',
            command: 'claude',
            models: ['claude-opus-4-7', 'claude-sonnet-4-6'],
            defaultModel: 'claude-opus-4-7'
          },
          'openai-api': {
            id: 'openai-api',
            name: 'OpenAI',
            type: 'api',
            apiKey: 'sk-test',
            models: ['gpt-5.2', 'gpt-5'],
            defaultModel: 'gpt-5.2'
          }
        }
      });

      const claude = await providerService.getProviderById('claude-code');
      const openai = await providerService.getProviderById('openai-api');
      expect(claude.defaultModel).toBe('claude-opus-4-7');
      expect(claude.models).toEqual(['claude-opus-4-7', 'claude-sonnet-4-6']);
      expect(openai.defaultModel).toBe('gpt-5.2');
      expect(openai.models).toEqual(['gpt-5.2', 'gpt-5']);
    });

    it('does not touch a codex entry that is type:"api" (only type:"cli" matches)', async () => {
      await writeProvidersFile({
        activeProvider: 'codex',
        providers: {
          codex: {
            id: 'codex',
            name: 'Codex API',
            type: 'api',
            apiKey: 'sk-test',
            models: ['gpt-5.2'],
            defaultModel: 'gpt-5.2'
          }
        }
      });

      const codex = await providerService.getProviderById('codex');
      expect(codex.defaultModel).toBe('gpt-5.2');
      expect(codex.models).toEqual(['gpt-5.2']);
    });

    it('preserves other codex fields (command, args, enabled, envVars)', async () => {
      await writeProvidersFile({
        activeProvider: 'codex',
        providers: {
          codex: {
            id: 'codex',
            name: 'Codex CLI',
            type: 'cli',
            command: 'codex',
            args: ['exec', '--full-auto', '--dangerously-bypass-approvals-and-sandbox'],
            enabled: true,
            envVars: { OPENAI_BASE_URL: 'https://example.com' },
            models: ['gpt-5.2'],
            defaultModel: 'gpt-5.2'
          }
        }
      });

      const codex = await providerService.getProviderById('codex');
      expect(codex.command).toBe('codex');
      expect(codex.args).toEqual([
        'exec',
        '--full-auto',
        '--dangerously-bypass-approvals-and-sandbox'
      ]);
      expect(codex.enabled).toBe(true);
      expect(codex.envVars).toEqual({ OPENAI_BASE_URL: 'https://example.com' });
    });

    it('preserves a partial legacy config rather than erasing its selected model', async () => {
      await writeProvidersFile({
        activeProvider: 'codex',
        providers: {
          codex: {
            id: 'codex',
            type: 'cli',
            command: 'codex',
            models: [CODEX_SENTINEL],
            defaultModel: 'gpt-5.2'
          }
        }
      });

      const codex = await providerService.getProviderById('codex');
      expect(codex.models).toEqual([CODEX_SENTINEL]);
      expect(codex.defaultModel).toBe('gpt-5.2');
    });

    it('upgrades default Codex and Antigravity context windows on first read', async () => {
      await writeProvidersFile({
        activeProvider: 'codex-tui',
        providers: {
          codex: {
            id: 'codex',
            name: 'Codex CLI',
            type: 'cli',
            command: 'codex',
            contextWindow: 128000,
            models: [CODEX_SENTINEL],
            defaultModel: CODEX_SENTINEL
          },
          'codex-tui': {
            id: 'codex-tui',
            name: 'Codex TUI',
            type: 'tui',
            command: 'codex',
            models: [CODEX_SENTINEL],
            defaultModel: CODEX_SENTINEL
          },
          'antigravity-cli': {
            id: 'antigravity-cli',
            name: 'Antigravity CLI',
            type: 'cli',
            command: 'agy',
            contextWindow: 128000,
            models: ['antigravity-configured-default'],
            defaultModel: 'antigravity-configured-default'
          },
          custom: {
            id: 'custom',
            name: 'Custom CLI',
            type: 'cli',
            command: 'custom',
            contextWindow: 128000
          }
        }
      });

      const codex = await providerService.getProviderById('codex');
      const codexTui = await providerService.getProviderById('codex-tui');
      const antigravity = await providerService.getProviderById('antigravity-cli');
      const custom = await providerService.getProviderById('custom');

      expect(codex.contextWindow).toBe(1000000);
      expect(codexTui.contextWindow).toBe(1000000);
      expect(antigravity.contextWindow).toBe(1048576);
      expect(custom.contextWindow).toBe(128000);
    });

    it('preserves user-tuned context windows above the stale generic value', async () => {
      await writeProvidersFile({
        activeProvider: 'codex',
        providers: {
          codex: {
            id: 'codex',
            name: 'Codex CLI',
            type: 'cli',
            command: 'codex',
            contextWindow: 512000,
            models: [CODEX_SENTINEL],
            defaultModel: CODEX_SENTINEL
          }
        }
      });

      const codex = await providerService.getProviderById('codex');
      expect(codex.contextWindow).toBe(512000);
    });

    it('migrates legacy Gemini providers to Antigravity agy providers', async () => {
      await writeProvidersFile({
        activeProvider: 'gemini-cli',
        providers: {
          'gemini-cli': {
            id: 'gemini-cli',
            name: 'Gemini CLI',
            type: 'cli',
            command: 'gemini',
            // Both model spellings: `-m` is the legacy short form agy rejects
            // outright, `--model` is a form agy DOES accept — but pinned to a
            // Gemini id agy can't resolve, so the migration must drop it too.
            args: ['--yolo', '-m', 'gemini-2.5-pro', '--model', 'gemini-1.5-flash', '--output-format', 'text'],
            envVars: { GEMINI_SANDBOX: 'false', KEEP_ME: '1' },
            models: ['gemini-2.5-pro'],
            defaultModel: 'gemini-2.5-pro'
          },
          'gemini-tui': {
            id: 'gemini-tui',
            name: 'Gemini TUI',
            type: 'tui',
            command: 'gemini',
            args: ['--yolo'],
            envVars: { GEMINI_SANDBOX: 'false' },
          }
        }
      });

      const antigravity = await providerService.getProviderById('antigravity-cli');
      const antigravityTui = await providerService.getProviderById('antigravity-tui');
      const legacy = await providerService.getProviderById('gemini-cli');
      const active = await providerService.getActiveProvider();

      expect(active.id).toBe('antigravity-cli');
      expect(legacy).toBeNull();
      expect(antigravity.command).toBe('agy');
      // No `--model` survives: a Gemini id would break every agy run AND
      // permanently suppress PortOS's own model injection via hasModelFlag.
      expect(antigravity.args).toEqual(['--dangerously-skip-permissions', '--print']);
      expect(antigravity.args).not.toContain('--model');
      expect(antigravityTui.args).not.toContain('--model');
      expect(antigravity.defaultModel).toBe('antigravity-configured-default');
      expect(antigravity.contextWindow).toBe(1048576);
      expect(antigravity.envVars).toEqual({ KEEP_ME: '1' });
      expect(antigravityTui.command).toBe('agy');
      expect(antigravityTui.args).toEqual(['--dangerously-skip-permissions']);
      expect(antigravityTui.contextWindow).toBe(1048576);
      // agy takes a per-session --model, so the migrated provider ships the
      // selectable catalog alongside the sentinel.
      expect(antigravity.models[0]).toBe('antigravity-configured-default');
      expect(antigravity.models).toContain('gemini-3.1-pro-high');
    });

    it('widens a sentinel-only Antigravity model list to the selectable catalog', async () => {
      await writeProvidersFile({
        activeProvider: 'antigravity-cli',
        providers: {
          'antigravity-cli': {
            id: 'antigravity-cli',
            name: 'Antigravity CLI',
            type: 'cli',
            command: 'agy',
            contextWindow: 1048576,
            models: ['antigravity-configured-default'],
            defaultModel: 'antigravity-configured-default',
            lightModel: 'antigravity-configured-default'
          }
        }
      });

      const antigravity = await providerService.getProviderById('antigravity-cli');
      expect(antigravity.models.length).toBeGreaterThan(1);
      expect(antigravity.models[0]).toBe('antigravity-configured-default');
      expect(antigravity.models).toContain('claude-sonnet-4-6');
      // The *Model keys are untouched: an install that never picks a model keeps
      // agy's own configured default (no --model flag), exactly as before.
      expect(antigravity.defaultModel).toBe('antigravity-configured-default');
      expect(antigravity.lightModel).toBe('antigravity-configured-default');
    });

    // A failed `agy models` probe must be distinguishable from a real fetch.
    // Returning the shipped catalog here would persist it and toast "Models
    // refreshed", so a user whose service PATH can't resolve `agy` would pick a
    // model their plan may not have and only discover it when the run dies.
    it('reports a failed `agy models` probe as a refresh failure, leaving the stored list intact', async () => {
      const stored = ['antigravity-configured-default', 'gemini-3.1-pro-high'];
      await writeProvidersFile({
        activeProvider: 'antigravity-cli',
        providers: {
          'antigravity-cli': {
            id: 'antigravity-cli',
            name: 'Antigravity CLI',
            type: 'cli',
            command: '/nonexistent/path/to/agy',
            contextWindow: 1048576,
            models: [...stored],
            defaultModel: 'antigravity-configured-default'
          }
        }
      });

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      // Throws with the REAL reason (and a 502) rather than collapsing to null,
      // which the route would have reported as "Provider not found or not an
      // API type" — misleading, since the provider exists and its type is fine.
      await expect(providerService.refreshProviderModels('antigravity-cli'))
        .rejects.toThrow(/'\/nonexistent\/path\/to\/agy models' failed/);
      errSpy.mockRestore();

      // And the previously-stored list is untouched on disk.
      const after = await providerService.getProviderById('antigravity-cli');
      expect(after.models).toEqual(stored);
    });

    it('leaves a user-customized Antigravity model list alone', async () => {
      await writeProvidersFile({
        activeProvider: 'antigravity-cli',
        providers: {
          'antigravity-cli': {
            id: 'antigravity-cli',
            name: 'Antigravity CLI',
            type: 'cli',
            command: 'agy',
            contextWindow: 1048576,
            models: ['antigravity-configured-default', 'my-tuned-model'],
            defaultModel: 'my-tuned-model'
          }
        }
      });

      const antigravity = await providerService.getProviderById('antigravity-cli');
      expect(antigravity.models).toEqual(['antigravity-configured-default', 'my-tuned-model']);
    });
  });

  describe('testProvider — network layer (api type)', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('returns success shape when the api endpoint responds ok', async () => {
      const models = { data: [{ id: 'gpt-5' }, { id: 'gpt-4' }] };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => models,
      }));

      const p = await providerService.createProvider({
        name: 'Test API',
        type: 'api',
        endpoint: 'https://api.example.com/v1',
        apiKey: 'sk-test',
        // custom (non-allowlisted) host + secret ⇒ requires explicit opt-in
        allowCustomEndpoint: true,
      });

      const result = await providerService.testProvider(p.id);
      expect(result.success).toBe(true);
      expect(result.models).toEqual(['gpt-5', 'gpt-4']);
      expect(result.endpoint).toBe('https://api.example.com/v1');
    });

    it('returns failure shape when fetch rejects (e.g. timeout / network error)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('The operation was aborted.', 'TimeoutError')));

      const p = await providerService.createProvider({
        name: 'Stalled API',
        type: 'api',
        endpoint: 'https://stalled.example.com/v1',
      });

      const result = await providerService.testProvider(p.id);
      expect(result.success).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(result.error).toMatch(/API not reachable/);
    });

    it('blocks a keyed custom endpoint that has not opted in (SSRF / key exfil guard)', async () => {
      const spy = vi.fn();
      vi.stubGlobal('fetch', spy);

      const p = await providerService.createProvider({
        name: 'Hostile API',
        type: 'api',
        endpoint: 'https://evil.example.com/v1',
        apiKey: 'sk-secret',
      });

      const result = await providerService.testProvider(p.id);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Endpoint blocked/);
      // key must never leave the box — fetch is not even called
      expect(spy).not.toHaveBeenCalled();
    });

    it('returns failure shape when server responds with non-ok status', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
      }));

      const p = await providerService.createProvider({
        name: 'Unauthorized API',
        type: 'api',
        endpoint: 'https://auth.example.com/v1',
      });

      const result = await providerService.testProvider(p.id);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/API not reachable/);
    });
  });

  describe('Claude Ollama (ollama-backed) model refresh', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    // Mock fetch for an Ollama daemon: /api/tags lists models, /api/show reports
    // per-model capabilities. `caps[name]` controls which models report `tools`.
    const stubOllama = (names, caps) => {
      vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
        if (String(url).endsWith('/api/tags')) {
          return { ok: true, json: async () => ({ models: names.map((n) => ({ name: n })) }) };
        }
        if (String(url).endsWith('/api/show')) {
          const body = JSON.parse(opts?.body || '{}');
          const capabilities = caps[body.model];
          return { ok: true, json: async () => (capabilities ? { capabilities } : {}) };
        }
        return { ok: false, status: 404 };
      }));
    };

    it('pulls Ollama models filtered to tool-use-capable ones (by capabilities)', async () => {
      stubOllama(['qwen2.5:7b', 'gemma2:9b', 'llama3.1:8b'], {
        'qwen2.5:7b': ['completion', 'tools'],
        'gemma2:9b': ['completion', 'vision'],   // no tools → excluded
        'llama3.1:8b': ['completion', 'tools'],
      });

      const p = await providerService.createProvider({
        name: 'Claude Ollama (local model)',
        type: 'cli',
        command: 'claude',
        ollamaBacked: true,
        envVars: { ANTHROPIC_BASE_URL: 'http://localhost:11434', ANTHROPIC_AUTH_TOKEN: 'ollama' },
      });

      const updated = await providerService.refreshProviderModels(p.id);
      expect(updated).not.toBeNull();
      expect(updated.models).toEqual(['qwen2.5:7b', 'llama3.1:8b']);
    });

    it('falls back to the id heuristic when /api/show reports no capabilities', async () => {
      stubOllama(['qwen2.5:7b', 'gemma2:9b'], {}); // no capabilities reported for any

      const p = await providerService.createProvider({
        name: 'Claude Ollama',
        type: 'cli',
        command: 'claude',
        envVars: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434' },
      });

      const updated = await providerService.refreshProviderModels(p.id);
      // qwen matches the tool-use heuristic; gemma2 does not.
      expect(updated.models).toEqual(['qwen2.5:7b']);
    });

    it('refreshes models for an ollama-backed TUI provider too', async () => {
      stubOllama(['qwen2.5:7b', 'gemma2:9b'], {
        'qwen2.5:7b': ['completion', 'tools'],
        'gemma2:9b': ['completion', 'vision'],
      });

      const p = await providerService.createProvider({
        name: 'Claude Ollama TUI (local model)',
        type: 'tui',
        command: 'claude',
        ollamaBacked: true,
        envVars: { ANTHROPIC_BASE_URL: 'http://localhost:11434', ANTHROPIC_AUTH_TOKEN: 'ollama' },
      });

      const updated = await providerService.refreshProviderModels(p.id);
      expect(updated).not.toBeNull();
      expect(updated.models).toEqual(['qwen2.5:7b']);
    });

    it('reports a non-ollama-backed TUI provider as unsupported, not as missing', async () => {
      // A plain claude TUI provider has no Ollama backing and no catalog to
      // fetch. It must say THAT — not fall out as null and get rendered as
      // "Provider not found", which is false: it exists and its type is fine.
      const p = await providerService.createProvider({
        name: 'Claude Code TUI',
        type: 'tui',
        command: 'claude',
        models: ['claude-opus-4-8'],
      });

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const err = await providerService.refreshProviderModels(p.id).catch(e => e);
      errSpy.mockRestore();

      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/not supported for tui provider/i);
      expect(err.status).toBe(400);
      // The configured list is untouched.
      const after = await providerService.getProviderById(p.id);
      expect(after.models).toEqual(['claude-opus-4-8']);
    });

    it('returns null only for a provider that does not exist', async () => {
      // The one remaining meaning of null — what lets the route's 404 say
      // plainly "Provider not found" rather than guessing at a reason.
      expect(await providerService.refreshProviderModels('no-such-provider')).toBeNull();
    });

    describe('fetchProviderModels — the compute half, without the write', () => {
      const ollamaCli = {
        name: 'Claude Ollama (local model)',
        type: 'cli',
        command: 'claude',
        ollamaBacked: true,
        models: ['stale-model'],
        envVars: { ANTHROPIC_BASE_URL: 'http://localhost:11434' },
      };

      it('returns the probed list and leaves the stored one untouched', async () => {
        stubOllama(['qwen2.5:7b', 'gemma2:9b'], {
          'qwen2.5:7b': ['completion', 'tools'],
          'gemma2:9b': ['completion', 'vision'],
        });
        const p = await providerService.createProvider(ollamaCli);

        expect(await providerService.fetchProviderModels(p.id)).toEqual(['qwen2.5:7b']);
        // The whole point of the split: a caller can fan ONE probe out to
        // several providers itself, so this call must not have persisted.
        expect((await providerService.getProviderById(p.id)).models).toEqual(['stale-model']);
      });

      it('is what refreshProviderModels persists — the two halves cannot drift', async () => {
        stubOllama(['qwen2.5:7b', 'gemma2:9b'], {
          'qwen2.5:7b': ['completion', 'tools'],
          'gemma2:9b': ['completion', 'vision'],
        });
        const p = await providerService.createProvider(ollamaCli);

        const fetched = await providerService.fetchProviderModels(p.id);
        const persisted = await providerService.refreshProviderModels(p.id);
        expect(persisted.models).toEqual(fetched);
        expect((await providerService.getProviderById(p.id)).models).toEqual(fetched);
      });

      it('applying a fetched list to a SIBLING provider matches refreshing it directly', async () => {
        // The dedup path in localLlm.js: probe once through one member of a
        // group, then `updateProvider(id, { models })` every member.
        stubOllama(['qwen2.5:7b', 'gemma2:9b'], {
          'qwen2.5:7b': ['completion', 'tools'],
          'gemma2:9b': ['completion', 'vision'],
        });
        const lead = await providerService.createProvider({ ...ollamaCli, name: 'Lead Ollama' });
        const sibling = await providerService.createProvider({ ...ollamaCli, name: 'Sibling Ollama', type: 'tui' });

        const models = await providerService.fetchProviderModels(lead.id);
        const applied = await providerService.updateProvider(sibling.id, { models });
        const directly = await providerService.refreshProviderModels(sibling.id);

        expect(applied.models).toEqual(directly.models);
        // Every other field survives the apply — `updateProvider` spreads.
        expect(applied.ollamaBacked).toBe(true);
        expect(applied.id).toBe(sibling.id);
      });

      it('returns null only for a provider that does not exist', async () => {
        expect(await providerService.fetchProviderModels('no-such-provider')).toBeNull();
      });

      it('throws (does not return null) when the probe fails', async () => {
        const p = await providerService.createProvider(ollamaCli);
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 })));
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const err = await providerService.fetchProviderModels(p.id).catch(e => e);
        errSpy.mockRestore();

        expect(err).toBeInstanceOf(Error);
        expect(err.status).toBe(502);
        expect((await providerService.getProviderById(p.id)).models).toEqual(['stale-model']);
      });
    });

    // Pins the `provider.id === ANTIGRAVITY_TUI_ID` half of that arm's OR — the
    // same gap that was open on CURSOR_TUI_ID. Every other antigravity-TUI test
    // matches on the `agy` command, so deleting the id clause left the suite
    // green while a shipped antigravity-tui repointed at a wrapper lost refresh.
    it('reaches the agy fetcher for a shipped antigravity-tui repointed at a wrapper', async () => {
      await writeFile(join(TEST_DATA_DIR, 'providers.json'), JSON.stringify({
        activeProvider: 'antigravity-tui',
        providers: {
          'antigravity-tui': {
            id: 'antigravity-tui', name: 'Antigravity TUI', type: 'tui',
            command: '/nonexistent/path/to/agy-wrap', contextWindow: 1048576,
            models: ['antigravity-configured-default'],
            defaultModel: 'antigravity-configured-default',
          },
        },
      }, null, 2));

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const err = await providerService.refreshProviderModels('antigravity-tui').catch(e => e);
      errSpy.mockRestore();

      // Reached the agy fetcher (which then failed on the bogus path). Without
      // the id clause it would fall to the `else` and report "not supported".
      expect(err.message).toMatch(/agy-wrap models' failed/);
      expect(err.message).not.toMatch(/not supported/i);
    });
  });

  describe('Cursor Agent model refresh (`cursor-agent models`)', () => {
    // Stand in for the real binary with a script that prints a captured excerpt
    // of `cursor-agent models` — header line, blank line, `<id> - <Label>` rows,
    // trailing `Tip:` paragraph. Shell-script based, so POSIX only; CI is
    // ubuntu-latest and the assertions below are about parsing, not spawning.
    const writeFakeCursor = async (body) => {
      const path = join(TEST_DATA_DIR, 'cursor-agent');
      await writeFile(path, `#!/bin/sh\ncat <<'EOF'\n${body}\nEOF\n`);
      await chmod(path, 0o755);
      return path;
    };

    const SAMPLE = [
      'Available models',
      '',
      'auto - Auto (current, default)',
      'gpt-5.3-codex-low - Codex 5.3 Low',
      'gpt-5.3-codex-low-fast - Codex 5.3 Low Fast',
      'composer-2.5 - Composer 2.5',
      'claude-opus-5-thinking-high - Opus 5 1M Thinking',
      '',
      "Tip: use --model <id> (or /model <id> in interactive mode) to switch. Parameterized models also accept quoted overrides, e.g. --model 'claude-opus-4-8[context=1m,effort=high,fast=false]'.",
    ].join('\n');

    it.skipIf(process.platform === 'win32')('persists the live catalog for a cursor CLI provider', async () => {
      const command = await writeFakeCursor(SAMPLE);
      const p = await providerService.createProvider({
        name: 'Cursor Agent CLI',
        type: 'cli',
        command,
        models: ['auto', 'composer-2.5'],
        defaultModel: 'auto',
      });

      const updated = await providerService.refreshProviderModels(p.id);
      expect(updated).not.toBeNull();
      // The full list as reported — `-fast` priority-compute twins included, and
      // `auto` retained (cursor's real router id, not a synthetic sentinel).
      expect(updated.models).toEqual([
        'auto',
        'gpt-5.3-codex-low',
        'gpt-5.3-codex-low-fast',
        'composer-2.5',
        'claude-opus-5-thinking-high',
      ]);
    });

    it.skipIf(process.platform === 'win32')('refreshes a cursor TUI provider too', async () => {
      // `cursor-agent --model` applies to the interactive session as well, so
      // the TUI arm must reach the fetcher rather than no-op to null.
      const command = await writeFakeCursor(SAMPLE);
      const p = await providerService.createProvider({
        name: 'Cursor Agent TUI',
        type: 'tui',
        command,
        models: ['auto'],
        defaultModel: 'auto',
      });

      const updated = await providerService.refreshProviderModels(p.id);
      expect(updated).not.toBeNull();
      expect(updated.models).toContain('gpt-5.3-codex-low-fast');
    });

    // Pins the `provider.id === CURSOR_TUI_ID` half of the TUI arm's OR. Every
    // other test reaches that arm via the COMMAND (writeFakeCursor's script is
    // named `cursor-agent`), so deleting the id clause left the whole suite
    // green while this case — a shipped cursor-tui the user repointed at a
    // wrapper script — silently lost its refresh.
    it.skipIf(process.platform === 'win32')('refreshes a shipped cursor-tui repointed at a wrapper command', async () => {
      const cursorPath = await writeFakeCursor(SAMPLE);
      const wrapper = join(TEST_DATA_DIR, 'cursor-wrap');
      await writeFile(wrapper, `#!/bin/sh\nexec "${cursorPath}" "$@"\n`);
      await chmod(wrapper, 0o755);

      await writeFile(join(TEST_DATA_DIR, 'providers.json'), JSON.stringify({
        activeProvider: 'cursor-tui',
        providers: {
          'cursor-tui': {
            id: 'cursor-tui', name: 'Cursor Agent TUI', type: 'tui',
            command: wrapper, models: ['auto'], defaultModel: 'auto',
          },
        },
      }, null, 2));

      const updated = await providerService.refreshProviderModels('cursor-tui');
      expect(updated, 'the id clause on the TUI arm no longer matches').not.toBeNull();
      expect(updated.models).toContain('gpt-5.3-codex-low');
    });

    // The mirror of the cursor ordering fix, for antigravity: its COMMAND test
    // used to sit fused to its name test BELOW the claude name test, so an `agy`
    // provider named "Antigravity Claude Sonnet 4.6" (a natural name — agy's own
    // catalog carries claude ids) got Anthropic's static list persisted onto it
    // and lost the configured-default sentinel while defaultModel still pointed
    // at it, blanking the model <select>.
    it('routes an agy provider on its command even when the NAME says claude', async () => {
      const stored = ['antigravity-configured-default', 'gemini-3.1-pro-high'];
      await writeFile(join(TEST_DATA_DIR, 'providers.json'), JSON.stringify({
        activeProvider: 'antigravity-cli',
        providers: {
          'antigravity-cli': {
            id: 'antigravity-cli', name: 'Antigravity Claude Sonnet 4.6', type: 'cli',
            command: '/nonexistent/path/to/agy', contextWindow: 1048576,
            models: [...stored], defaultModel: 'antigravity-configured-default',
          },
        },
      }, null, 2));

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const err = await providerService.refreshProviderModels('antigravity-cli').catch(e => e);
      errSpy.mockRestore();

      // Reached the AGY fetcher (which then failed on the bogus path) rather
      // than _fetchAnthropicModels, which would have succeeded and persisted
      // claude ids onto an agy provider.
      expect(err.message).toMatch(/agy models' failed/);
      const after = await providerService.getProviderById('antigravity-cli');
      expect(after.models).toEqual(stored);
      expect(after.models[0]).toBe('antigravity-configured-default');
    });

    // The name test still applies once no command has claimed the provider, and
    // a `claude` command still beats an "antigravity" name — the split must not
    // invert that.
    it('still routes a claude-commanded provider named "antigravity" to Anthropic', async () => {
      const p = await providerService.createProvider({
        name: 'Claude via Antigravity', type: 'cli', command: 'claude', models: ['x'],
      });
      const updated = await providerService.refreshProviderModels(p.id);
      expect(updated).not.toBeNull();
      expect(updated.models).toContain('claude-opus-5');
      expect(updated.models).not.toContain('antigravity-configured-default');
    });

    // …and the residual NAME half of that same split is pinned too. Left
    // unpinned, a future cleanup deletes it as apparently-redundant while the
    // client's mirrored `name.includes('antigravity')` keeps offering the
    // button — every click then 400s. That is precisely the client/server drift
    // the parity apparatus exists to prevent.
    it('still routes an antigravity-NAMED provider with an unrelated command to the agy fetcher', async () => {
      const p = await providerService.createProvider({
        name: 'Antigravity Nightly', type: 'cli', command: '/nonexistent/path/to/weird-wrapper', models: ['x'],
      });

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const err = await providerService.refreshProviderModels(p.id).catch(e => e);
      errSpy.mockRestore();

      expect(err.message).toMatch(/weird-wrapper models' failed/);
      expect(err.message).not.toMatch(/not supported/i);
    });

    // A failed `cursor-agent models` probe must be distinguishable from a real
    // fetch. Returning the shipped 27-id seed here would persist it and toast
    // "Models refreshed", so a user whose service PATH can't resolve the binary
    // would pick a model their account may not have and only discover it when
    // the run dies.
    it('reports a failed probe as a refresh failure, leaving the stored list intact', async () => {
      const stored = ['auto', 'composer-2.5'];
      const p = await providerService.createProvider({
        name: 'Cursor Agent CLI',
        type: 'cli',
        command: '/nonexistent/path/to/cursor-agent',
        models: [...stored],
        defaultModel: 'auto',
      });

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      // The thrown message names the binary and the spawn failure, so the user's
      // toast says why — not "Provider not found or not an API type".
      const err = await providerService.refreshProviderModels(p.id).catch(e => e);
      errSpy.mockRestore();

      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/'\/nonexistent\/path\/to\/cursor-agent models' failed/);
      expect(err.status).toBe(502);
      const after = await providerService.getProviderById(p.id);
      expect(after.models).toEqual(stored);
    });

    it.skipIf(process.platform === 'win32')('treats a prose-only response as a failure, not an empty catalog', async () => {
      // e.g. an auth/upgrade banner printed in place of the list. Persisting []
      // here would silently empty the user's model picker.
      const stored = ['auto', 'composer-2.5'];
      const command = await writeFakeCursor('Please run cursor-agent login first.');
      const p = await providerService.createProvider({
        name: 'Cursor Agent CLI',
        type: 'cli',
        command,
        models: [...stored],
        defaultModel: 'auto',
      });

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(providerService.refreshProviderModels(p.id))
        .rejects.toThrow(/returned no model ids/);
      errSpy.mockRestore();

      const after = await providerService.getProviderById(p.id);
      expect(after.models).toEqual(stored);
    });

    // Regression: the command-keyed cursor branch must sit ABOVE the
    // name-substring branches. When it sat below them, a cursor provider the
    // user renamed "Cursor Claude Opus" matched `name.includes('claude')` first
    // and had Anthropic's 15 static ids persisted onto it — ids cursor-agent
    // rejects — written silently, because the client's gate is command-keyed and
    // showed the Refresh button.
    it.skipIf(process.platform === 'win32')('routes on the command even when the NAME contains another vendor', async () => {
      const command = await writeFakeCursor(SAMPLE);
      for (const name of ['Cursor Claude Opus', 'Cursor Antigravity', 'Cursor Gemini 3.5']) {
        const p = await providerService.createProvider({
          name, type: 'cli', command, models: ['auto'], defaultModel: 'auto',
        });
        const updated = await providerService.refreshProviderModels(p.id);
        expect(updated, `${name}: refresh returned null`).not.toBeNull();
        expect(updated.models, `${name}: got another vendor's catalog`).toContain('gpt-5.3-codex-low');
        expect(updated.models).not.toContain('claude-opus-5');
      }
    });

    it('does not hijack an unrelated provider that merely has "cursor" in its name', async () => {
      // The cursor arm is command-keyed on purpose — "cursor" is an ordinary
      // English word, so a name test would claim a refresh for a provider whose
      // binary knows nothing about `models`.
      const p = await providerService.createProvider({
        name: 'Cursor Notes',
        type: 'cli',
        command: 'some-other-binary',
        models: ['x'],
      });

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const err = await providerService.refreshProviderModels(p.id).catch(e => e);
      errSpy.mockRestore();

      // Falls through to the 'not supported for this CLI provider' throw — 400,
      // not the 502 default, because nothing upstream failed.
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/not supported/i);
      expect(err.status).toBe(400);
    });
  });

  describe('_refreshAPIProviderModels — network layer', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('uses data.models shape for Ollama endpoint', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ models: [{ name: 'llama3.2' }, { name: 'mistral' }] }),
      }));

      const p = await providerService.createProvider({
        name: 'Ollama',
        type: 'api',
        endpoint: 'http://localhost:11434',
      });

      const updated = await providerService.refreshProviderModels(p.id);
      expect(updated).not.toBeNull();
      expect(updated.models).toEqual(['llama3.2', 'mistral']);
    });

    it('uses data.data shape for generic OpenAI-compatible endpoint', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: 'model-a' }, { id: 'model-b' }] }),
      }));

      const p = await providerService.createProvider({
        name: 'Generic API',
        type: 'api',
        endpoint: 'https://api.generic.com/v1',
        apiKey: 'sk-key',
        // custom (non-allowlisted) host + secret ⇒ requires explicit opt-in
        allowCustomEndpoint: true,
      });

      const updated = await providerService.refreshProviderModels(p.id);
      expect(updated).not.toBeNull();
      expect(updated.models).toEqual(['model-a', 'model-b']);
    });

    it('throws the reason when the generic endpoint rejects (timeout / unreachable)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('The operation was aborted.', 'TimeoutError')));

      const p = await providerService.createProvider({
        name: 'Unreachable API',
        type: 'api',
        endpoint: 'https://dead.example.com/v1',
      });

      // Surfaced, not collapsed to null — `null` means "no refreshable branch
      // matched" and the route renders it as "Provider not found or not an API
      // type", which is false here: the provider exists and IS an API type.
      // Pairs with the next test: a FAILED fetch throws, a legitimately EMPTY
      // one persists. Those two must never share a return value.
      const err = await providerService.refreshProviderModels(p.id).catch(e => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.status).toBe(502);
    });

    it('persists a legitimately empty model list rather than treating it as a failed fetch', async () => {
      // The last installed Ollama model was just deleted — /api/tags succeeds
      // with zero entries. This must NOT collapse into the same `null` result
      // as an unreachable endpoint, or a deleted model stays stuck in the
      // provider's persisted list forever.
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ models: [] }),
      }));

      const p = await providerService.createProvider({
        name: 'Ollama',
        type: 'api',
        endpoint: 'http://localhost:11434',
        models: ['llama3.2'], // stale — the model was just deleted
      });

      const updated = await providerService.refreshProviderModels(p.id);
      expect(updated).not.toBeNull();
      expect(updated.models).toEqual([]);
    });

    it('accepts bare-string data entries and throws on entries with no usable id', async () => {
      // Some OpenAI-compatible servers emit `data: ["model-a"]` rather than
      // `data: [{ id: 'model-a' }]`. Mapping `m.id` blindly persisted
      // `[undefined]` — a plausible-looking, unusable catalog.
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: ['model-a', { name: 'model-b' }] }),
      }));
      const ok = await providerService.createProvider({
        name: 'Bare List API', type: 'api', endpoint: 'https://api.generic.com/v1', allowCustomEndpoint: true,
      });
      expect((await providerService.refreshProviderModels(ok.id)).models).toEqual(['model-a', 'model-b']);

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ object: 'model' }] }),
      }));
      const bad = await providerService.createProvider({
        name: 'Idless API', type: 'api', endpoint: 'https://api.generic.com/v1', models: ['model-a'], allowCustomEndpoint: true,
      });
      const err = await providerService.refreshProviderModels(bad.id).catch(e => e);
      expect(err.message).toMatch(/no usable model id/);
      expect((await providerService.getProviderById(bad.id)).models).toEqual(['model-a']);
    });

    it('normalizes object entries under "models" the same way as "data"', async () => {
      // A non-Ollama gateway keying `models` with objects used to persist the raw
      // objects as if they were model ids.
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ models: [{ id: 'model-a' }, 'model-b', { model: 'model-c' }] }),
      }));
      const ok = await providerService.createProvider({
        name: 'Models Key API', type: 'api', endpoint: 'https://api.generic.com/v1', allowCustomEndpoint: true,
      });
      expect((await providerService.refreshProviderModels(ok.id)).models).toEqual(['model-a', 'model-b', 'model-c']);

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ models: [null] }),
      }));
      const bad = await providerService.createProvider({
        name: 'Null Models API', type: 'api', endpoint: 'https://api.generic.com/v1', models: ['model-a'], allowCustomEndpoint: true,
      });
      const err = await providerService.refreshProviderModels(bad.id).catch(e => e);
      expect(err.message).toMatch(/"models" entries with no usable model id/);
      expect((await providerService.getProviderById(bad.id)).models).toEqual(['model-a']);
    });

    it('throws and leaves the stored list untouched when a 200 body is not JSON', async () => {
      // A captive portal / login page / proxy error served as HTTP 200. Degrading
      // to `[]` here emptied the model dropdown while the UI toasted "Models
      // refreshed" — indistinguishable from the legitimately-empty case above.
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); },
      }));

      const p = await providerService.createProvider({
        name: 'Garbled API',
        type: 'api',
        endpoint: 'https://api.generic.com/v1',
        models: ['model-a', 'model-b'],
        allowCustomEndpoint: true,
      });

      const err = await providerService.refreshProviderModels(p.id).catch(e => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.status).toBe(502);
      expect(err.message).toMatch(/not valid JSON/);
      expect((await providerService.getProviderById(p.id)).models).toEqual(['model-a', 'model-b']);
    });

    it('throws and leaves the stored list untouched when a 200 body has no recognizable shape', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ object: 'error', message: 'invalid api key' }),
      }));

      const p = await providerService.createProvider({
        name: 'Shapeless API',
        type: 'api',
        endpoint: 'https://api.generic.com/v1',
        models: ['model-a'],
        allowCustomEndpoint: true,
      });

      const err = await providerService.refreshProviderModels(p.id).catch(e => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.status).toBe(502);
      expect(err.message).toMatch(/data.*models/);
      expect((await providerService.getProviderById(p.id)).models).toEqual(['model-a']);
    });
  });

  describe('reserved-key prototype safety (#2521)', () => {
    it('does not resolve Object.prototype members as existing providers', async () => {
      // The providers map is null-prototyped on load, so a keyed lookup for an
      // inherited member returns "not found" rather than a truthy prototype fn.
      for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
        expect(await providerService.getProviderById(key)).toBeNull();
        expect(await providerService.setActiveProvider(key)).toBeNull();
        expect(await providerService.updateProvider(key, { name: 'x' })).toBeNull();
        expect(await providerService.deleteProvider(key)).toBe(false);
      }
      const { activeProvider } = await providerService.getAllProviders();
      expect(['__proto__', 'constructor', 'toString', 'hasOwnProperty']).not.toContain(activeProvider);
    });
  });
});

describe('isOllamaBackedProvider', () => {
  it('matches the built-in ollama API provider by id, regardless of endpoint/envVars', () => {
    expect(isOllamaBackedProvider({ id: 'ollama', type: 'api', endpoint: 'http://localhost:11434/v1', envVars: {} })).toBe(true);
  });

  it('matches an api-type provider whose endpoint points at an Ollama daemon', () => {
    expect(isOllamaBackedProvider({ id: 'local-llm', type: 'api', endpoint: 'http://192.168.1.5:11434/v1' })).toBe(true);
    expect(isOllamaBackedProvider({ id: 'renamed', type: 'api', endpoint: 'https://my-ollama-box.example.com/v1' })).toBe(true);
  });

  it('matches a cli/tui provider carrying the ollamaBacked marker or an Ollama ANTHROPIC_BASE_URL', () => {
    expect(isOllamaBackedProvider({ id: 'claude-ollama', type: 'tui', ollamaBacked: true })).toBe(true);
    expect(isOllamaBackedProvider({ id: 'claude', type: 'cli', envVars: { ANTHROPIC_BASE_URL: 'http://localhost:11434' } })).toBe(true);
  });

  it('does not match a cloud provider with an unrelated endpoint', () => {
    expect(isOllamaBackedProvider({ id: 'anthropic', type: 'api', endpoint: 'https://api.anthropic.com' })).toBe(false);
    expect(isOllamaBackedProvider({ id: 'openai', type: 'api', endpoint: 'https://api.openai.com/v1' })).toBe(false);
  });

  it('handles missing/null provider input without throwing', () => {
    expect(isOllamaBackedProvider(null)).toBe(false);
    expect(isOllamaBackedProvider(undefined)).toBe(false);
    expect(isOllamaBackedProvider({})).toBe(false);
  });
});
