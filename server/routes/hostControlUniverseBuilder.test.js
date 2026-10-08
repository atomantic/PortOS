import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';

// Production router composition and auth gates; double the effect boundaries
// so refusal proves that no provider, queue, store or image lookup was reached.
const auth = vi.hoisted(() => ({ enabled: false }));
const effects = vi.hoisted(() => Object.fromEntries([
  'expand', 'variations', 'refine', 'promote', 'sort', 'extract', 'refineCharacter',
  'expandCharacter', 'reviewCast', 'augment', 'differentiate', 'mergeAI',
  'describe', 'expandImages', 'correctImage', 'analyzeStyle', 'render', 'sheet',
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
  backfillCanonDescriptionsFromPrompts: effects.backfill, setCanonEntryLock: effects.lock,
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
vi.mock('../services/universeCharacterSheet.js', () => ({
  renderCharacterReferenceSheet: effects.sheet, deleteCharacterReferenceSheet: vi.fn(),
  listSheetVariants: vi.fn(() => []), getCharacterReferenceSheet: vi.fn(),
}));
vi.mock('../services/universeGraph.js', () => ({ buildUniverseGraph: vi.fn() }));

import { authGate, hostControlRouteGate } from '../services/authGate.js';
import { createSession } from '../services/auth.js';
import universeRoutes from './universeBuilder/index.js';

const base = '/api/universe-builder';
const world = `${base}/example-world`;
const character = `${world}/characters/example-character`;
const picker = { providerId: 'example-cli', model: 'example-model' };
const images = [{ source: 'gallery', filename: 'example.png' }];
const operations = [
  [`${base}/expand`, { starterPrompt: 'Example starter', ...picker }, effects.expand],
  [`${base}/generate-variations`, { category: 'landscapes', count: 1, ...picker }, effects.variations],
  [`${base}/refine-prompts`, { starterPrompt: 'Example starter', feedback: 'Example feedback', image: 'example.png', ...picker }, effects.refine],
  [`${world}/promote-variation`, { category: 'landscapes', label: 'Example landscape', ...picker }, effects.promote],
  [`${world}/auto-sort`, picker, effects.sort],
  [`${world}/extract-canon`, { corpus: 'Example prose', providerOverride: picker.providerId }, effects.extract],
  [`${character}/refine`, picker, effects.refineCharacter],
  [`${character}/expand`, picker, effects.expandCharacter],
  [`${world}/characters/integrity/review`, picker, effects.reviewCast],
  [`${character}/augment`, { fields: ['motivations'], ...picker }, effects.augment],
  [`${world}/characters/differentiate-cast`, picker, effects.differentiate],
  [`${base}/merge/ai-resolve`, { survivorId: 'example-world', loserId: 'example-other-world', fields: ['premise'], ...picker }, effects.mergeAI],
  [`${base}/describe-from-images`, { kind: 'character', images, ...picker }, effects.describe],
  [`${character}/expand-from-images`, { images, ...picker }, effects.expandImages],
  [`${world}/canon/character/example-character/correct-from-image`, { image: 'example.png', ...picker }, effects.correctImage],
  [`${base}/analyze-style-reference`, { image: 'example.png', prompt: 'Example style', ...picker }, effects.analyzeStyle],
  [`${world}/render`, { mode: 'codex', extraStyle: 'Example style' }, effects.render],
  [`${character}/render-reference-sheet`, { overridePrompt: 'Example sheet prompt' }, effects.sheet],
];
const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json());
  app.use(base, universeRoutes);
  app.use(errorMiddleware);
  return app;
};
const call = (app, [path, body], headers = {}, method = 'post') => {
  const pending = request(app)[method](path);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return pending.send(body);
};
const expectNoEffects = () => {
  for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
  effects.gallery.mockImplementation(filename => `/example/images/${filename}`);
  // Exercise the batch route's pre-queue migration write as well as rendering.
  effects.persistIds.mockResolvedValue(true);
});

