import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { callRoute, expectAuthorizedWorkflows, expectRemoteRefusal, hostControlApp } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// Production router composition and auth gates; double the effect boundaries
// so refusal proves that no provider, queue, store or image lookup was reached.
const auth = vi.hoisted(() => ({ enabled: false }));
const effects = vi.hoisted(() => Object.fromEntries([
  'expand', 'variations', 'refine', 'promote', 'sort', 'extract', 'refineCharacter',
  'expandCharacter', 'reviewCast', 'augment', 'differentiate', 'mergeAI',
  'describe', 'expandImages', 'correctImage', 'analyzeStyle', 'render',
  'persistIds', 'update', 'get', 'merge', 'applyImage', 'applyAugment', 'backfill',
  'lock', 'gallery', 'create', 'delete', 'listRuns',
].map(name => [name, vi.fn(async () => ({ id: 'example-world', name: 'Example World' }))])));
vi.mock('../lib/fileUtils.js', async (importOriginal) => ({
  ...makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-universe-authority-') }),
  resolveGalleryImage: (...args) => effects.gallery(...args),
}));
afterAll(cleanupTempDataRoots);
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyPassword: vi.fn(async () => true),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(), getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/instanceIdentity.js', () => ({
  loadData: vi.fn(async () => ({ peers: [{
    id: 'example-peer', instanceId: 'example-instance', enabled: true, syncSecret: 'a'.repeat(32),
  }] })),
}));
vi.mock('../services/universeBuilder.js', async () => ({
  ...await import('../services/universeBuilder/sanitize.js'),
  getUniverse: effects.get, updateUniverse: effects.update, createUniverse: effects.create,
  deleteUniverse: effects.delete, listRuns: effects.listRuns,
  needsEntryIdPersist: effects.persistIds,
}));
vi.mock('../services/universeBuilderExpand.js', () => ({
  expandWorldTemplate: effects.expand, generateCategoryVariations: effects.variations,
}));
vi.mock('../services/universeBuilderRefine.js', () => ({ refineWorldPrompts: effects.refine }));
vi.mock('../services/universeBuilderPromote.js', () => ({
  VALID_TARGET_KINDS: ['characters', 'places', 'objects'], promoteVariationToCanon: effects.promote,
}));
vi.mock('../services/universeBuilderAutoSort.js', () => ({ autoSortOtherBuckets: effects.sort }));
vi.mock('../services/universeCanon.js', () => ({
  DESC_LIMIT: { character: 4000, place: 4000, object: 4000 },
  extractCanonFromProse: effects.extract, refineUniverseCharacter: effects.refineCharacter,
  differentiateUniverseCast: effects.differentiate, applyCanonImageCorrection: effects.applyImage,
  setCanonEntryLock: effects.lock,
}));
vi.mock('../services/universeCharacterExpand.js', () => ({ expandUniverseCharacter: effects.expandCharacter }));
vi.mock('../services/universeCastIntegrity.js', () => ({
  getUniverseCastIntegrity: vi.fn(), reviewUniverseCast: effects.reviewCast,
  proposeCharacterAugmentation: effects.augment, applyCharacterAugmentation: effects.applyAugment,
}));
vi.mock('../services/canonUsage.js', () => ({ getUniverseCanonUsage: vi.fn(), listLinkedSeriesNames: vi.fn() }));
vi.mock('../services/recordMerge.js', () => ({ mergeUniverses: effects.merge, buildCascadeContext: () => null }));
vi.mock('../services/recordMergeAI.js', () => ({ mergeFieldsWithAI: effects.mergeAI }));
vi.mock('../services/duplicateDetection.js', () => ({
  findDuplicateUniverseGroups: vi.fn(async () => []), findSameNameUniverses: vi.fn(async () => []),
}));
vi.mock('../services/universeVisionDescribe.js', () => ({
  VISION_KINDS: ['character', 'place', 'object'], VISION_MAX_IMAGES: 8,
  describeEntityFromImages: effects.describe, correctEntityFromImage: effects.correctImage,
}));
vi.mock('../services/universeVisionExpand.js', () => ({
  VISION_EXPAND_MAX_IMAGES: 8, expandEntityFromImages: effects.expandImages,
}));
vi.mock('../services/universeStyleReference.js', () => ({ analyzeUniverseStyleReference: effects.analyzeStyle }));
vi.mock('../services/universeBuilderRender.js', () => ({ renderUniverseJobs: effects.render }));
vi.mock('../services/universeGraph.js', () => ({ buildUniverseGraph: vi.fn() }));

