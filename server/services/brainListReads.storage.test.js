// Read-count regression for the Brain list surfaces (#17369): a list view must
// not read (loadOne) record bodies it does not return. Runs against the real
// per-record stores in a temp data root and counts body reads.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('brain-list-reads-'),
}));
vi.mock('./instanceIdentity.js', () => ({ getInstanceId: async () => 'local-instance' }));
vi.mock('./obsidian.js', () => ({ upsertNote: vi.fn(), deleteNote: vi.fn() }));

import * as journal from './brainJournal.js';
import * as storage from './brainStorage.js';
import songRoutes from '../routes/brainSongbook.js';
import threadRoutes from '../routes/brainThreads.js';

const storeOf = (type) => storage.brainCollectionStores().find((s) => s.type === type);
const app = express();
app.use(express.json());
app.use('/api/brain/songbook', songRoutes);
app.use('/api/brain/threads', threadRoutes);
app.use(errorMiddleware);

// Spy on body reads for one store; returns the ids read.
const watchReads = (type) => {
  const store = storeOf(type);
  const spy = vi.spyOn(store, 'loadOne');
  return { ids: () => spy.mock.calls.map(([id]) => id), reset: () => spy.mockClear() };
};

const day = (n) => `2026-03-${String(n).padStart(2, '0')}`;
const seedDay = (date, content = `text ${date}`) => storeOf('journals').saveOneNow(date, {
  date, content, segments: [{ text: content, at: '2026-03-01T00:00:00.000Z', source: 'text' }],
  createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z',
});

beforeEach(async () => {
  vi.restoreAllMocks();
  // Shared temp root: start every test from empty stores.
  for (const type of ['journals', 'songs', 'threads']) {
    const store = storeOf(type);
    for (const id of await store.listIds()) await store.deleteOneNow(id);
  }
  storage.invalidateAllCaches();
  journal._clearObsidianLocationsCacheForTest();
});
afterAll(cleanupTempDataRoots);

describe('journal list reads', () => {
  it('listJournals({ limit: 1 }) reads only the newest live body and skips tombstones', async () => {
    for (let n = 1; n <= 5; n += 1) await seedDay(day(n));
    await journal.deleteJournal(day(5));
    const reads = watchReads('journals');

    const { records } = await journal.listJournals({ limit: 1 });

    expect(records.map((r) => r.date)).toEqual([day(4)]);
    expect(records[0]).not.toHaveProperty('content');
    // The tombstoned newest day is opened (and dropped); older days are untouched.
    expect(reads.ids().sort()).toEqual([day(4), day(5)]);

    const full = await journal.listJournals({ limit: 1, includeContent: true });
    expect(full.records[0].content).toBe(`text ${day(4)}`);
  });

  it('does not read a corrupt record outside the requested page', async () => {
    for (let n = 1; n <= 3; n += 1) await seedDay(day(n));
    const { writeFile } = await import('fs/promises');
    await writeFile(storeOf('journals').recordPath(day(1)), '{not json');
    const reads = watchReads('journals');
    const { records } = await journal.listJournals({ limit: 2 });
    expect(records.map((r) => r.date)).toEqual([day(3), day(2)]);
    expect(reads.ids()).not.toContain(day(1));
  });

  it('listJournals pages by live offset past a tombstone', async () => {
    for (let n = 1; n <= 4; n += 1) await seedDay(day(n));
    await journal.deleteJournal(day(3));
    const { records } = await journal.listJournals({ limit: 2, offset: 1 });
    expect(records.map((r) => r.date)).toEqual([day(2), day(1)]);
  });

  it('iterateJournals yields every live day once and reads each body once beyond 100 days', async () => {
    const dates = [];
    for (let i = 0; i < 130; i += 1) {
      const date = new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
      dates.push(date);
      await seedDay(date);
    }
    const reads = watchReads('journals');

    const seen = [];
    for await (const entry of journal.iterateJournals()) seen.push(entry);

    expect(seen.map((e) => e.date)).toEqual([...dates].sort().reverse());
    expect(seen[0].content).toBe(`text ${seen[0].date}`);
    expect(reads.ids()).toHaveLength(130);
    expect(new Set(reads.ids()).size).toBe(130);
  });
});

describe('songbook list reads', () => {
  it('serves a warm list without body reads and tracks writes and deletes', async () => {
    const a = await storage.create('songs', { title: 'Alpha', content: { format: 'chordpro', text: 'x'.repeat(5000) }, attachments: [] });
    const b = await storage.create('songs', { title: 'Beta', content: { format: 'tab', text: 'y' }, attachments: [] });

    const first = await request(app).get('/api/brain/songbook');
    expect(first.body.songs.map((s) => s.title).sort()).toEqual(['Alpha', 'Beta']);
    expect(first.body.songs.find((s) => s.id === a.id).content).toEqual({ format: 'chordpro' });

    const reads = watchReads('songs');
    await request(app).get('/api/brain/songbook');
    expect(reads.ids()).toEqual([]);

    await storage.update('songs', a.id, { title: 'Alpha 2' });
    await storage.remove('songs', b.id);
    reads.reset();
    const next = await request(app).get('/api/brain/songbook');
    expect(next.body.songs.map((s) => s.title)).toEqual(['Alpha 2']);
    // Only the two written ids are re-read (the tombstone replaces Beta's row).
    expect(reads.ids().sort()).toEqual([a.id, b.id].sort());
  });
});

describe('thread list reads', () => {
  it('serves a warm list without body reads, still searches notes and ref labels, and omits notes', async () => {
    const t1 = await storage.create('threads', { title: 'One', status: 'open', notes: 'registrar paperwork', refs: [], tags: [] });
    const t2 = await storage.create('threads', {
      title: 'Two', status: 'open', notes: '', tags: [],
      refs: [{ kind: 'github.issue', id: 'x', label: 'Fix the Frobnicator' }],
    });

    const first = await request(app).get('/api/brain/threads');
    expect(first.body.threads).toHaveLength(2);
    expect(first.body.threads.every((t) => !('notes' in t))).toBe(true);

    const reads = watchReads('threads');
    await request(app).get('/api/brain/threads');
    expect(reads.ids()).toEqual([]);

    const byNotes = await request(app).get('/api/brain/threads?q=REGISTRAR');
    expect(byNotes.body.threads.map((t) => t.id)).toEqual([t1.id]);
    expect(byNotes.body.threads[0]).not.toHaveProperty('notes');
    const byRef = await request(app).get('/api/brain/threads?q=frobnicator');
    expect(byRef.body.threads.map((t) => t.id)).toEqual([t2.id]);

    await storage.updateWith('threads', t1.id, () => ({ title: 'One renamed' }));
    await storage.remove('threads', t2.id);
    const next = await request(app).get('/api/brain/threads');
    expect(next.body.threads.map((t) => t.title)).toEqual(['One renamed']);
  });
});
