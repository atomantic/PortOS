import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// Real store over a temp data root; only the live provider lookup is doubled.
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-moa-routes-') }));
afterAll(cleanupTempDataRoots);

const providers = vi.hoisted(() => ({ records: {} }));
vi.mock('../services/provider/providers.js', () => ({ getProviderById: vi.fn(async (id) => providers.records[id] ?? null) }));

const { default: moaRoutes } = await import('./moaPresets.js');
const { resolveMoaProvider } = await import('../services/moaPresets.js');

const app = express();
app.use(express.json());
app.use('/api/moa-presets', moaRoutes);
app.use(errorMiddleware);
const api = (method, path = '', body) => request(app)[method](`/api/moa-presets${path}`).send(body);

const apiProvider = (id) => ({ id, type: 'api', enabled: true, defaultModel: `${id}-model` });
const body = (extra = {}) => ({ name: 'Expert Council', referenceModels: [{ providerId: 'a' }, { providerId: 'b', model: 'b-small' }], aggregator: { providerId: 'agg' }, ...extra });

beforeEach(() => {
  providers.records = { a: apiProvider('a'), b: apiProvider('b'), agg: apiProvider('agg') };
});

describe('MoA preset routes', () => {
  it('creates, lists, edits, disables and deletes a preset that resolves as moa:<id>', async () => {
    const created = await api('post', '', body());
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: 'expert-council', providerId: 'moa:expert-council', enabled: true, privacyFilter: 'off', refusals: [] });

    const listed = await api('get');
    expect(listed.body.presets.map((p) => p.id)).toEqual(['expert-council']);
    expect(listed.body.instructions.advisor).toMatch(/advisor instruction/);
    expect(listed.body.maxReferenceModels).toBe(5);

    expect(await resolveMoaProvider('moa:expert-council')).toMatchObject({ id: 'moa:expert-council', type: 'moa', defaultModel: null, moaPresetId: 'expert-council' });

    const edited = await api('put', '/expert-council', { privacyFilter: 'full', enabled: false, aggregator: { providerId: 'agg', model: 'agg-big' } });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ privacyFilter: 'full', enabled: false, aggregator: { model: 'agg-big' }, name: 'Expert Council' });
    expect((await resolveMoaProvider('moa:expert-council')).defaultModel).toBe('agg-big');

    expect((await api('post', '', body())).body.id).toBe('expert-council-2');
    expect((await api('post', '', body({ id: 'expert-council' }))).status).toBe(409);

    expect((await api('delete', '/expert-council')).status).toBe(200);
    expect((await api('delete', '/expert-council')).status).toBe(404);
    expect(await resolveMoaProvider('moa:expert-council')).toBeNull();
  });

  it('refuses recursive, ineligible and oversized presets without writing them', async () => {
    providers.records.cli = { id: 'cli', type: 'cli', enabled: true, defaultModel: 'm' };
    providers.records.off = { ...apiProvider('off'), enabled: false };
    const before = (await api('get')).body.presets.length;

    expect((await api('post', '', body({ aggregator: { providerId: 'moa:expert-council-2' } }))).status).toBe(400);
    expect((await api('post', '', body({ referenceModels: Array.from({ length: 6 }, () => ({ providerId: 'a' })) }))).status).toBe(400);
    const cli = await api('post', '', body({ aggregator: { providerId: 'cli' } }));
    expect(cli.status).toBe(400);
    expect(cli.body.error).toMatch(/Aggregator provider "cli" is not an API provider/);
    expect((await api('post', '', body({ referenceModels: [{ providerId: 'off' }] }))).body.error).toMatch(/Reference model 1 provider "off" is disabled/);

    expect((await api('get')).body.presets.length).toBe(before);
  });

  it('flags a saved preset a provider change broke, and still lets it be renamed', async () => {
    const { id } = (await api('post', '', body({ name: 'Fragile' }))).body;
    delete providers.records.b;
    const listed = (await api('get')).body.presets.find((p) => p.id === id);
    expect(listed.refusals).toEqual([{ role: 'reference', index: 1, providerId: 'b', refusal: 'provider "b" was not found' }]);
    expect((await api('put', `/${id}`, { name: 'Fragile (renamed)' })).status).toBe(200);
    expect((await api('put', `/${id}`, { referenceModels: [{ providerId: 'b' }] })).status).toBe(400);
  });
});
