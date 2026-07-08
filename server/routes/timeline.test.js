import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// The importer service is exercised via its own unit suite; here we only assert
// the route wiring: multipart parse → validation → service call → temp cleanup.
vi.mock('../services/spotifyImport.js', () => ({
  importSpotifyHistory: vi.fn(async (file, opts) => ({
    dryRun: Boolean(opts?.dryRun),
    parsed: 3,
    mapped: 2,
    recorded: opts?.dryRun ? 0 : 2,
    skipped: opts?.dryRun ? 0 : 1,
    summary: { plays: 2, uniqueTracks: 2, totalMs: 1000, from: null, to: null, topArtists: [] },
  })),
}));

vi.mock('../services/takeoutLocationImport.js', () => ({
  importTakeoutLocationHistory: vi.fn(async (file, opts) => ({
    dryRun: Boolean(opts?.dryRun),
    parsed: 2,
    mapped: 2,
    recorded: opts?.dryRun ? 0 : 2,
    skipped: opts?.dryRun ? 0 : 0,
    summary: { visits: 2, uniquePlaces: 2, from: null, to: null, topPlaces: [] },
  })),
}));

vi.mock('../services/discordImport.js', () => ({
  importDiscordHistory: vi.fn(async (file, opts) => ({
    dryRun: Boolean(opts?.dryRun),
    parsed: 4,
    mapped: 4,
    recorded: opts?.dryRun ? 0 : 4,
    skipped: opts?.dryRun ? 0 : 0,
    summary: { messages: 4, uniqueChannels: 2, from: null, to: null, topChannels: [] },
  })),
}));

vi.mock('../services/whatsappImport.js', () => ({
  importWhatsappHistory: vi.fn(async (file, opts) => ({
    dryRun: Boolean(opts?.dryRun),
    parsed: 3,
    mapped: 2,
    recorded: opts?.dryRun ? 0 : 2,
    skipped: opts?.dryRun ? 0 : 0,
    summary: { messages: 2, uniqueSenders: 2, from: null, to: null, topSenders: [], chatTitle: null },
  })),
}));

vi.mock('../services/browserHistoryImport.js', () => ({
  importBrowserHistory: vi.fn(async (file, opts) => ({
    dryRun: Boolean(opts?.dryRun),
    parsed: 4,
    mapped: 2,
    recorded: opts?.dryRun ? 0 : 2,
    skipped: opts?.dryRun ? 0 : 2,
    summary: { visits: 2, uniqueHosts: 2, from: null, to: null, topHosts: [] },
  })),
}));

vi.mock('../services/humanActivity.js', () => ({
  getDaySummary: vi.fn(async () => ({ date: '2026-07-07', events: [] })),
  listEvents: vi.fn(async () => []),
}));

import { importSpotifyHistory } from '../services/spotifyImport.js';
import { importTakeoutLocationHistory } from '../services/takeoutLocationImport.js';
import { importDiscordHistory } from '../services/discordImport.js';
import { importWhatsappHistory } from '../services/whatsappImport.js';
import { importBrowserHistory } from '../services/browserHistoryImport.js';
import timelineRoutes from './timeline.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/timeline', timelineRoutes);
  app.use(errorMiddleware);
  return app;
}

