import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { createProviderService } from './providers.js';

const TEST_DATA_DIR = join(process.cwd(), 'test-data');

describe('Provider Service', () => {
  let providerService;

  beforeEach(async () => {
    // Create test data directory
    if (!existsSync(TEST_DATA_DIR)) {
      await mkdir(TEST_DATA_DIR, { recursive: true });
    }

    providerService = createProviderService({
      dataDir: TEST_DATA_DIR,
      providersFile: 'providers.json'
    });
  });

  afterEach(async () => {
    // Clean up test data
    if (existsSync(TEST_DATA_DIR)) {
      await rm(TEST_DATA_DIR, { recursive: true });
    }
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
            args: ['--yolo', '-m', 'gemini-2.5-pro', '--output-format', 'text'],
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
      expect(antigravity.args).toEqual(['--dangerously-skip-permissions', '--print']);
      expect(antigravity.defaultModel).toBe('antigravity-configured-default');
      expect(antigravity.contextWindow).toBe(1048576);
      expect(antigravity.envVars).toEqual({ KEEP_ME: '1' });
      expect(antigravityTui.command).toBe('agy');
      expect(antigravityTui.args).toEqual(['--dangerously-skip-permissions']);
      expect(antigravityTui.contextWindow).toBe(1048576);
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

    it('does not refresh a non-ollama-backed TUI provider (returns null)', async () => {
      // A plain claude TUI provider has no Ollama backing — refresh is a no-op
      // for tui type, so it returns null (models left as configured).
      const p = await providerService.createProvider({
        name: 'Claude Code TUI',
        type: 'tui',
        command: 'claude',
        models: ['claude-opus-4-8'],
      });

      const updated = await providerService.refreshProviderModels(p.id);
      expect(updated).toBeNull();
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

    it('returns null when the generic endpoint rejects (timeout / unreachable)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('The operation was aborted.', 'TimeoutError')));

      const p = await providerService.createProvider({
        name: 'Unreachable API',
        type: 'api',
        endpoint: 'https://dead.example.com/v1',
      });

      const result = await providerService.refreshProviderModels(p.id);
      expect(result).toBeNull();
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
