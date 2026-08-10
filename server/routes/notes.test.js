/**
 * Notes route error mapping — #3704.
 *
 * The eviction path added a third class of failure to these handlers: the note
 * EXISTS but iCloud hasn't downloaded its bytes yet. That is neither a 404 (the
 * note is not gone) nor a 400 (the request was fine), and the default branch of
 * `errorStatus` would have made it a 400. It must be 503 so a client can retry.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

vi.mock('../services/obsidian.js', () => ({
  getNote: vi.fn(),
  scanVault: vi.fn(),
  updateNote: vi.fn(),
}));

const obsidian = await import('../services/obsidian.js');
const notesRoutes = (await import('./notes.js')).default;
const { errorMiddleware } = await import('../lib/errorHandler.js');

const app = express();
app.use(express.json());
app.use('/api/notes', notesRoutes);
app.use(errorMiddleware);

beforeEach(() => {
  obsidian.getNote.mockReset();
  obsidian.scanVault.mockReset();
  obsidian.updateNote.mockReset();
});

describe('GET /api/notes/vaults/:id/note error mapping', () => {
  it('maps NOTE_EVICTED to 503 with a retryable message', async () => {
    obsidian.getNote.mockResolvedValue({
      error: 'NOTE_EVICTED',
      message: 'This note is stored in iCloud and has not been downloaded to this Mac yet.',
    });

    const res = await request(app).get('/api/notes/vaults/v1/note?path=a.md');

    // 503, not the 400 the default branch would give, and not 404 (it exists).
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('NOTE_EVICTED');
    expect(res.body.error).toMatch(/iCloud/i);
  });

  it('still maps NOTE_NOT_FOUND to 404', async () => {
    obsidian.getNote.mockResolvedValue({ error: 'NOTE_NOT_FOUND' });
    const res = await request(app).get('/api/notes/vaults/v1/note?path=a.md');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOTE_NOT_FOUND');
  });

  it('still maps an unrelated service error to 400', async () => {
    obsidian.getNote.mockResolvedValue({ error: 'INVALID_PATH', message: 'Path traversal not allowed' });
    const res = await request(app).get('/api/notes/vaults/v1/note?path=a.md');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PATH');
  });
});

/**
 * The force-save escape hatch (#3717). The dataless screen can false-positive on
 * a genuinely-local sparse/compressed file, and on the write path that used to be
 * an unrecoverable lockout. `force` is the way back — so the handler must pass it
 * through verbatim AND must default it off, or every background save inherits it.
 */
describe('PUT /api/notes/vaults/:id/note force pass-through', () => {
  it('defaults force to false when the body omits it', async () => {
    obsidian.updateNote.mockResolvedValue({ path: 'a.md' });

    const res = await request(app).put('/api/notes/vaults/v1/note?path=a.md').send({ content: 'hi' });

    expect(res.status).toBe(200);
    expect(obsidian.updateNote).toHaveBeenCalledWith('v1', 'a.md', 'hi', { force: false });
  });

  it('forwards an explicit force:true', async () => {
    obsidian.updateNote.mockResolvedValue({ path: 'a.md' });

    await request(app).put('/api/notes/vaults/v1/note?path=a.md').send({ content: 'hi', force: true });

    expect(obsidian.updateNote).toHaveBeenCalledWith('v1', 'a.md', 'hi', { force: true });
  });

  it('rejects a non-boolean force rather than coercing it', async () => {
    const res = await request(app).put('/api/notes/vaults/v1/note?path=a.md').send({ content: 'hi', force: 'yes' });

    expect(res.status).toBe(400);
    expect(obsidian.updateNote).not.toHaveBeenCalled();
  });
});

describe('GET /api/notes/vaults/:id/scan', () => {
  it('forwards skippedUnavailable so a short vault is distinguishable from an offloaded one', async () => {
    obsidian.scanVault.mockResolvedValue({
      vault: { id: 'v1', name: 'V' },
      notes: [{ name: 'a', modifiedAt: new Date().toISOString() }],
      skippedUnavailable: 7,
    });

    const res = await request(app).get('/api/notes/vaults/v1/scan');

    expect(res.status).toBe(200);
    // This handler reshapes for pagination, so the count has to be re-attached
    // explicitly — it is the one reader that could silently drop it.
    expect(res.body.skippedUnavailable).toBe(7);
  });

  it('defaults skippedUnavailable to 0 when the service omits it', async () => {
    obsidian.scanVault.mockResolvedValue({ vault: { id: 'v1' }, notes: [] });
    const res = await request(app).get('/api/notes/vaults/v1/scan');
    expect(res.body.skippedUnavailable).toBe(0);
  });
});
