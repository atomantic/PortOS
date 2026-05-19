import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

    it('rewrites legacy codex models/defaultModel to the sentinel on first read', async () => {
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
      expect(codex.models).toEqual([CODEX_SENTINEL]);
      expect(codex.defaultModel).toBe(CODEX_SENTINEL);
      expect(codex.lightModel).toBe(CODEX_SENTINEL);
      expect(codex.mediumModel).toBe(CODEX_SENTINEL);
      expect(codex.heavyModel).toBe(CODEX_SENTINEL);

      const onDisk = await readProvidersFile();
      expect(onDisk.providers.codex.defaultModel).toBe(CODEX_SENTINEL);
      expect(onDisk.providers.codex.models).toEqual([CODEX_SENTINEL]);
    });

    it('is idempotent — already-migrated codex configs are not rewritten', async () => {
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
            heavyModel: CODEX_SENTINEL
          }
        }
      });

      const { statSync } = await import('fs');
      const path = join(TEST_DATA_DIR, 'providers.json');
      const mtimeBefore = statSync(path).mtimeMs;

      await new Promise((resolve) => setTimeout(resolve, 10));

      await providerService.getProviderById('codex');
      const mtimeAfter = statSync(path).mtimeMs;
      expect(mtimeAfter).toBe(mtimeBefore);
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

    it('handles partial migration (only defaultModel pinned, models[] already sentinel)', async () => {
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
      expect(codex.defaultModel).toBe(CODEX_SENTINEL);
    });
  });
});
