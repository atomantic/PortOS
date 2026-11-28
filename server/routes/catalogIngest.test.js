import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/catalog/catalogDB.js', () => ({ getScrap: vi.fn() }));
vi.mock('../services/catalog/catalogPrune.js', () => ({ pruneCatalogBabble: vi.fn() }));
vi.mock('../services/catalog/catalogExtraction.js', () => ({ extractIngredientsForScrap: vi.fn() }));
vi.mock('../services/catalog/catalogIngestSources.js', () => ({
  ingestFromUrl: vi.fn(),
  ingestFromFile: vi.fn(),
  ingestFromVoice: vi.fn(),
  ingestFromBrain: vi.fn(),
}));
vi.mock('../services/embeddings.js', () => ({ embedBatch: vi.fn(), ingredientEmbedSeed: vi.fn() }));
vi.mock('../lib/db.js', () => ({ withTransaction: vi.fn() }));
vi.mock('../scripts/migrateBibleToCatalog.js', () => ({ migrateBibleToCatalog: vi.fn() }));
vi.mock('../services/musicVideo/catalogCast.js', () => ({
  previewCatalogCastImport: vi.fn(),
  commitCatalogCastImport: vi.fn(),
}));

import { getScrap } from '../services/catalog/catalogDB.js';
import { pruneCatalogBabble } from '../services/catalog/catalogPrune.js';
import { ingestFromUrl, ingestFromFile, ingestFromVoice, ingestFromBrain } from '../services/catalog/catalogIngestSources.js';
import { migrateBibleToCatalog } from '../scripts/migrateBibleToCatalog.js';
import { commitCatalogCastImport, previewCatalogCastImport } from '../services/musicVideo/catalogCast.js';
import catalogIngestRoutes from './catalogIngest.js';

const base = '/api/catalog';
const app = express();
app.use(express.json());
app.use(base, catalogIngestRoutes);
app.use(errorMiddleware);

beforeEach(() => vi.resetAllMocks());

describe('POST /api/catalog/scraps/:id/prune', () => {
  const path = `${base}/scraps/scrap-1/prune`;
  const options = { providerId: 'provider-1', model: 'model-1', effort: 'low' };

  it('rejects missing model selection before looking up the scrap', async () => {
    const res = await request(app).post(path).send({ providerId: 'provider-1' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(getScrap).not.toHaveBeenCalled();
    expect(pruneCatalogBabble).not.toHaveBeenCalled();
  });

  it('returns 404 for a missing scrap without running pruning', async () => {
    getScrap.mockResolvedValue(null);
    const res = await request(app).post(path).send(options);
    expect(res.status).toBe(404);
    expect(pruneCatalogBabble).not.toHaveBeenCalled();
  });

  it('returns 400 for a chunk without running pruning', async () => {
    getScrap.mockResolvedValue({ id: 'scrap-1', parentScrapId: 'scrap-parent', rawText: 'Example chunk' });
    const res = await request(app).post(path).send(options);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Prune the parent scrap');
    expect(pruneCatalogBabble).not.toHaveBeenCalled();
  });

  it('prunes the parent scrap using its stored text and the selected model', async () => {
    const scrap = { id: 'scrap-1', rawText: 'Example source text' };
    const draft = { text: 'Example draft' };
    getScrap.mockResolvedValue(scrap);
    pruneCatalogBabble.mockResolvedValue(draft);
    const res = await request(app).post(path).send(options);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ scrap, draft });
    expect(getScrap).toHaveBeenCalledExactlyOnceWith(scrap.id);
    expect(pruneCatalogBabble).toHaveBeenCalledExactlyOnceWith({ rawText: scrap.rawText, ...options });
  });
});

describe.each([
  {
    source: 'url',
    ingest: ingestFromUrl,
    input: { url: ' https://example.com/article ' },
    parsed: { url: 'https://example.com/article' },
    invalid: { url: 'example.com/article' },
  },
  {
    source: 'file',
    ingest: ingestFromFile,
    input: { filename: ' example.txt ', text: 'Example file text' },
    parsed: { filename: 'example.txt', text: 'Example file text' },
    invalid: { filename: 'example.txt', text: '' },
  },
  {
    source: 'voice',
    ingest: ingestFromVoice,
    input: { audioBase64: 'ZXhhbXBsZQ==', title: ' Example memo ' },
    parsed: { audioBase64: 'ZXhhbXBsZQ==', title: 'Example memo' },
    invalid: { audioBase64: '' },
  },
  {
    source: 'brain',
    ingest: ingestFromBrain,
    input: { brainType: 'ideas', brainId: ' idea-1 ' },
    parsed: { brainType: 'ideas', brainId: 'idea-1' },
    invalid: { brainType: 'unknown', brainId: 'idea-1' },
  },
])('POST /api/catalog/ingest/$source', ({ source, ingest, input, parsed, invalid }) => {
  it('returns 201 with the review draft from the matching source service', async () => {
    const result = { scrap: { id: 'scrap-1' }, draft: { ingredients: [] } };
    ingest.mockResolvedValue(result);
    const res = await request(app).post(`${base}/ingest/${source}`).send(input);
    expect(res.status).toBe(201);
    expect(res.body).toEqual(result);
    expect(ingest).toHaveBeenCalledExactlyOnceWith(parsed);
  });

  it('returns 400 for invalid input before starting ingest', async () => {
    const res = await request(app).post(`${base}/ingest/${source}`).send(invalid);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(ingest).not.toHaveBeenCalled();
  });
});

describe('POST /api/catalog/migration/rerun', () => {
  const path = `${base}/migration/rerun`;

  it.each([
    { input: {}, force: false },
    { input: { force: true }, force: true },
  ])('runs the migration with force=$force', async ({ input, force }) => {
    const result = { promoted: 2 };
    migrateBibleToCatalog.mockResolvedValue(result);
    const res = await request(app).post(path).send(input);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(result);
    expect(migrateBibleToCatalog).toHaveBeenCalledExactlyOnceWith({ force });
  });

  it('rejects a string force flag before running the migration', async () => {
    const res = await request(app).post(path).send({ force: 'true' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(migrateBibleToCatalog).not.toHaveBeenCalled();
  });
});

describe('/api/catalog/import/music-videos', () => {
  const path = `${base}/import/music-videos`;
  const link = { projectId: 'video-1', subjectId: 'cast-1', action: 'link' };

  it('wraps the preview in projects without committing changes', async () => {
    const projects = [{ id: 'video-1' }];
    previewCatalogCastImport.mockResolvedValue(projects);
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ projects });
    expect(commitCatalogCastImport).not.toHaveBeenCalled();
  });

  it('rejects link selections without an ingredient ID before committing', async () => {
    const res = await request(app).post(path).send({ selections: [link] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(commitCatalogCastImport).not.toHaveBeenCalled();
  });

  it('commits reviewed selections including the chosen form', async () => {
    const selections = [{ ...link, ingredientId: 'ingredient-1', formId: 'form-1' }];
    const result = { linked: 1 };
    commitCatalogCastImport.mockResolvedValue(result);
    const res = await request(app).post(path).send({ selections });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(result);
    expect(commitCatalogCastImport).toHaveBeenCalledExactlyOnceWith(selections);
  });
});
