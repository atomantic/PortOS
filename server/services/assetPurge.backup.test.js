import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { acquireBackupSnapshotCut } from '../lib/backupSnapshotBoundary.js';

const fixture = vi.hoisted(() => ({ root: null, beforeDelete: null }));
vi.mock('../lib/fileUtils.js', async importOriginal => {
  const actual = await importOriginal();
  fixture.root = await mkdtemp(join(tmpdir(), 'portos-asset-purge-'));
  return { ...actual, PATHS: { ...actual.PATHS, data: fixture.root,
    images: join(fixture.root, 'images'), uploads: join(fixture.root, 'uploads'),
    cosAttachments: join(fixture.root, 'attachments') },
  rmGuarded: async (...args) => { await fixture.beforeDelete?.(); return actual.rmGuarded(...args); },
  unlinkGuarded: async (...args) => { await fixture.beforeDelete?.(); return actual.unlinkGuarded(...args); } };
});
const { purgeCategory } = await import('./dataManager.js');
const { default: uploads } = await import('../routes/uploads.js');
const { default: attachments } = await import('../routes/attachments.js');
const app = express();
app.use('/uploads', uploads);
app.use('/attachments', attachments);
app.use(errorMiddleware);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

beforeEach(async () => {
  fixture.beforeDelete = null;
  for (const folder of ['images', 'messages', 'uploads', 'attachments']) {
    await mkdir(join(fixture.root, folder), { recursive: true });
    await writeFile(join(fixture.root, folder, 'one.txt'), 'first');
    await writeFile(join(fixture.root, folder, 'two.txt'), 'second');
  }
});
afterAll(() => rm(fixture.root, { recursive: true, force: true }));

describe('operator file purges drain before a backup copies files', () => {
  it.each([
    ['category item', 'images', false, () => purgeCategory('images', { subPath: 'one.txt' })],
    ['category bulk', 'messages', true, () => purgeCategory('messages')],
    ['upload item', 'uploads', false, () => request(app).delete('/uploads/one.txt')],
    ['upload bulk', 'uploads', true, () => request(app).delete('/uploads?confirm=true')],
    ['attachment', 'attachments', false, () => request(app).delete('/attachments/one.txt')],
  ])('%s finishes all removals before the snapshot begins', async (_name, folder, bulk, invoke) => {
    const entered = deferred();
    const proceed = deferred();
    fixture.beforeDelete = async () => { entered.resolve(); await proceed.promise; };
    const operation = Promise.resolve(invoke());
    await entered.promise;
    let acquired = false;
    const cut = acquireBackupSnapshotCut().then(release => { acquired = true; return release; });
    try {
      await new Promise(resolve => setImmediate(resolve));
      expect(acquired, 'a snapshot must wait for the entire admitted deletion').toBe(false);
      expect(await readFile(join(fixture.root, folder, 'one.txt'), 'utf8')).toBe('first');
    } finally {
      proceed.resolve();
      await operation;
      const release = await cut;
      release();
    }
    await expect(readFile(join(fixture.root, folder, 'one.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    if (bulk) await expect(readFile(join(fixture.root, folder, 'two.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    else expect(await readFile(join(fixture.root, folder, 'two.txt'), 'utf8')).toBe('second');
  });
});
