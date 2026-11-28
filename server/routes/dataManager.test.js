import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware, ServerError } from '../lib/errorHandler.js';

// The whole service is stubbed — nothing in this suite may reach the real
// `data/` directory, which holds the user's only copy of these files (#3327).
vi.mock('../services/dataManager.js', () => ({
  getDataOverview: vi.fn(),
  getCategoryDetail: vi.fn(),
  archiveCategory: vi.fn(),
  purgeCategory: vi.fn(),
  getBackups: vi.fn(),
  deleteBackup: vi.fn(),
}));

const { archiveCategory, deleteBackup, getCategoryDetail, purgeCategory } = await import('../services/dataManager.js');
const { default: dataRoutes } = await import('./dataManager.js');

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/data', dataRoutes);
  app.use(errorMiddleware);
  return app;
};

beforeEach(() => vi.resetAllMocks());

describe('DELETE /api/data/:category', () => {

  it('treats a bodiless request as a whole-category purge', async () => {
    purgeCategory.mockResolvedValue({ category: 'screenshots', subPath: null });
    const res = await request(makeApp()).delete('/api/data/screenshots');
    expect(res.status).toBe(200);
    expect(purgeCategory).toHaveBeenCalledWith('screenshots', { subPath: undefined });
  });

  it('rejects a malformed subPath before the service is reached', async () => {
    const res = await request(makeApp()).delete('/api/data/images').send({ subPath: 42 });
    expect(res.status).toBe(400);
    expect(purgeCategory).not.toHaveBeenCalled();
  });

  it.each(['sub/child.png', 'sub\\child.png', '../images/render.png', '..', '.'])(
    'rejects a subPath that is not a single entry: %s',
    async (subPath) => {
      const res = await request(makeApp()).delete('/api/data/images').send({ subPath });
      expect(res.status).toBe(400);
      expect(purgeCategory).not.toHaveBeenCalled();
    }
  );

  // The endpoint stays reachable even when the UI hides the button, so the
  // service's refusal has to surface as a 4xx rather than an opaque 500.
  it('surfaces the service refusal of a category-wide purge on an item-scoped category', async () => {
    purgeCategory.mockRejectedValue(new ServerError('Category "images" only supports per-item purge — pass a subPath', {
      status: 400,
      code: 'CATEGORY_ITEM_PURGE_ONLY',
    }));
    const res = await request(makeApp()).delete('/api/data/images').send({});
    expect(res.status).toBe(400);
    expect(res.body.error?.code ?? res.body.code).toBe('CATEGORY_ITEM_PURGE_ONLY');
  });

  // The disabled button is a hint; this is the backstop. The reason has to reach
  // the client verbatim — it is the only thing that tells the user what to wait
  // for (#3342).
  it('surfaces a busy-category refusal as 409 with the reason intact', async () => {
    const reason = '1 LoRA training run(s) queued or running — purge once training finishes.';
    purgeCategory.mockRejectedValue(new ServerError(reason, { status: 409, code: 'CATEGORY_BUSY' }));
    const res = await request(makeApp()).delete('/api/data/training-runs').send({});
    expect(res.status).toBe(409);
    expect(res.body.error?.code ?? res.body.code).toBe('CATEGORY_BUSY');
    expect(JSON.stringify(res.body)).toContain(reason);
  });
});

describe('DELETE /api/data/backups/:filename', () => {
  it('deletes the named backup without dispatching a category purge', async () => {
    const filename = 'example-backup.tar.gz';
    deleteBackup.mockResolvedValue({ deleted: filename });
    const res = await request(makeApp()).delete(`/api/data/backups/${filename}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: filename });
    expect(deleteBackup).toHaveBeenCalledExactlyOnceWith(filename);
    expect(purgeCategory).not.toHaveBeenCalled();
  });

  it('surfaces an invalid filename refusal without dispatching a category purge', async () => {
    deleteBackup.mockRejectedValue(new ServerError('Invalid filename', { status: 400, code: 'INVALID_FILENAME' }));
    const res = await request(makeApp()).delete('/api/data/backups/example.txt');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FILENAME');
    expect(purgeCategory).not.toHaveBeenCalled();
  });
});

describe('POST /api/data/:category/archive', () => {
  it('passes the parsed retention window to the archive service', async () => {
    const result = { filename: 'screenshots.tar.gz' };
    archiveCategory.mockResolvedValue(result);
    const res = await request(makeApp()).post('/api/data/screenshots/archive').send({ daysToKeep: '7' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(result);
    expect(archiveCategory).toHaveBeenCalledExactlyOnceWith('screenshots', { daysToKeep: 7 });
  });

  it('rejects negative retention before archiving', async () => {
    const res = await request(makeApp()).post('/api/data/screenshots/archive').send({ daysToKeep: -1 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(archiveCategory).not.toHaveBeenCalled();
  });
});

describe('GET /api/data/:category', () => {
  it.each([
    { suffix: '', measure: false },
    { suffix: '?measure=1', measure: true },
  ])('passes measure=$measure for "$suffix"', async ({ suffix, measure }) => {
    const detail = { key: 'screenshots', entries: [] };
    getCategoryDetail.mockResolvedValue(detail);
    const res = await request(makeApp()).get(`/api/data/screenshots${suffix}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(detail);
    expect(getCategoryDetail).toHaveBeenCalledExactlyOnceWith('screenshots', { measure });
  });

  it('rejects an invalid measure flag before reading the category', async () => {
    const res = await request(makeApp()).get('/api/data/screenshots?measure=true');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(getCategoryDetail).not.toHaveBeenCalled();
  });

  it('maps a missing category to 404', async () => {
    getCategoryDetail.mockResolvedValue(null);
    const res = await request(makeApp()).get('/api/data/missing-category');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});
