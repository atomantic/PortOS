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

const { purgeCategory } = await import('../services/dataManager.js');
const { default: dataRoutes } = await import('./dataManager.js');

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/data', dataRoutes);
  app.use(errorMiddleware);
  return app;
};

describe('DELETE /api/data/:category', () => {
  beforeEach(() => {
    purgeCategory.mockReset().mockResolvedValue({ category: 'images', subPath: null });
  });

  it('forwards a per-item purge target to the service', async () => {
    const res = await request(makeApp()).delete('/api/data/images').send({ subPath: 'render-0001.png' });
    expect(res.status).toBe(200);
    expect(purgeCategory).toHaveBeenCalledWith('images', { subPath: 'render-0001.png' });
  });

  it('treats a bodiless request as a whole-category purge', async () => {
    const res = await request(makeApp()).delete('/api/data/messages').send({});
    expect(res.status).toBe(200);
    expect(purgeCategory).toHaveBeenCalledWith('messages', { subPath: undefined });
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
