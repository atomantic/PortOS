import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/chatgptImport.js', () => ({
  parseExport: vi.fn(),
  stripPreview: vi.fn((p) => p),
  importConversations: vi.fn()
}));

let brainImportRoutes;
let chatgptImport;

beforeEach(async () => {
  vi.resetModules();
  vi.doMock('../services/chatgptImport.js', () => ({
    parseExport: vi.fn(),
    stripPreview: vi.fn((p) => p),
    importConversations: vi.fn()
  }));
  brainImportRoutes = (await import('./brainImport.js')).default;
  chatgptImport = await import('../services/chatgptImport.js');
});

const buildApp = () => {
  const app = express();
  app.use(express.json({ limit: '55mb' }));
  app.use('/api/brain/import', brainImportRoutes);
  app.use(errorMiddleware);
  return app;
};

describe('brainImport routes', () => {
  it('GET /sources returns the available sources list', async () => {
    const res = await request(buildApp()).get('/api/brain/import/sources');
    expect(res.status).toBe(200);
    expect(res.body.sources).toBeInstanceOf(Array);
    const chatgpt = res.body.sources.find((s) => s.id === 'chatgpt');
    expect(chatgpt).toBeDefined();
    expect(chatgpt.status).toBe('available');
    expect(chatgpt.instructions.length).toBeGreaterThan(0);
  });

  it('POST /chatgpt/preview returns 400 when payload is invalid', async () => {
    chatgptImport.parseExport.mockReturnValue({ ok: false, error: 'bad shape' });
    const res = await request(buildApp())
      .post('/api/brain/import/preview-fake-path')
      .send({ data: 'whatever' });
    // sanity: route doesn't exist
    expect(res.status).toBe(404);

    const real = await request(buildApp())
      .post('/api/brain/import/chatgpt/preview')
      .send({ data: 'whatever' });
    expect(real.status).toBe(400);
    expect(real.body.error || real.body.message).toBeTruthy();
  });

  it('POST /chatgpt/preview returns parsed summary on valid payload', async () => {
    chatgptImport.parseExport.mockReturnValue({
      ok: true,
      summary: { totalConversations: 2, totalMessages: 5, totalChars: 100, earliest: null, latest: null, gizmoCount: 0 },
      conversations: [{ id: 'c1', title: 'X', messageCount: 3 }]
    });
    const res = await request(buildApp())
      .post('/api/brain/import/chatgpt/preview')
      .send({ data: [{ id: 'c1' }] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.summary.totalConversations).toBe(2);
  });

  it('POST /chatgpt runs the import when payload is valid', async () => {
    chatgptImport.parseExport.mockReturnValue({
      ok: true,
      summary: { totalConversations: 1 },
      conversations: [{ id: 'c1', title: 'X' }]
    });
    chatgptImport.importConversations.mockResolvedValue({
      ok: true,
      imported: 1,
      skipped: 0,
      archived: 1,
      results: [{ id: 'c1', status: 'imported' }]
    });
    const res = await request(buildApp())
      .post('/api/brain/import/chatgpt')
      .send({ data: [{ id: 'c1' }], tags: ['chatgpt-import'] });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(chatgptImport.importConversations).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ tags: ['chatgpt-import'] })
    );
  });
});
