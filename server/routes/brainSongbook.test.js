import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

// Redirect the attachment bytes directory at a per-suite temp dir. `var` +
// function declaration are hoisted (no TDZ) so the hoisted vi.mock factory can
// call getTempRoot() safely.
var tempRoot; // eslint-disable-line no-var
function getTempRoot() {
  if (!tempRoot) tempRoot = mkdtempSync(join(tmpdir(), 'songbook-route-test-'));
  return tempRoot;
}
const songbookDir = () => join(getTempRoot(), 'brain', 'songbook');

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makePathsProxy(actual, {
    dataRoot: () => getTempRoot(),
    extraOverrides: (root) => ({ brainSongbook: join(root, 'brain', 'songbook') }),
  });
});

vi.mock('../services/brainStorage.js', () => ({
  getAll: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('../services/brainSongbookImport.js', () => ({
  importSongFromUrl: vi.fn(),
}));

import * as brainStorage from '../services/brainStorage.js';
import { importSongFromUrl } from '../services/brainSongbookImport.js';
import songbookRoutes from './brainSongbook.js';

afterAll(() => { if (tempRoot) rmSync(tempRoot, { recursive: true, force: true }); });

const SONG_ID = '11111111-1111-4111-8111-111111111111';

const buildApp = () => {
  const app = express();
  app.use(express.json({ limit: '55mb' }));
  app.use('/api/brain/songbook', songbookRoutes);
  app.use(errorMiddleware);
  return app;
};

const baseSong = (overrides = {}) => ({
  id: SONG_ID,
  title: 'Example Song',
  artist: 'The Placeholders',
  instrument: 'guitar',
  stage: 'new',
  tags: [],
  key: '',
  capo: 0,
  tuning: '',
  sourceUrl: '',
  content: { format: 'tab', text: 'e|--0--|' },
  scrollDurationSec: null,
  notes: '',
  attachments: [],
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
  ...overrides,
});

describe('Brain SongBook routes', () => {
  let app;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
  });

  // ===========================================================================
  // CRUD
  // ===========================================================================

  describe('GET /api/brain/songbook', () => {
    it('returns { songs } from the entity store', async () => {
      brainStorage.getAll.mockResolvedValue([baseSong()]);
      const res = await request(app).get('/api/brain/songbook');
      expect(res.status).toBe(200);
      expect(res.body.songs).toHaveLength(1);
      expect(brainStorage.getAll).toHaveBeenCalledWith('songs');
    });
  });

  describe('GET /api/brain/songbook/:id', () => {
    it('returns the song', async () => {
      brainStorage.getById.mockResolvedValue(baseSong());
      const res = await request(app).get(`/api/brain/songbook/${SONG_ID}`);
      expect(res.status).toBe(200);
      expect(res.body.title).toBe('Example Song');
      expect(brainStorage.getById).toHaveBeenCalledWith('songs', SONG_ID);
    });

    it('404s for an unknown id', async () => {
      brainStorage.getById.mockResolvedValue(null);
      const res = await request(app).get('/api/brain/songbook/nope');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/brain/songbook', () => {
    it('creates with schema defaults applied and attachments born empty', async () => {
      brainStorage.create.mockImplementation(async (type, data) => ({ id: SONG_ID, ...data }));
      const res = await request(app)
        .post('/api/brain/songbook')
        .send({ title: 'Example Song' });
      expect(res.status).toBe(201);
      expect(brainStorage.create).toHaveBeenCalledWith('songs', expect.objectContaining({
        title: 'Example Song',
        artist: '',
        instrument: 'guitar',
        stage: 'new',
        capo: 0,
        content: { format: 'tab', text: '' },
        scrollDurationSec: null,
        attachments: [],
      }));
    });

    it('ignores client-supplied attachments on create', async () => {
      brainStorage.create.mockImplementation(async (type, data) => ({ id: SONG_ID, ...data }));
      await request(app)
        .post('/api/brain/songbook')
        .send({ title: 'X', attachments: [{ filename: 'evil.txt' }] });
      expect(brainStorage.create).toHaveBeenCalledWith('songs',
        expect.objectContaining({ attachments: [] }));
    });

    it('400s when title is missing', async () => {
      const res = await request(app).post('/api/brain/songbook').send({ artist: 'X' });
      expect(res.status).toBe(400);
      expect(brainStorage.create).not.toHaveBeenCalled();
    });

    it('400s on an invalid stage', async () => {
      const res = await request(app)
        .post('/api/brain/songbook')
        .send({ title: 'X', stage: 'mastered' });
      expect(res.status).toBe(400);
    });
  });

  describe('PUT /api/brain/songbook/:id', () => {
    it('updates only the sent fields (no default injection)', async () => {
      brainStorage.update.mockResolvedValue(baseSong({ stage: 'learning' }));
      const res = await request(app)
        .put(`/api/brain/songbook/${SONG_ID}`)
        .send({ stage: 'learning' });
      expect(res.status).toBe(200);
      // Exactly the sent field — an omitted title/capo/etc. must not reset to defaults.
      expect(brainStorage.update).toHaveBeenCalledWith('songs', SONG_ID, { stage: 'learning' });
    });

    it('strips client-supplied attachments', async () => {
      brainStorage.update.mockResolvedValue(baseSong());
      await request(app)
        .put(`/api/brain/songbook/${SONG_ID}`)
        .send({ title: 'New Title', attachments: [{ filename: 'forged.pdf', mime: 'application/pdf', size: 1, sha256: 'x'.repeat(64) }] });
      expect(brainStorage.update).toHaveBeenCalledWith('songs', SONG_ID, { title: 'New Title' });
    });

    it('404s when the song is missing', async () => {
      brainStorage.update.mockResolvedValue(null);
      const res = await request(app)
        .put(`/api/brain/songbook/${SONG_ID}`)
        .send({ title: 'X' });
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/brain/songbook/:id/stage', () => {
    it('flips the stage', async () => {
      brainStorage.update.mockResolvedValue(baseSong({ stage: 'memorized' }));
      const res = await request(app)
        .patch(`/api/brain/songbook/${SONG_ID}/stage`)
        .send({ stage: 'memorized' });
      expect(res.status).toBe(200);
      expect(res.body.stage).toBe('memorized');
      expect(brainStorage.update).toHaveBeenCalledWith('songs', SONG_ID, { stage: 'memorized' });
    });

    it('400s on an invalid stage', async () => {
      const res = await request(app)
        .patch(`/api/brain/songbook/${SONG_ID}/stage`)
        .send({ stage: 'perfected' });
      expect(res.status).toBe(400);
      expect(brainStorage.update).not.toHaveBeenCalled();
    });

    it('404s when the song is missing', async () => {
      brainStorage.update.mockResolvedValue(null);
      const res = await request(app)
        .patch(`/api/brain/songbook/${SONG_ID}/stage`)
        .send({ stage: 'learning' });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/brain/songbook/:id', () => {
    it('tombstones and returns { id }', async () => {
      brainStorage.remove.mockResolvedValue(true);
      const res = await request(app).delete(`/api/brain/songbook/${SONG_ID}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: SONG_ID });
      expect(brainStorage.remove).toHaveBeenCalledWith('songs', SONG_ID);
    });

    it('404s when already gone', async () => {
      brainStorage.remove.mockResolvedValue(false);
      const res = await request(app).delete(`/api/brain/songbook/${SONG_ID}`);
      expect(res.status).toBe(404);
    });
  });

  // ===========================================================================
  // IMPORT
  // ===========================================================================

  describe('POST /api/brain/songbook/import/url', () => {
    it('returns the extracted draft', async () => {
      const draft = {
        title: 'Example Song',
        artist: 'The Placeholders',
        content: { format: 'tab', text: 'e|--0--|' },
        sourceUrl: 'https://www.example.com/tab/1',
      };
      importSongFromUrl.mockResolvedValue(draft);
      const res = await request(app)
        .post('/api/brain/songbook/import/url')
        .send({ url: 'https://www.example.com/tab/1' });
      expect(res.status).toBe(200);
      expect(res.body.draft).toEqual(draft);
      expect(importSongFromUrl).toHaveBeenCalledWith('https://www.example.com/tab/1');
    });

    it('400s on a non-URL', async () => {
      const res = await request(app)
        .post('/api/brain/songbook/import/url')
        .send({ url: 'not a url' });
      expect(res.status).toBe(400);
      expect(importSongFromUrl).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // ATTACHMENTS
  // ===========================================================================

  describe('POST /api/brain/songbook/:id/attachments', () => {
    it('writes bytes, hashes them, and appends meta to the record', async () => {
      const song = baseSong();
      brainStorage.getById.mockResolvedValue(song);
      brainStorage.update.mockImplementation(async (type, id, fields) => ({ ...song, ...fields }));

      const payload = Buffer.from('invented sheet music');
      const res = await request(app)
        .post(`/api/brain/songbook/${SONG_ID}/attachments`)
        .send({ filename: 'sheet.txt', data: payload.toString('base64'), label: 'Lead sheet' });

      expect(res.status).toBe(201);
      const { attachment } = res.body;
      expect(attachment.filename).toMatch(/^[0-9a-f]{8}-sheet\.txt$/);
      expect(attachment.label).toBe('Lead sheet');
      expect(attachment.mime).toBe('text/plain');
      expect(attachment.size).toBe(payload.length);
      expect(attachment.sha256).toBe(createHash('sha256').update(payload).digest('hex'));

      // Bytes landed in the machine-local songbook dir
      const filepath = join(songbookDir(), attachment.filename);
      expect(existsSync(filepath)).toBe(true);
      expect(readFileSync(filepath, 'utf-8')).toBe('invented sheet music');

      // Meta appended via the entity store (federates with the record)
      expect(brainStorage.update).toHaveBeenCalledWith('songs', SONG_ID, {
        attachments: [attachment],
      });
    });

    it('accepts MIDI files (songbook-specific allowlist extension)', async () => {
      brainStorage.getById.mockResolvedValue(baseSong());
      brainStorage.update.mockImplementation(async (type, id, fields) => ({ ...baseSong(), ...fields }));
      const res = await request(app)
        .post(`/api/brain/songbook/${SONG_ID}/attachments`)
        .send({ filename: 'melody.mid', data: Buffer.from('MThd').toString('base64') });
      expect(res.status).toBe(201);
      expect(res.body.attachment.mime).toBe('audio/midi');
    });

    it('rejects disallowed extensions', async () => {
      brainStorage.getById.mockResolvedValue(baseSong());
      const res = await request(app)
        .post(`/api/brain/songbook/${SONG_ID}/attachments`)
        .send({ filename: 'app.exe', data: Buffer.from('nope').toString('base64') });
      expect(res.status).toBe(400);
      expect(brainStorage.update).not.toHaveBeenCalled();
    });

    it('404s when the song is missing', async () => {
      brainStorage.getById.mockResolvedValue(null);
      const res = await request(app)
        .post(`/api/brain/songbook/${SONG_ID}/attachments`)
        .send({ filename: 'sheet.txt', data: Buffer.from('x').toString('base64') });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/brain/songbook/:id/attachments', () => {
    it('reports present:true only for bytes that exist locally', async () => {
      mkdirSync(songbookDir(), { recursive: true });
      writeFileSync(join(songbookDir(), 'aaaaaaaa-here.txt'), 'local bytes');
      const song = baseSong({
        attachments: [
          { filename: 'aaaaaaaa-here.txt', label: '', mime: 'text/plain', size: 11, sha256: 'a'.repeat(64) },
          { filename: 'bbbbbbbb-elsewhere.pdf', label: '', mime: 'application/pdf', size: 5, sha256: 'b'.repeat(64) },
        ],
      });
      brainStorage.getById.mockResolvedValue(song);

      const res = await request(app).get(`/api/brain/songbook/${SONG_ID}/attachments`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0]).toMatchObject({ filename: 'aaaaaaaa-here.txt', present: true });
      expect(res.body[1]).toMatchObject({ filename: 'bbbbbbbb-elsewhere.pdf', present: false });
    });
  });

  describe('GET /api/brain/songbook/:id/attachments/:filename', () => {
    it('serves local bytes with nosniff', async () => {
      mkdirSync(songbookDir(), { recursive: true });
      writeFileSync(join(songbookDir(), 'cccccccc-serve.txt'), 'serve me');
      brainStorage.getById.mockResolvedValue(baseSong({
        attachments: [{ filename: 'cccccccc-serve.txt', label: '', mime: 'text/plain', size: 8, sha256: 'c'.repeat(64) }],
      }));

      const res = await request(app).get(`/api/brain/songbook/${SONG_ID}/attachments/cccccccc-serve.txt`);
      expect(res.status).toBe(200);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.text).toBe('serve me');
    });

    it('404s for a filename not on the record (even if a file exists)', async () => {
      mkdirSync(songbookDir(), { recursive: true });
      writeFileSync(join(songbookDir(), 'dddddddd-orphan.txt'), 'orphan');
      brainStorage.getById.mockResolvedValue(baseSong({ attachments: [] }));
      const res = await request(app).get(`/api/brain/songbook/${SONG_ID}/attachments/dddddddd-orphan.txt`);
      expect(res.status).toBe(404);
    });

    it('404s with NOT_ON_THIS_MACHINE when meta is synced but bytes are absent', async () => {
      brainStorage.getById.mockResolvedValue(baseSong({
        attachments: [{ filename: 'eeeeeeee-remote.pdf', label: '', mime: 'application/pdf', size: 5, sha256: 'e'.repeat(64) }],
      }));
      const res = await request(app).get(`/api/brain/songbook/${SONG_ID}/attachments/eeeeeeee-remote.pdf`);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).toContain('NOT_ON_THIS_MACHINE');
    });
  });

  describe('DELETE /api/brain/songbook/:id/attachments/:filename', () => {
    it('removes the meta from the record and deletes local bytes', async () => {
      mkdirSync(songbookDir(), { recursive: true });
      const filepath = join(songbookDir(), 'ffffffff-gone.txt');
      writeFileSync(filepath, 'delete me');
      const meta = { filename: 'ffffffff-gone.txt', label: '', mime: 'text/plain', size: 9, sha256: 'f'.repeat(64) };
      const song = baseSong({ attachments: [meta] });
      brainStorage.getById.mockResolvedValue(song);
      brainStorage.update.mockImplementation(async (type, id, fields) => ({ ...song, ...fields }));

      const res = await request(app).delete(`/api/brain/songbook/${SONG_ID}/attachments/ffffffff-gone.txt`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, filename: 'ffffffff-gone.txt', attachments: [] });
      expect(brainStorage.update).toHaveBeenCalledWith('songs', SONG_ID, { attachments: [] });
      expect(existsSync(filepath)).toBe(false);
    });

    it('404s for a meta not on the record', async () => {
      brainStorage.getById.mockResolvedValue(baseSong({ attachments: [] }));
      const res = await request(app).delete(`/api/brain/songbook/${SONG_ID}/attachments/nope.txt`);
      expect(res.status).toBe(404);
      expect(brainStorage.update).not.toHaveBeenCalled();
    });
  });
});
