import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/brainStorage.js', () => ({
  getAll: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  updateWith: vi.fn(),
  remove: vi.fn(),
}));

// The resolver has its own suite (services/threadRefs.test.js) and reaches
// Postgres; here it is a seam so these tests assert the ROUTE's contract.
vi.mock('../services/threadSync.js', () => ({ syncGithubThreads: vi.fn(async () => ({ created: 1 })) }));

vi.mock('../services/threadRefs.js', () => ({ resolveThreadRefs: vi.fn() }));

import * as brainStorage from '../services/brainStorage.js';
import { resolveThreadRefs } from '../services/threadRefs.js';
import threadRoutes from './brainThreads.js';

const THREAD_ID = '11111111-1111-4111-8111-111111111111';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/brain/threads', threadRoutes);
  app.use(errorMiddleware);
  return app;
};

// Mirror updateWith's contract against a given "fresh" record: run the route's
// fn, capture the partial updates it produced, and return the merged record (or
// null when the record is gone). `seen.updates` lets a test assert exactly what
// the route asked to persist.
const mockUpdateWith = (freshThread) => {
  const seen = { updates: null };
  brainStorage.updateWith.mockImplementation(async (type, id, fn) => {
    if (!freshThread) return null;
    const updates = await fn({ ...freshThread });
    seen.updates = updates;
    return updates ? { ...freshThread, ...updates } : null;
  });
  return seen;
};

const baseThread = (overrides = {}) => ({
  id: THREAD_ID,
  title: 'Renew the domain',
  status: 'open',
  priority: 'normal',
  nextAction: 'Check the registrar',
  notes: 'Long markdown body',
  waitingOn: '',
  dueAt: null,
  tags: [],
  pinned: false,
  refs: [],
  source: null,
  externalState: 'unknown',
  closedAt: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...overrides,
});

