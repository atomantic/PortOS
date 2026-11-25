/**
 * Every row of the local-runtime registry must flow through every consumer with no other edit:
 * adding an eighth runtime to `localRuntimeMarkers.js` makes each of these hold or fails here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_RUNTIME_MARKERS, hasLocalRuntimeMarker } from '../aiToolkit/internal/localRuntimeMarkers.js';
import { createProviderService } from '../aiToolkit/providers.js';
import { providerSchema } from '../aiToolkit/validation.js';
import { resolveModelFetcher } from '../aiToolkit/internal/modelFetchers.js';
import { apiGenerationOptions } from '../aiToolkit/internal/generationOptions.js';
import { isFreeProvider } from '../modelPricing.js';
import { familyForProvider } from './providerFamilies.js';
import { getOpencodeLocalProviderNamespace, localRuntimeNamespace } from './providerModels.js';
import { BACKEND_MARKER_KEYS } from './providerRouteRecipes.js';
import { cliProviderAuthDescriptor } from '../processEnv.js';

describe.each(Object.entries(LOCAL_RUNTIME_MARKERS))('local runtime %s (%s)', (id, marker) => {
  let dataDir;
  beforeEach(async () => { dataDir = await mkdtemp(join(tmpdir(), 'portos-runtime-marker-')); });
  afterEach(() => rm(dataDir, { recursive: true, force: true }));

  it('is accepted by the provider schema and round-trips through the provider record', async () => {
    expect(providerSchema.safeParse({ name: 'X', type: 'cli', [marker]: true }).success).toBe(true);
    expect(providerSchema.safeParse({ name: 'X', type: 'cli', [marker]: 'true' }).success).toBe(false);
    const service = createProviderService({ dataDir, providersFile: 'providers.json' });
    const created = await service.createProvider({ name: 'Wrapper', type: 'cli', command: 'example', [marker]: true });
    expect((await service.getProviderById(created.id))[marker]).toBe(true);
    const plain = await service.createProvider({ name: 'Plain', type: 'cli', command: 'example' });
    expect(Object.hasOwn(await service.getProviderById(plain.id), marker)).toBe(false);
  });

  it('resolves to its id everywhere a provider is classified', () => {
    const record = { id: 'wrapper', type: 'cli', command: 'opencode', [marker]: true };
    expect(hasLocalRuntimeMarker(record)).toBe(true);
    expect(getOpencodeLocalProviderNamespace(record)).toBe(id);
    expect(localRuntimeNamespace(record)).toBe(id);
    expect(isFreeProvider(record)).toBe(true);
    expect(familyForProvider(record)).toBeNull();
    expect(BACKEND_MARKER_KEYS).toContain(marker);
    expect(cliProviderAuthDescriptor(record)).toMatchObject({ [marker]: true, authOnly: true });
    expect(apiGenerationOptions({ type: 'api', [marker]: true, temperature: 0.5 })).toMatchObject({ temperature: 0.5 });
  });

  it('is claimed by a model fetcher for a cli and a tui record', () => {
    for (const type of ['cli', 'tui']) {
      expect(resolveModelFetcher({ id: 'wrapper', type, command: 'opencode', [marker]: true })).not.toBeNull();
    }
  });
});
