import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
const getById = vi.fn();
const getAppById = vi.fn();
const getTaskById = vi.fn();

vi.mock('../lib/db.js', () => ({ query: (...args) => query(...args) }));
vi.mock('./brainStorage.js', () => ({ getById: (...args) => getById(...args) }));
vi.mock('./apps.js', () => ({ getAppById: (...args) => getAppById(...args) }));
vi.mock('./cosTaskStore.js', () => ({
  getTaskById: (...args) => getTaskById(...args),
  firstLine: (s) => (s || '').split('\n').map((l) => l.trim()).find(Boolean) || '',
}));

const { resolveThreadRefs } = await import('./threadRefs.js');

beforeEach(() => {
  query.mockReset();
  getById.mockReset();
  getAppById.mockReset();
  getTaskById.mockReset();
  query.mockResolvedValue({ rows: [] });
  getById.mockResolvedValue(null);
  getAppById.mockResolvedValue(null);
  getTaskById.mockResolvedValue(null);
});

describe('resolveThreadRefs — hydration', () => {
  it('hydrates a Brain-backed ref from its entity store', async () => {
    getById.mockResolvedValue({ id: 'idea-1', title: 'Ship the bullet journal' });
    const [ref] = await resolveThreadRefs([{ kind: 'brain.idea', id: 'idea-1' }]);
    expect(getById).toHaveBeenCalledWith('ideas', 'idea-1');
    expect(ref).toMatchObject({
      kind: 'brain.idea',
      id: 'idea-1',
      label: 'Ship the bullet journal',
      kindLabel: 'Idea',
      url: '/brain/ideas',
      state: 'live',
      resolved: true,
    });
  });

  it('hydrates a Postgres-backed ref and uses its context for the route', async () => {
    // A catalog ingredient lives at /catalog/:type/:id, and the type is only
    // knowable once the row has been read — the reason `threadRefUrl` takes a
    // context at all.
    query.mockResolvedValue({ rows: [{ title: 'Ada', context: 'character' }] });
    const [ref] = await resolveThreadRefs([{ kind: 'catalog.ingredient', id: 'ing-1' }]);
    expect(ref).toMatchObject({
      label: 'Ada',
      url: '/catalog/character/ing-1',
      state: 'live',
      resolved: true,
    });
  });

  it('hydrates a service-backed ref through its lazy import', async () => {
    getAppById.mockResolvedValue({ id: 'app-1', name: 'PortOS' });
    const [ref] = await resolveThreadRefs([{ kind: 'app', id: 'app-1' }]);
    expect(ref).toMatchObject({ label: 'PortOS', url: '/apps/app-1', resolved: true });
  });

  it('labels a CoS task with the first line of its description', async () => {
    // A task's text lives in `description` (there is no `text` field), and that
    // description is multi-line — a generator folds the body in below line 1.
    getTaskById.mockResolvedValue({ id: 'task-1', description: 'Renew the cert\nlong body here' });
    const [ref] = await resolveThreadRefs([{ kind: 'cos.task', id: 'task-1' }]);
    expect(ref).toMatchObject({ label: 'Renew the cert', url: '/cos/tasks', resolved: true });
  });
  it('keys a journal off its date id, which is the only name it has', async () => {
    getById.mockResolvedValue({ id: '2026-09-19', entries: [] });
    const [ref] = await resolveThreadRefs([{ kind: 'brain.journal', id: '2026-09-19' }]);
    expect(ref).toMatchObject({ label: '2026-09-19', url: '/brain/daily-log?date=2026-09-19' });
  });

  it('prefers the live target title over the ref cached label', async () => {
    // The cached label exists so a LIST render needs no resolver; once we have
    // resolved the target, a stale cached copy must not win.
    getById.mockResolvedValue({ id: 'idea-1', title: 'Renamed' });
    const [ref] = await resolveThreadRefs([{ kind: 'brain.idea', id: 'idea-1', label: 'Old name' }]);
    expect(ref.label).toBe('Renamed');
  });
});

