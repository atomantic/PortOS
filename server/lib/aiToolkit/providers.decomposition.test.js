import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createProviderService } from './providers.js';

const here = dirname(fileURLToPath(import.meta.url));
const source = (name) => readFileSync(join(here, name), 'utf8');
const methodNames = [
  'getAllProviders', 'getProviderById', 'getActiveProvider', 'setActiveProvider',
  'createProvider', 'createProviderModes', 'createProviderTuiMode', 'updateProvider',
  'applyProviderPatches', 'deleteProvider', 'testProvider', 'fetchProviderModelCatalog',
  'fetchProviderModels', 'refreshProviderModels', 'refreshProviderModelsBatch',
  '_refreshAPIProviderModels', '_fetchMtplxModels', '_withCachedCheckpoints',
  '_fetchLmstudioModels', '_fetchLlamaModels', '_fetchVllmModels', '_fetchSglangModels',
  '_fetchGatewayModels', '_refreshCLIProviderModels', '_fetchAntigravityModels',
  '_execCliModelList', '_fetchPiModels', '_fetchCursorModels', '_fetchCodexModels',
  '_fetchOllamaToolCapableModels', '_fetchAnthropicModels', '_claudeCliVersion',
  '_fetchGeminiModels', 'getSampleProviders',
];

describe('provider service decomposition', () => {
  let dataDir;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it('keeps the facade method surface and cross-method spy dispatch', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'portos-provider-decomposition-'));
    const service = createProviderService({ dataDir, providersFile: 'providers.json' });
    expect(Object.keys(service)).toEqual(methodNames);

    const provider = await service.createProvider({ name: 'Example', type: 'cli', command: 'example' });
    const fetch = vi.spyOn(service, 'fetchProviderModelCatalog').mockResolvedValue({
      models: ['fresh'],
      contextWindows: { fresh: 4096 },
    });
    const updated = await service.refreshProviderModels(provider.id);

    expect(fetch).toHaveBeenCalledWith(provider.id);
    expect(updated.models).toEqual(['fresh']);
    expect((await service.getProviderById(provider.id)).modelContextWindows).toEqual({ fresh: 4096 });
  });

  it('keeps CRUD and catalog responsibilities in private factories', async () => {
    const facade = source('providers.js');
    const state = source('internal/providerServiceState.js');
    const crud = source('internal/providerCrudService.js');
    const catalog = source('internal/providerCatalogService.js');

    expect(facade).toContain('createProviderServiceState');
    expect(facade).toContain('createProviderCrudService');
    expect(facade).toContain('createProviderCatalogService');
    expect(facade).not.toContain('async fetchProviderModelCatalog');
    expect(facade).not.toContain('async createProvider');
    expect(state).toContain('export function createProviderServiceState');
    expect(state).toContain('async function loadProviders');
    expect(state).toContain('async function saveProviders');
    expect(crud).toContain('export function createProviderCrudService');
    expect(crud).toContain('async getAllProviders');
    expect(crud).toContain('async updateProvider');
    expect(crud).not.toContain('async fetchProviderModelCatalog');
    expect(catalog).toContain('export function createProviderCatalogService');
    expect(catalog).toContain('async fetchProviderModelCatalog');
    expect(catalog).toContain('async getSampleProviders');
    expect(catalog).not.toContain('async updateProvider');
    expect(facade).not.toMatch(/\bclass\s/);
    expect(state).not.toMatch(/\bclass\s/);
    expect(crud).not.toMatch(/\bclass\s/);
    expect(catalog).not.toMatch(/\bclass\s/);
  });
});
