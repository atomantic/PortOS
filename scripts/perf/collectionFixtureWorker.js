import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { CARDINALITIES, ACCOUNT_IDS, mediaFixture, messageFixture } from './collectionFixtureData.js';

// This is the only worker entrypoint. Validate BEFORE dynamic server imports.
const root = process.cwd();
const schema = process.env.COLLECTION_FIXTURE_SCHEMA;
if (process.env.PORTOS_DATA_ROOT !== root || !/^[\s\S]*[\\/]portos-collection-audit-[^\\/]+$/.test(root)
    || process.env.PGDATABASE !== 'portos_test' || !/^collection_audit_[a-f0-9]{32}$/.test(schema || '')
    || process.env.PGOPTIONS !== '-csearch_path=' + schema || process.env.NODE_ENV !== 'production'
    || process.env.VITEST || !process.send) {
  throw new Error('Invalid isolated collection worker environment');
}

let server;
let io;
let db;
let closing;
let phase = 'imports';
const close = () => closing ||= (async () => {
  if (server) {
    if (io) await new Promise(resolveIo => io.close(resolveIo));
    server.closeAllConnections();
    await new Promise(resolveClose => server.close(resolveClose));
  }
  await db?.close();
  if (process.connected) process.disconnect();
})();
const stop = () => { close().catch(() => { process.exitCode = 1; }); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
process.once('disconnect', stop);

async function start() {
  const require = createRequire(join(root, 'server/package.json'));
  const express = require('express');
  const sharp = require('sharp');
  db = await import('../../server/lib/db.js');
  const { PATHS } = await import('../../server/lib/paths.js');
  if (resolve(PATHS.data) !== join(root, 'data')) throw new Error('Fixture data root mismatch');
  phase = 'database';
  const identity = await db.query('SELECT current_database() AS db, current_schema() AS schema');
  if (identity.rows[0].db !== 'portos_test' || identity.rows[0].schema !== schema) throw new Error('Fixture DB isolation mismatch');
  const { mediaDdl } = await import('../../server/lib/db/schema/media.js');
  // Reuse the canonical table/index declarations without booting other domains.
  for (const sql of mediaDdl.filter(sql => /CREATE (TABLE IF NOT EXISTS media_assets\b|INDEX IF NOT EXISTS idx_media_assets_kind_created\b)/.test(sql))) {
    await db.query(sql);
  }
  const { upsertAsset } = await import('../../server/services/mediaAssetIndex/db.js');
  const { imageToRow, videoToRow } = await import('../../server/services/mediaAssetIndex/logic.js');
  await Promise.all(['images', 'videos', 'video-thumbnails', 'messages/cache'].map(dir => mkdir(join(PATHS.data, dir), { recursive: true })));
  const png = await sharp({ create: { width: 640, height: 360, channels: 3, background: '#335577' } }).png().toBuffer();
  phase = 'media-seed';
  for (let index = 0; index < CARDINALITIES.images; index++) {
    const image = mediaFixture('image', index);
    await writeFile(join(PATHS.images, image.filename), png);
    await writeFile(join(PATHS.images, image.filename.replace('.png', '.metadata.json')), JSON.stringify(image));
    await upsertAsset(imageToRow(image));
  }
  const clip = await readFile(join(root, 'scripts/perf/assets/synthetic.mp4'));
  const videos = [];
  for (let index = 0; index < CARDINALITIES.videos; index++) {
    const video = mediaFixture('video', index);
    videos.push(video);
    await writeFile(join(PATHS.data, 'videos', video.filename), clip);
    await writeFile(join(PATHS.data, 'video-thumbnails', video.thumbnail), png);
    await upsertAsset(videoToRow(video));
  }
  await writeFile(join(PATHS.data, 'video-history.json'), JSON.stringify(videos));
  phase = 'inbox-seed';
  const accounts = {};
  for (const [accountIndex, id] of ACCOUNT_IDS.entries()) {
    accounts[id] = { id, name: 'Synthetic inbox ' + (accountIndex + 1), type: 'gmail', provider: 'api',
      email: 'fixture' + accountIndex + '@example.com', enabled: false, syncConfig: {}, lastSyncAt: null };
    const messages = Array.from({ length: CARDINALITIES.messages / CARDINALITIES.accounts },
      (_, index) => messageFixture(id, index + accountIndex * CARDINALITIES.messages / CARDINALITIES.accounts));
    await writeFile(join(PATHS.messages, 'cache', id + '.json'), JSON.stringify({ syncCursor: null, messages }));
  }
  await writeFile(join(PATHS.messages, 'accounts.json'), JSON.stringify(accounts));
  await writeFile(join(PATHS.data, 'settings.json'), JSON.stringify({ timezone: 'UTC', instances: [] }));

  phase = 'routes';
  const { createImageGalleryHandlers } = await import('../../server/routes/imageGalleryRead.js');
  const { messageInboxRead, messageDetailRead } = await import('../../server/routes/messageInboxRead.js');
  const { listAccounts } = await import('../../server/services/messageAccounts.js');
  const { errorMiddleware, asyncHandler } = await import('../../server/lib/errorHandler.js');
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set('Content-Security-Policy', "connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'none'; form-action 'none'");
    next();
  });
  app.get('/__fixture/ready', (_req, res) => res.json({ ready: true, cardinalities: CARDINALITIES }));
  app.get('/api/auth/status', (_req, res) => res.json({ enabled: false, authenticated: true }));
  app.get('/api/settings/features', (_req, res) => res.json({ features: [], groups: [] }));
  app.get('/api/settings', (_req, res) => res.json({ timezone: 'UTC' }));
  // Allow only collection reads. Mutation / provider / peer / sync endpoints
  // are absent; no server boot module or scheduler is imported.
  const gallery = express.Router();
  const galleryReads = createImageGalleryHandlers();
  gallery.get('/gallery/collections', galleryReads.collections);
  gallery.get('/gallery/facets', galleryReads.facets);
  gallery.get('/gallery', galleryReads.list);
  app.use('/api/image-gen', (req, res, next) => req.method === 'GET' ? next() : res.sendStatus(405), gallery);
  const messages = express.Router();
  messages.get('/accounts', asyncHandler(async (_req, res) => res.json(await listAccounts())));
  messages.get('/inbox', messageInboxRead);
  messages.get('/:accountId/:messageId', messageDetailRead);
  app.use('/api/messages', messages);
  app.use('/api', (_req, res) => res.status(503).json({ code: 'FIXTURE_UNAVAILABLE', error: 'Outside collection audit fixture scope' }));
  app.use('/data', express.static(PATHS.data, { index: false, dotfiles: 'deny' }));
  app.use(express.static(process.env.COLLECTION_FIXTURE_CLIENT));
  app.get(/.*/, (_req, res) => res.sendFile(join(process.env.COLLECTION_FIXTURE_CLIENT, 'index.html')));
  app.use(errorMiddleware);
  server = await new Promise((resolveListen, rejectListen) => {
    const listener = app.listen(0, '127.0.0.1', () => resolveListen(listener));
    listener.once('error', rejectListen);
  });
  const { Server } = require('socket.io');
  io = new Server(server);
  process.send({ type: 'ready', url: 'http://127.0.0.1:' + server.address().port, cardinalities: CARDINALITIES });
}

start().catch(async () => {
  if (process.connected) process.send({ type: 'failed', phase });
  await close();
  process.exitCode = 1;
});