// Build a minimal multipart/form-data body with one file part + optional fields.
function multipart(fields, file) {
  const boundary = '----portostest' + Math.random().toString(16).slice(2);
  const parts = [];
  for (const [name, value] of Object.entries(fields || {})) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ));
  }
  if (file) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\n` +
      `Content-Type: ${file.contentType}\r\n\r\n`,
    ));
    parts.push(Buffer.from(file.content));
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(parts) };
}

describe('timeline import routes', () => {
  let app;
  beforeEach(() => { app = makeApp(); vi.clearAllMocks(); });

  it('POST /import/spotify parses the upload and calls the importer (real import)', async () => {
    const { boundary, body } = multipart(
      { preview: 'false' },
      { filename: 'history.json', contentType: 'application/json', content: '[]' },
    );
    const r = await request(app).post('/api/timeline/import/spotify')
      .set('content-type', `multipart/form-data; boundary=${boundary}`)
      .send(body);
    expect(r.status).toBe(200);
    expect(r.body.recorded).toBe(2);
    expect(importSpotifyHistory).toHaveBeenCalledWith(
      expect.objectContaining({ originalname: 'history.json' }),
      { dryRun: false },
    );
  });

  it('honors preview=true as a dry run', async () => {
    const { boundary, body } = multipart(
      { preview: 'true' },
      { filename: 'history.json', contentType: 'application/json', content: '[]' },
    );
    const r = await request(app).post('/api/timeline/import/spotify')
      .set('content-type', `multipart/form-data; boundary=${boundary}`)
      .send(body);
    expect(r.status).toBe(200);
    expect(r.body.dryRun).toBe(true);
    expect(r.body.recorded).toBe(0);
    expect(importSpotifyHistory).toHaveBeenCalledWith(expect.anything(), { dryRun: true });
  });

  it('defaults preview to false when the field is absent', async () => {
    const { boundary, body } = multipart(
      {},
      { filename: 'export.zip', contentType: 'application/zip', content: 'PK...' },
    );
    const r = await request(app).post('/api/timeline/import/spotify')
      .set('content-type', `multipart/form-data; boundary=${boundary}`)
      .send(body);
    expect(r.status).toBe(200);
    expect(importSpotifyHistory).toHaveBeenCalledWith(expect.anything(), { dryRun: false });
  });

  it('400s on an unrecognized preview token instead of silently importing', async () => {
    const { boundary, body } = multipart(
      { preview: 'maybe' },
      { filename: 'history.json', contentType: 'application/json', content: '[]' },
    );
    const r = await request(app).post('/api/timeline/import/spotify')
      .set('content-type', `multipart/form-data; boundary=${boundary}`)
      .send(body);
    expect(r.status).toBe(400);
    expect(importSpotifyHistory).not.toHaveBeenCalled();
  });

  it('rejects a disallowed file type with 400', async () => {
    const { boundary, body } = multipart(
      {},
      { filename: 'notes.txt', contentType: 'text/plain', content: 'hi' },
    );
    const r = await request(app).post('/api/timeline/import/spotify')
      .set('content-type', `multipart/form-data; boundary=${boundary}`)
      .send(body);
    expect(r.status).toBe(400);
    expect(importSpotifyHistory).not.toHaveBeenCalled();
  });

  it('400s when no file part is present', async () => {
    const { boundary, body } = multipart({ preview: 'false' }, null);
    const r = await request(app).post('/api/timeline/import/spotify')
      .set('content-type', `multipart/form-data; boundary=${boundary}`)
      .send(body);
    expect(r.status).toBe(400);
    expect(importSpotifyHistory).not.toHaveBeenCalled();
  });

  it('POST /import/takeout-location parses the upload and calls the importer', async () => {
    const { boundary, body } = multipart(
      { preview: 'false' },
      { filename: '2021_MARCH.json', contentType: 'application/json', content: '{}' },
    );
    const r = await request(app).post('/api/timeline/import/takeout-location')
      .set('content-type', `multipart/form-data; boundary=${boundary}`)
      .send(body);
    expect(r.status).toBe(200);
    expect(r.body.recorded).toBe(2);
    expect(importTakeoutLocationHistory).toHaveBeenCalledWith(
      expect.objectContaining({ originalname: '2021_MARCH.json' }),
      { dryRun: false },
    );
  });

  it('takeout-location honors preview=true as a dry run', async () => {
    const { boundary, body } = multipart(
      { preview: 'true' },
      { filename: 'export.zip', contentType: 'application/zip', content: 'PK...' },
    );
    const r = await request(app).post('/api/timeline/import/takeout-location')
      .set('content-type', `multipart/form-data; boundary=${boundary}`)
      .send(body);
    expect(r.status).toBe(200);
    expect(r.body.dryRun).toBe(true);
    expect(r.body.recorded).toBe(0);
    expect(importTakeoutLocationHistory).toHaveBeenCalledWith(expect.anything(), { dryRun: true });
  });

  it('takeout-location 400s on an unrecognized preview token', async () => {
    const { boundary, body } = multipart(
      { preview: 'maybe' },
      { filename: 'x.json', contentType: 'application/json', content: '{}' },
    );
    const r = await request(app).post('/api/timeline/import/takeout-location')
      .set('content-type', `multipart/form-data; boundary=${boundary}`)
      .send(body);
    expect(r.status).toBe(400);
    expect(importTakeoutLocationHistory).not.toHaveBeenCalled();
  });

  it('POST /import/discord parses the upload and calls the importer', async () => {
    const { boundary, body } = multipart(
      { preview: 'false' },
      { filename: 'package.zip', contentType: 'application/zip', content: 'PK...' },
    );
    const r = await request(app).post('/api/timeline/import/discord')
      .set('content-type', `multipart/form-data; boundary=${boundary}`)
      .send(body);
    expect(r.status).toBe(200);
    expect(r.body.recorded).toBe(4);
    expect(importDiscordHistory).toHaveBeenCalledWith(
      expect.objectContaining({ originalname: 'package.zip' }),
      { dryRun: false },
    );
  });

  it('discord accepts a messages.csv upload', async () => {
    const { boundary, body } = multipart(
      { preview: 'true' },
      { filename: 'messages.csv', contentType: 'text/csv', content: 'ID,Timestamp\n1,2023-01-01 00:00:00\n' },
    );
    const r = await request(app).post('/api/timeline/import/discord')
      .set('content-type', `multipart/form-data; boundary=${boundary}`)
      .send(body);
    expect(r.status).toBe(200);
    expect(r.body.dryRun).toBe(true);
    expect(importDiscordHistory).toHaveBeenCalledWith(expect.anything(), { dryRun: true });
  });

  it('discord rejects a disallowed file type with 400', async () => {
    const { boundary, body } = multipart(
      {},
      { filename: 'notes.txt', contentType: 'text/plain', content: 'hi' },
    );
    const r = await request(app).post('/api/timeline/import/discord')
      .set('content-type', `multipart/form-data; boundary=${boundary}`)
      .send(body);
    expect(r.status).toBe(400);
    expect(importDiscordHistory).not.toHaveBeenCalled();
  });

  it('POST /import/whatsapp parses a .txt upload and calls the importer', async () => {
    const { boundary, body } = multipart(
      { preview: 'false' },
      { filename: 'WhatsApp Chat with Alice.txt', contentType: 'text/plain', content: '[2024-01-15, 6:30:45 PM] Alice: hi\n' },
    );
    const r = await request(app).post('/api/timeline/import/whatsapp')
      .set('content-type', `multipart/form-data; boundary=${boundary}`)
      .send(body);
    expect(r.status).toBe(200);
    expect(r.body.recorded).toBe(2);
    expect(importWhatsappHistory).toHaveBeenCalledWith(
      expect.objectContaining({ originalname: 'WhatsApp Chat with Alice.txt' }),
      { dryRun: false, yourName: null, chatLabel: null },
    );
  });

  it('whatsapp accepts a zipped export as a preview dry run', async () => {
    const { boundary, body } = multipart(
      { preview: 'true' },
      { filename: 'WhatsApp Chat - Alice.zip', contentType: 'application/zip', content: 'PK...' },
    );
    const r = await request(app).post('/api/timeline/import/whatsapp')
      .set('content-type', `multipart/form-data; boundary=${boundary}`)
      .send(body);
    expect(r.status).toBe(200);
    expect(r.body.dryRun).toBe(true);
    expect(importWhatsappHistory).toHaveBeenCalledWith(expect.anything(), { dryRun: true, yourName: null, chatLabel: null });
  });

  it('whatsapp threads yourName through for direction inference', async () => {
    const { boundary, body } = multipart(
      { preview: 'false', yourName: 'Alice' },
      { filename: 'WhatsApp Chat with Bob.txt', contentType: 'text/plain', content: '[2024-01-15, 6:30:45 PM] Alice: hi\n' },
    );
    const r = await request(app).post('/api/timeline/import/whatsapp')
      .set('content-type', `multipart/form-data; boundary=${boundary}`)
      .send(body);
    expect(r.status).toBe(200);
    expect(importWhatsappHistory).toHaveBeenCalledWith(expect.anything(), { dryRun: false, yourName: 'Alice', chatLabel: null });
  });

  it('whatsapp treats a blank yourName field as not provided (neutral)', async () => {
    const { boundary, body } = multipart(
      { preview: 'false', yourName: '   ' },
      { filename: 'WhatsApp Chat with Bob.txt', contentType: 'text/plain', content: '[2024-01-15, 6:30:45 PM] Alice: hi\n' },
    );
    const r = await request(app).post('/api/timeline/import/whatsapp')
      .set('content-type', `multipart/form-data; boundary=${boundary}`)
      .send(body);
    expect(r.status).toBe(200);
    expect(importWhatsappHistory).toHaveBeenCalledWith(expect.anything(), { dryRun: false, yourName: null, chatLabel: null });
  });

  it('whatsapp threads chatLabel through as the dedupe scope, blank → null', async () => {
    const withLabel = multipart(
      { preview: 'false', chatLabel: 'Family group' },
      { filename: '_chat.txt', contentType: 'text/plain', content: '[2024-01-15, 6:30:45 PM] Alice: hi\n' },
    );
    let r = await request(app).post('/api/timeline/import/whatsapp')
      .set('content-type', `multipart/form-data; boundary=${withLabel.boundary}`)
      .send(withLabel.body);
    expect(r.status).toBe(200);
    expect(importWhatsappHistory).toHaveBeenCalledWith(expect.anything(), { dryRun: false, yourName: null, chatLabel: 'Family group' });

    const blankLabel = multipart(
      { preview: 'false', chatLabel: '   ' },
      { filename: '_chat.txt', contentType: 'text/plain', content: '[2024-01-15, 6:30:45 PM] Alice: hi\n' },
    );
    r = await request(app).post('/api/timeline/import/whatsapp')
      .set('content-type', `multipart/form-data; boundary=${blankLabel.boundary}`)
      .send(blankLabel.body);
    expect(r.status).toBe(200);
    expect(importWhatsappHistory).toHaveBeenLastCalledWith(expect.anything(), { dryRun: false, yourName: null, chatLabel: null });
  });

  it('whatsapp rejects a disallowed file type with 400', async () => {
    const { boundary, body } = multipart(
      {},
      { filename: 'data.json', contentType: 'application/json', content: '{}' },
    );
    const r = await request(app).post('/api/timeline/import/whatsapp')
      .set('content-type', `multipart/form-data; boundary=${boundary}`)
      .send(body);
    expect(r.status).toBe(400);
    expect(importWhatsappHistory).not.toHaveBeenCalled();
  });

  it('POST /import/browser parses a History.json upload and calls the importer', async () => {
    const { boundary, body } = multipart(
      { preview: 'false' },
      { filename: 'History.json', contentType: 'application/json', content: '{"Browser History":[]}' },
    );
    const r = await request(app).post('/api/timeline/import/browser')
      .set('content-type', `multipart/form-data; boundary=${boundary}`)
      .send(body);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ recorded: 2, mapped: 2 });
    expect(importBrowserHistory).toHaveBeenCalledWith(expect.anything(), { dryRun: false });
  });

  it('browser honors preview=true as a dry run', async () => {
    const { boundary, body } = multipart(
      { preview: 'true' },
      { filename: 'Takeout.zip', contentType: 'application/zip', content: 'PK\x03\x04zip' },
    );
    const r = await request(app).post('/api/timeline/import/browser')
      .set('content-type', `multipart/form-data; boundary=${boundary}`)
      .send(body);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ dryRun: true, recorded: 0 });
    expect(importBrowserHistory).toHaveBeenCalledWith(expect.anything(), { dryRun: true });
  });

  it('browser rejects a disallowed file type with 400', async () => {
    const { boundary, body } = multipart(
      {},
      { filename: 'history.txt', contentType: 'text/plain', content: 'nope' },
    );
    const r = await request(app).post('/api/timeline/import/browser')
      .set('content-type', `multipart/form-data; boundary=${boundary}`)
      .send(body);
    expect(r.status).toBe(400);
    expect(importBrowserHistory).not.toHaveBeenCalled();
  });
});