describe('Brain Threads routes', () => {
  let app;

  beforeEach(() => {
    vi.clearAllMocks();
    resolveThreadRefs.mockResolvedValue([]);
    app = buildApp();
  });

  it('validates explicit sync requests before dispatch and supplies creation defaults', async () => {
    const { syncGithubThreads } = await import('../services/threadSync.js');
    expect((await request(app).post('/api/brain/threads/sync').send({ appId: 'example-app', source: {} })).status).toBe(400);
    expect(syncGithubThreads).not.toHaveBeenCalled();
    const result = await request(app).post('/api/brain/threads/sync').send({ appId: 'example-app' });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ created: 1 });
    expect(syncGithubThreads).toHaveBeenCalledWith({ appId: 'example-app', pinned: false });
  });

  // ===========================================================================
  // CREATE — server-managed fields
  // ===========================================================================

  it('creates a thread with the defaults the record shape promises', async () => {
    brainStorage.create.mockImplementation(async (type, data) => ({ id: THREAD_ID, ...data }));
    const res = await request(app).post('/api/brain/threads').send({ title: 'Renew the domain' });

    expect(res.status).toBe(201);
    expect(brainStorage.create).toHaveBeenCalledWith('threads', expect.objectContaining({
      title: 'Renew the domain',
      status: 'open',
      priority: 'normal',
      nextAction: '',
      dueAt: null,
      tags: [],
      pinned: false,
      refs: [],
    }));
  });

  it('strips the server-managed fields from a client write', async () => {
    // `source`/`externalState`/`closedAt` belong to the auto-ingest sync. A
    // client that sets them could forge provenance or backdate a completion.
    brainStorage.create.mockImplementation(async (type, data) => ({ id: THREAD_ID, ...data }));
    await request(app).post('/api/brain/threads').send({
      title: 'Forged',
      source: { kind: 'github.issue', key: 'o/r#1' },
      externalState: 'closed',
      closedAt: '2020-01-01T00:00:00.000Z',
    });

    const [, persisted] = brainStorage.create.mock.calls[0];
    expect(persisted.source).toBeNull();
    expect(persisted.externalState).toBe('unknown');
    expect(persisted.closedAt).toBeNull();
  });

  it('stamps closedAt when a thread is born in a terminal status', async () => {
    brainStorage.create.mockImplementation(async (type, data) => ({ id: THREAD_ID, ...data }));
    await request(app).post('/api/brain/threads').send({ title: 'Already done', status: 'done' });
    const [, persisted] = brainStorage.create.mock.calls[0];
    expect(persisted.closedAt).toEqual(expect.any(String));
  });

  it('rejects a thread with no title', async () => {
    const res = await request(app).post('/api/brain/threads').send({ status: 'open' });
    expect(res.status).toBe(400);
    expect(brainStorage.create).not.toHaveBeenCalled();
  });

  // ===========================================================================
  // UPDATE — partial semantics + closedAt lifecycle
  // ===========================================================================

  it('persists only the keys a partial update names', async () => {
    // Defaults-free partial: an omitted key must preserve the stored value
    // rather than resetting it to its schema default.
    const seen = mockUpdateWith(baseThread({ priority: 'high', tags: ['ops'] }));
    const res = await request(app).put(`/api/brain/threads/${THREAD_ID}`)
      .send({ nextAction: 'Email the registrar' });

    expect(res.status).toBe(200);
    expect(seen.updates).toEqual({ nextAction: 'Email the registrar' });
    expect(res.body.priority).toBe('high');
    expect(res.body.tags).toEqual(['ops']);
  });

  it('stamps closedAt on the transition into a terminal status', async () => {
    const seen = mockUpdateWith(baseThread({ status: 'open', closedAt: null }));
    await request(app).put(`/api/brain/threads/${THREAD_ID}`).send({ status: 'done' });
    expect(seen.updates.closedAt).toEqual(expect.any(String));
  });

  it('preserves the original closedAt when a done thread is re-saved', async () => {
    // Re-saving a finished thread must not rewrite when it was finished.
    const seen = mockUpdateWith(baseThread({ status: 'done', closedAt: '2026-09-02T00:00:00.000Z' }));
    await request(app).put(`/api/brain/threads/${THREAD_ID}`).send({ status: 'archived' });
    expect(seen.updates.closedAt).toBe('2026-09-02T00:00:00.000Z');
  });

  it('clears closedAt when a thread is reopened', async () => {
    const seen = mockUpdateWith(baseThread({ status: 'done', closedAt: '2026-09-02T00:00:00.000Z' }));
    await request(app).put(`/api/brain/threads/${THREAD_ID}`).send({ status: 'open' });
    expect(seen.updates.closedAt).toBeNull();
  });

  it('leaves closedAt untouched when the update does not move the status', async () => {
    const seen = mockUpdateWith(baseThread({ status: 'done', closedAt: '2026-09-02T00:00:00.000Z' }));
    await request(app).put(`/api/brain/threads/${THREAD_ID}`).send({ title: 'Renamed' });
    expect(seen.updates).toEqual({ title: 'Renamed' });
  });

  it('404s an update against a thread that is gone', async () => {
    mockUpdateWith(null);
    const res = await request(app).put(`/api/brain/threads/${THREAD_ID}`).send({ title: 'x' });
    expect(res.status).toBe(404);
  });

  // ===========================================================================
  // READ
  // ===========================================================================

  it('hydrates refs on the detail read without mutating the stored array', async () => {
    const stored = [{ kind: 'brain.idea', id: 'idea-1', label: 'cached' }];
    brainStorage.getById.mockResolvedValue(baseThread({ refs: stored }));
    resolveThreadRefs.mockResolvedValue([
      { kind: 'brain.idea', id: 'idea-1', label: 'Live title', url: '/brain/ideas', resolved: true },
    ]);

    const res = await request(app).get(`/api/brain/threads/${THREAD_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.resolvedRefs[0].label).toBe('Live title');
    // The stored array round-trips untouched, so a target this build can't
    // resolve is not quietly stripped by the next write.
    expect(res.body.refs).toEqual(stored);
  });

  it('omits the markdown body from list rows', async () => {
    brainStorage.getAll.mockResolvedValue([baseThread()]);
    const res = await request(app).get('/api/brain/threads');
    expect(res.body.threads[0]).not.toHaveProperty('notes');
    expect(res.body.threads[0].title).toBe('Renew the domain');
  });

  it('filters by status, tag, pinned and refKind', async () => {
    brainStorage.getAll.mockResolvedValue([
      baseThread({ id: 'a', status: 'open', tags: ['ops'], pinned: true, refs: [{ kind: 'github.issue', id: 'https://example.com/1' }] }),
      baseThread({ id: 'b', status: 'waiting', tags: ['ops'], pinned: false, refs: [] }),
      baseThread({ id: 'c', status: 'open', tags: ['home'], pinned: false, refs: [] }),
    ]);

    const ids = async (qs) => (await request(app).get(`/api/brain/threads${qs}`)).body.threads.map((t) => t.id);
    expect(await ids('?status=open')).toEqual(['a', 'c']);
    // The working set is one request — a comma list, not the archive filtered client-side.
    expect(await ids('?status=open,waiting')).toEqual(['a', 'b', 'c']);
    expect((await request(app).get('/api/brain/threads?status=open,bogus')).status).toBe(400);
    expect(await ids('?tag=ops')).toEqual(['a', 'b']);
    expect(await ids('?pinned=true')).toEqual(['a']);
    expect(await ids('?pinned=false')).toEqual(['b', 'c']);
    expect(await ids('?refKind=github.issue')).toEqual(['a']);
  });

  it('searches title, next action and notes with ?q=', async () => {
    brainStorage.getAll.mockResolvedValue([
      baseThread({ id: 'a', title: 'Renew the domain', notes: '' }),
      baseThread({ id: 'b', title: 'Other', nextAction: '', notes: 'registrar paperwork' }),
      baseThread({ id: 'c', title: 'Other', nextAction: '', notes: '' }),
    ]);
    const res = await request(app).get('/api/brain/threads?q=REGISTRAR');
    expect(res.body.threads.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('sorts pinned first, then soonest-due', async () => {
    brainStorage.getAll.mockResolvedValue([
      baseThread({ id: 'undated', dueAt: null, pinned: false }),
      baseThread({ id: 'later', dueAt: '2026-10-01T00:00:00.000Z', pinned: false }),
      baseThread({ id: 'sooner', dueAt: '2026-09-20T00:00:00.000Z', pinned: false }),
      baseThread({ id: 'pinned', dueAt: null, pinned: true }),
    ]);
    const res = await request(app).get('/api/brain/threads');
    expect(res.body.threads.map((t) => t.id)).toEqual(['pinned', 'sooner', 'later', 'undated']);
  });

  it('keeps a total order when two threads share a due date — including none at all', async () => {
    // Regression: two UNDATED threads both key to Infinity, and subtracting
    // them yields NaN. A comparator that returns NaN abandons the remaining
    // tiebreaks, so the order goes engine-defined — and the pagination slice
    // below drops or duplicates rows at its boundary when that happens.
    brainStorage.getAll.mockResolvedValue([
      baseThread({ id: 'c', dueAt: null, updatedAt: '2026-09-01T00:00:00.000Z' }),
      baseThread({ id: 'a', dueAt: null, updatedAt: '2026-09-03T00:00:00.000Z' }),
      baseThread({ id: 'b', dueAt: null, updatedAt: '2026-09-02T00:00:00.000Z' }),
    ]);
    const res = await request(app).get('/api/brain/threads');
    // Falls through to most-recently-touched, which NaN would have skipped.
    expect(res.body.threads.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });
  it('returns the paginated envelope only when a pagination param is passed', async () => {
    brainStorage.getAll.mockResolvedValue([baseThread({ id: 'a' }), baseThread({ id: 'b' })]);
    const plain = await request(app).get('/api/brain/threads');
    expect(plain.body).not.toHaveProperty('limit');
    expect(plain.body.total).toBe(2);

    const paged = await request(app).get('/api/brain/threads?limit=1');
    expect(paged.body).toMatchObject({ total: 2, limit: 1, offset: 0 });
    expect(paged.body.threads).toHaveLength(1);
  });

  it('404s a detail read for a thread that does not exist', async () => {
    brainStorage.getById.mockResolvedValue(null);
    const res = await request(app).get(`/api/brain/threads/${THREAD_ID}`);
    expect(res.status).toBe(404);
  });

  // ===========================================================================
  // REFS
  // ===========================================================================

  it('attaches a ref against the fresh record', async () => {
    const seen = mockUpdateWith(baseThread({ refs: [{ kind: 'brain.idea', id: 'idea-1', label: '' }] }));
    const res = await request(app).post(`/api/brain/threads/${THREAD_ID}/refs`)
      .send({ kind: 'github.issue', id: 'https://github.com/o/r/issues/7', label: 'o/r#7' });

    expect(res.status).toBe(201);
    expect(seen.updates.refs).toEqual([
      { kind: 'brain.idea', id: 'idea-1', label: '' },
      { kind: 'github.issue', id: 'https://github.com/o/r/issues/7', label: 'o/r#7' },
    ]);
    // Same shape as GET /:id, so the client swaps the open record in place
    // instead of paying a second read for the hydrated refs.
    expect(Array.isArray(res.body.resolvedRefs)).toBe(true);
  });

  it('replaces a same-(kind,id) ref in place instead of duplicating it', async () => {
    // Attaching twice — a double click, or an attach racing a peer apply — must
    // be idempotent in ORDER as well as content, so two peers converge.
    const seen = mockUpdateWith(baseThread({
      refs: [
        { kind: 'brain.idea', id: 'idea-1', label: 'stale' },
        { kind: 'app', id: 'app-1', label: 'App' },
      ],
    }));
    await request(app).post(`/api/brain/threads/${THREAD_ID}/refs`)
      .send({ kind: 'brain.idea', id: 'idea-1', label: 'fresh' });

    expect(seen.updates.refs).toEqual([
      { kind: 'brain.idea', id: 'idea-1', label: 'fresh' },
      { kind: 'app', id: 'app-1', label: 'App' },
    ]);
  });

  it('detaches a ref whose id is a full URL', async () => {
    const url = 'https://github.com/o/r/issues/7';
    const seen = mockUpdateWith(baseThread({
      refs: [{ kind: 'github.issue', id: url, label: '' }, { kind: 'app', id: 'app-1', label: '' }],
    }));
    const res = await request(app)
      .delete(`/api/brain/threads/${THREAD_ID}/refs/github.issue/${encodeURIComponent(url)}`);

    expect(res.status).toBe(200);
    expect(seen.updates.refs).toEqual([{ kind: 'app', id: 'app-1', label: '' }]);
  });

  it('canonicalizes a legacy ref kind on write', async () => {
    const seen = mockUpdateWith(baseThread());
    await request(app).post(`/api/brain/threads/${THREAD_ID}/refs`)
      .send({ kind: 'writersRoom', id: 'w1' });
    expect(seen.updates.refs[0].kind).toBe('writers-room');
  });

  it('rejects a ref whose kind is not a slug', async () => {
    const res = await request(app).post(`/api/brain/threads/${THREAD_ID}/refs`)
      .send({ kind: 'Not A Kind!', id: 'x' });
    expect(res.status).toBe(400);
    expect(brainStorage.updateWith).not.toHaveBeenCalled();
  });

  it('accepts a kind this build does not know', async () => {
    // Forward compatibility: a peer on newer code syncs a thread naming a kind
    // added after this build shipped, and the user must still be able to save
    // it. The resolver degrades it at render time instead.
    const seen = mockUpdateWith(baseThread());
    const res = await request(app).post(`/api/brain/threads/${THREAD_ID}/refs`)
      .send({ kind: 'some.future.kind', id: 'x' });
    expect(res.status).toBe(201);
    expect(seen.updates.refs[0].kind).toBe('some.future.kind');
  });

  // ===========================================================================
  // ATTACH
  // ===========================================================================

  it('attaches to an existing thread when threadId is given', async () => {
    const seen = mockUpdateWith(baseThread());
    const res = await request(app).post('/api/brain/threads/attach')
      .send({ threadId: THREAD_ID, ref: { kind: 'app', id: 'app-1', label: 'PortOS' } });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);
    expect(seen.updates.refs).toEqual([{ kind: 'app', id: 'app-1', label: 'PortOS' }]);
    expect(brainStorage.create).not.toHaveBeenCalled();
  });

  it('mints a thread and attaches in one call when no threadId is given', async () => {
    brainStorage.create.mockImplementation(async (type, data) => ({ id: THREAD_ID, ...data }));
    const res = await request(app).post('/api/brain/threads/attach')
      .send({ ref: { kind: 'app', id: 'app-1', label: 'PortOS' }, title: 'Ship the app' });

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.thread).toMatchObject({
      title: 'Ship the app',
      status: 'open',
      refs: [{ kind: 'app', id: 'app-1', label: 'PortOS' }],
    });
  });

  it('titles a minted thread from the ref when no title is given', async () => {
    brainStorage.create.mockImplementation(async (type, data) => ({ id: THREAD_ID, ...data }));
    const res = await request(app).post('/api/brain/threads/attach')
      .send({ ref: { kind: 'app', id: 'app-1', label: 'PortOS' } });
    expect(res.body.thread.title).toBe('PortOS');
  });

  it('routes /attach to the attach handler, not to /:id', async () => {
    // The static route has to mount before `/:id`, or "attach" reads as a
    // thread id and every attach 404s.
    brainStorage.create.mockImplementation(async (type, data) => ({ id: THREAD_ID, ...data }));
    const res = await request(app).post('/api/brain/threads/attach')
      .send({ ref: { kind: 'app', id: 'app-1' } });
    expect(res.status).toBe(201);
  });

  it('404s an attach against a thread that is gone', async () => {
    mockUpdateWith(null);
    const res = await request(app).post('/api/brain/threads/attach')
      .send({ threadId: THREAD_ID, ref: { kind: 'app', id: 'app-1' } });
    expect(res.status).toBe(404);
  });

  // ===========================================================================
  // DELETE
  // ===========================================================================

  it('tombstone-deletes so the deletion federates', async () => {
    brainStorage.remove.mockResolvedValue({ id: THREAD_ID });
    const res = await request(app).delete(`/api/brain/threads/${THREAD_ID}`);
    expect(res.status).toBe(200);
    expect(brainStorage.remove).toHaveBeenCalledWith('threads', THREAD_ID);
  });

  it('404s a delete for a thread that does not exist', async () => {
    brainStorage.remove.mockResolvedValue(null);
    const res = await request(app).delete(`/api/brain/threads/${THREAD_ID}`);
    expect(res.status).toBe(404);
  });
});
