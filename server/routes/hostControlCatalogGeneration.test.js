import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { expectAuthorizedWorkflows } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-catalog-authority-') }));
afterAll(cleanupTempDataRoots);

// Catalog generation (#10891) and every other Catalog write are gated by the
// default-deny policy (#16018); the refusal and principal matrix live in
// services/authGate.test.js and server/test/guards/modules/hostControlCoverage.test.js. The extraction
// provider dispatch is doubled at its service.
const auth = vi.hoisted(() => ({ enabled: false }));
const effects = vi.hoisted(() => ({ extract: vi.fn(async () => ({ scrap: { id: 'example-scrap' }, draft: {} })) }));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(), getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/catalog/catalogDB.js', () => ({
  getScrap: vi.fn(async () => ({ id: 'example-scrap', rawText: 'Example text', parentScrapId: null })),
}));
vi.mock('../services/catalog/catalogExtraction.js', () => ({ extractIngredientsForScrap: effects.extract }));
// Service graphs the router imports; their handlers are not reached.
vi.mock('../services/catalog/catalogPrune.js', () => ({}));
vi.mock('../services/catalog/catalogGreybox.js', () => ({}));
vi.mock('../services/catalog/catalogMediaRefinement.js', () => ({}));
vi.mock('../services/catalog/catalogIngestSources.js', () => ({}));

const mounts = [['/api/catalog', (await import('./catalog.js')).default]];

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('Catalog router behind the default-deny gate (#16114)', () => {
  it('still extracts with the pinned provider for a local operator and a delegated agent session', async () => {
    await expectAuthorizedWorkflows({ auth, mounts, workflows: [
      ['post', '/api/catalog/scraps/example-scrap/extract',
        { providerOverride: 'example-cli', modelOverride: 'example-model' }, effects.extract, 200],
    ] });
    expect(effects.extract).toHaveBeenLastCalledWith(expect.objectContaining({
      scrapId: 'example-scrap', providerOverride: 'example-cli', modelOverride: 'example-model',
    }));
  });
});