describe('Universe Builder agent workflow authority (#10669)', () => {
  it('refuses every remote operation before provider, queue, store or image effects, even for API-first requests', async () => {
    for (const [path, body] of operations) {
      for (const candidate of [body, { ...body, providerId: 'example-api', providerOverride: 'example-api' }]) {
        const response = await call(appFor(), [path, candidate]);
        expect([response.status, response.body.code], path).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
      }
      const variant = await call(appFor(), [path.toUpperCase() + '/', body]);
      expect([variant.status, variant.body.code], path).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    }
    expectNoEffects();
  });

  it('refuses proxy-marked, anonymous auth-on, Basic and scoped-peer callers', async () => {
    for (const [enabled, address, headers, status, code] of [
      [false, '127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }, 403, 'HOST_CONTROL_FORBIDDEN'],
      [true, '192.0.2.10', {}, 401, 'AUTH_REQUIRED'],
      [true, '192.0.2.10', { Authorization: 'Basic ' + Buffer.from(':example-password').toString('base64') }, 403, 'HOST_CONTROL_FORBIDDEN'],
      [true, '192.0.2.10', {
        [PEER_AUTH_HEADER]: derivePeerAuthToken('a'.repeat(32), 'example-instance'),
        [PEER_INSTANCE_HEADER]: 'example-instance',
      }, 403, 'PEER_SCOPE_FORBIDDEN'],
    ]) {
      auth.enabled = enabled;
      for (const operation of operations) {
        const response = await call(appFor(address), operation, headers);
        expect([response.status, response.body.code], operation[0]).toEqual([status, code]);
      }
    }
    expectNoEffects();
  });

  it('preserves genuine local, operator-session and delegated-agent workflows', async () => {
    const operator = await createSession();
    const agent = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Cookie: `portos_auth=${operator.token}` }],
      [true, '127.0.0.1', { Authorization: `Bearer ${agent.token}` }],
    ]) {
      auth.enabled = enabled;
      for (const [path, body, effect] of operations) {
        const before = effect.mock.calls.length;
        const response = await call(appFor(address), [path, body], headers);
        expect(response.status, `${path}: ${JSON.stringify(response.body)}`).toBe(200);
        expect(effect, path).toHaveBeenCalledTimes(before + 1);
      }
    }
    expect(effects.expand).toHaveBeenLastCalledWith(expect.objectContaining(picker));
    expect(effects.sheet).toHaveBeenLastCalledWith('example-world', 'example-character', { overridePrompt: 'Example sheet prompt' });
    expect(effects.persistIds).toHaveBeenCalledTimes(3);
    expect(effects.update).toHaveBeenCalledTimes(3);
  });

  it('preserves remote record CRUD, proposal application, merge, locks, backfill and history', async () => {
    const app = appFor();
    const merge = { survivorId: 'example-world', loserId: 'example-other-world' };
    for (const [method, path, body, effect, status] of [
      ['post', base, { name: 'Example World' }, effects.create, 201],
      ['patch', world, { premise: 'Example premise' }, effects.update, 200],
      ['delete', world, undefined, effects.delete, 200],
      ['post', `${base}/merge/preview`, merge, effects.merge, 200],
      ['post', `${base}/merge`, merge, effects.merge, 200],
      ['post', `${world}/canon/character/example-character/apply-image-correction`, { description: 'Example corrected', imageFilename: 'example.png' }, effects.applyImage, 200],
      ['post', `${character}/augment/apply`, { fields: [{ field: 'motivations', value: 'Example revised' }] }, effects.applyAugment, 200],
      ['post', `${world}/canon/backfill-descriptions`, {}, effects.backfill, 200],
      ['patch', `${world}/canon/character/example-character/lock`, { locked: true }, effects.lock, 200],
      ['get', `${world}/runs`, undefined, effects.listRuns, 200],
    ]) {
      const before = effect.mock.calls.length;
      const response = await call(app, [path, body], {}, method);
      expect(response.status, `${path}: ${JSON.stringify(response.body)}`).toBe(status);
      expect(effect).toHaveBeenCalledTimes(before + 1);
    }
    for (const [, , effect] of operations) expect(effect).not.toHaveBeenCalled();
    expect(effects.gallery).not.toHaveBeenCalled();
    expect(effects.persistIds).not.toHaveBeenCalled();
  });
});