import universeRoutes from './universeBuilder/index.js';

const base = '/api/universe-builder';
const world = `${base}/example-world`;
const character = `${world}/characters/example-character`;
const picker = { providerId: 'example-cli', model: 'example-model' };
const images = [{ source: 'gallery', filename: 'example.png' }];
const generation = [
  ['post', `${base}/expand`, { starterPrompt: 'Example starter', ...picker }, effects.expand, 200],
  ['post', `${base}/generate-variations`, { category: 'landscapes', count: 1, ...picker }, effects.variations, 200],
  ['post', `${base}/refine-prompts`, { starterPrompt: 'Example starter', feedback: 'Example feedback', image: 'example.png', ...picker }, effects.refine, 200],
  ['post', `${world}/promote-variation`, { category: 'landscapes', label: 'Example landscape', ...picker }, effects.promote, 200],
  ['post', `${world}/auto-sort`, picker, effects.sort, 200],
  ['post', `${world}/extract-canon`, { corpus: 'Example prose', providerOverride: picker.providerId }, effects.extract, 200],
  ['post', `${character}/refine`, picker, effects.refineCharacter, 200],
  ['post', `${character}/expand`, picker, effects.expandCharacter, 200],
  ['post', `${world}/characters/integrity/review`, picker, effects.reviewCast, 200],
  ['post', `${character}/augment`, { fields: ['motivations'], ...picker }, effects.augment, 200],
  ['post', `${world}/characters/differentiate-cast`, picker, effects.differentiate, 200],
  ['post', `${base}/merge/ai-resolve`, { survivorId: 'example-world', loserId: 'example-other-world', fields: ['premise'], ...picker }, effects.mergeAI, 200],
  ['post', `${base}/describe-from-images`, { kind: 'character', images, ...picker }, effects.describe, 200],
  ['post', `${character}/expand-from-images`, { images, ...picker }, effects.expandImages, 200],
  ['post', `${world}/canon/character/example-character/correct-from-image`, { image: 'example.png', ...picker }, effects.correctImage, 200],
  ['post', `${base}/analyze-style-reference`, { image: 'example.png', prompt: 'Example style', ...picker }, effects.analyzeStyle, 200],
  ['post', `${world}/render`, { mode: 'codex', extraStyle: 'Example style' }, effects.render, 200],
];
const mounts = [[base, universeRoutes]];

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
  effects.gallery.mockImplementation(filename => `/example/images/${filename}`);
  // Exercise the batch route's pre-queue migration write as well as rendering.
  effects.persistIds.mockResolvedValue(true);
});

describe('Universe Builder agent workflows behind the default-deny gate (#10669, #16114)', () => {
  it('refuses a remote caller before any provider, queue, store or image effect, even for an API-first request', async () => {
    const [, path, body] = generation[0];
    await expectRemoteRefusal(mounts, ['post', path, { ...body, providerId: 'example-api' }, effects.expand]);
    for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
  });

  it('still runs the agent workflows, record CRUD, proposal application, merge, locks and backfill for local and agent callers', async () => {
    const merge = { survivorId: 'example-world', loserId: 'example-other-world' };
    await expectAuthorizedWorkflows({ auth, mounts, workflows: [
      ...generation,
      ['post', base, { name: 'Example World' }, effects.create, 201],
      ['patch', world, { premise: 'Example premise' }, effects.update, 200],
      ['delete', world, undefined, effects.delete, 200],
      ['post', `${base}/merge`, merge, effects.merge, 200],
      ['post', `${world}/canon/character/example-character/apply-image-correction`, { description: 'Example corrected', imageFilename: 'example.png' }, effects.applyImage, 200],
      ['post', `${character}/augment/apply`, { fields: [{ field: 'motivations', value: 'Example revised' }] }, effects.applyAugment, 200],
      ['patch', `${world}/canon/character/example-character/lock`, { locked: true }, effects.lock, 200],
    ] });
    expect(effects.expand).toHaveBeenLastCalledWith(expect.objectContaining(picker));
  });

  it('keeps remote history reads open', async () => {
    const response = await callRoute(await hostControlApp('192.0.2.10', mounts), ['get', `${world}/runs`]);
    expect(response.status).toBe(200);
    expect(effects.listRuns).toHaveBeenCalledTimes(1);
  });
});
