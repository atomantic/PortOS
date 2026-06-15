import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/chatgptImport.js', () => ({
  parseExport: vi.fn(),
  stripPreview: vi.fn((p) => p),
  importConversations: vi.fn(),
  readArchivedConversation: vi.fn()
}));
vi.mock('../services/chatgptZipImport.js', () => ({
  importChatgptZip: vi.fn()
}));

let brainImportRoutes;
let chatgptImport;
let chatgptZipImport;

beforeEach(async () => {
  vi.resetModules();
  vi.doMock('../services/chatgptImport.js', () => ({
    parseExport: vi.fn(),
    stripPreview: vi.fn((p) => p),
    importConversations: vi.fn(),
    readArchivedConversation: vi.fn()
  }));
  vi.doMock('../services/chatgptZipImport.js', () => ({
    importChatgptZip: vi.fn()
  }));
  brainImportRoutes = (await import('./brainImport.js')).default;
  chatgptImport = await import('../services/chatgptImport.js');
  chatgptZipImport = await import('../services/chatgptZipImport.js');
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

  // Build a multipart/form-data body with one file part + text fields.
  const buildMultipart = (boundary, { fileField = 'file', fileName = 'export.zip', fileBytes = Buffer.from('PK\x03\x04zipbytes'), fields = {} }) => {
    const parts = [];
    for (const [k, v] of Object.entries(fields)) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: application/zip\r\n\r\n`));
    parts.push(fileBytes);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    return Buffer.concat(parts);
  };

  it('POST /chatgpt/zip streams the upload and runs the ZIP import', async () => {
    chatgptZipImport.importChatgptZip.mockResolvedValue({
      ok: true, imported: 3, skipped: 1, archived: 3,
      assetStats: { assetCount: 12 }, results: []
    });
    const boundary = '----portostest';
    const body = buildMultipart(boundary, { fields: { tags: 'chatgpt-import,archive', skipEmpty: 'true' } });
    const res = await request(buildApp())
      .post('/api/brain/import/chatgpt/zip')
      .set('content-type', `multipart/form-data; boundary=${boundary}`)
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(3);
    expect(res.body.assetStats.assetCount).toBe(12);
    expect(chatgptZipImport.importChatgptZip).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ tags: ['chatgpt-import', 'archive'], skipEmpty: true })
    );
  });

  it('POST /chatgpt/zip rejects a non-zip upload', async () => {
    const boundary = '----portostest2';
    const parts = [
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="notes.txt"\r\nContent-Type: text/plain\r\n\r\n`),
      Buffer.from('hello'),
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ];
    const res = await request(buildApp())
      .post('/api/brain/import/chatgpt/zip')
      .set('content-type', `multipart/form-data; boundary=${boundary}`)
      .send(Buffer.concat(parts));
    expect(res.status).toBe(400);
    expect(chatgptZipImport.importChatgptZip).not.toHaveBeenCalled();
  });

  it('GET /chatgpt/archive/:name returns the archived transcript', async () => {
    chatgptImport.readArchivedConversation.mockResolvedValue({ id: 'c1', title: 'X', transcript: '**You**:\nhi' });
    const res = await request(buildApp()).get('/api/brain/import/chatgpt/archive/c1.json');
    expect(res.status).toBe(200);
    expect(res.body.transcript).toContain('hi');
    expect(chatgptImport.readArchivedConversation).toHaveBeenCalledWith('c1.json');
  });

  it('GET /chatgpt/archive/:name returns 404 when missing', async () => {
    chatgptImport.readArchivedConversation.mockResolvedValue(null);
    const res = await request(buildApp()).get('/api/brain/import/chatgpt/archive/missing.json');
    expect(res.status).toBe(404);
  });
});
