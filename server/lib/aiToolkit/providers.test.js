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
});