describe('resolveThreadRefs — degradation (never drops a ref)', () => {
  it('reports an unknown kind rather than throwing or omitting it', async () => {
    // A peer running newer code can sync a thread naming a kind this build has
    // never heard of; the thread must still render.
    const [ref] = await resolveThreadRefs([{ kind: 'some.future.kind', id: 'x' }]);
    expect(ref).toMatchObject({ resolved: false, reason: 'unknown-kind', url: null });
    expect(ref.label).toBe('some.future.kind');
  });

  it('reports a deleted target as missing-target, not as absent', async () => {
    getById.mockResolvedValue(null);
    const [ref] = await resolveThreadRefs([{ kind: 'brain.idea', id: 'gone', label: 'Deleted idea' }]);
    expect(ref).toMatchObject({ resolved: false, reason: 'missing-target', url: null });
    // Falls back to the cached label so the chip still says what it pointed at.
    expect(ref.label).toBe('Deleted idea');
  });

  it('reports a ref with no id', async () => {
    const [ref] = await resolveThreadRefs([{ kind: 'brain.idea' }]);
    expect(ref).toMatchObject({ resolved: false, reason: 'missing-ref-id' });
  });

  it('returns one entry per input ref, in input order', async () => {
    getById.mockResolvedValue(null);
    const out = await resolveThreadRefs([
      { kind: 'brain.idea', id: 'a' },
      { kind: 'nope', id: 'b' },
      { kind: 'url', id: 'https://example.com/c' },
    ]);
    expect(out.map((r) => r.id)).toEqual(['a', 'b', 'https://example.com/c']);
  });

  it('never lets a store failure read as a deleted target', async () => {
    // Sentinel discipline (AGENTS.md): "the store was unreachable" must not be
    // recorded as "the target is gone", which would strike a live ref off a
    // thread. The error bubbles instead.
    getById.mockRejectedValue(new Error('store unavailable'));
    await expect(resolveThreadRefs([{ kind: 'brain.idea', id: 'a' }]))
      .rejects.toThrow('store unavailable');
  });
});

describe('resolveThreadRefs — external kinds', () => {
  it('passes a safe external URL through without probing anything', async () => {
    const [ref] = await resolveThreadRefs([
      { kind: 'github.issue', id: 'https://github.com/o/r/issues/7', label: 'o/r#7' },
    ]);
    expect(ref).toMatchObject({
      label: 'o/r#7',
      kindLabel: 'GitHub issue',
      url: 'https://github.com/o/r/issues/7',
      // Nothing local says whether the issue is still open — Phase 4's sync
      // records that on the thread, not on the ref.
      state: 'unknown',
      resolved: true,
    });
    expect(query).not.toHaveBeenCalled();
    expect(getById).not.toHaveBeenCalled();
  });

  it('refuses an external id that must never become an href', async () => {
    const [ref] = await resolveThreadRefs([{ kind: 'url', id: 'javascript:alert(1)' }]);
    expect(ref).toMatchObject({ resolved: false, reason: 'unsafe-url', url: null });
  });
});

describe('resolveThreadRefs — batching', () => {
  it('probes each distinct (kind, id) once', async () => {
    getById.mockResolvedValue({ id: 'idea-1', title: 'One' });
    await resolveThreadRefs([
      { kind: 'brain.idea', id: 'idea-1' },
      { kind: 'brain.idea', id: 'idea-1' },
      { kind: 'brain.idea', id: 'idea-1' },
    ]);
    expect(getById).toHaveBeenCalledTimes(1);
  });

  it('does not conflate two kinds that share an id', async () => {
    getById.mockImplementation(async (type) => ({ title: type === 'ideas' ? 'An idea' : 'A person' }));
    const out = await resolveThreadRefs([
      { kind: 'brain.idea', id: 'shared' },
      { kind: 'brain.person', id: 'shared' },
    ]);
    expect(out.map((r) => r.label)).toEqual(['An idea', 'A person']);
  });

  it('resolves the legacy writersRoom spelling to the canonical kind', async () => {
    query.mockResolvedValue({ rows: [{ title: 'The Work' }] });
    const [ref] = await resolveThreadRefs([{ kind: 'writersRoom', id: 'w1' }]);
    expect(ref.kind).toBe('writers-room');
    expect(ref.url).toBe('/writers-room');
  });

  it('returns [] for an absent or empty ref list', async () => {
    expect(await resolveThreadRefs(undefined)).toEqual([]);
    expect(await resolveThreadRefs([])).toEqual([]);
  });
});
