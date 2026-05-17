import { describe, it, expect, vi, beforeEach } from 'vitest';

const fileStore = new Map();

vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { data: '/mock/data' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn(async (path, data) => { fileStore.set(path, data); }),
  readJSONFile: vi.fn(async (path, fallback) => fileStore.has(path) ? fileStore.get(path) : fallback),
}));

// Stable identity for tests — bypass the disk-backed instances service.
const LOCAL_INSTANCE = 'local-instance-id';
vi.mock('./instances.js', () => ({
  getInstanceId: vi.fn(async () => LOCAL_INSTANCE),
}));
vi.mock('./sharing/annotationIdentity.js', () => ({
  resolveLocalAuthorName: vi.fn(async () => 'Local User'),
}));

const svc = await import('./mediaAnnotations.js');

const STATE_PATH = '/mock/data/media-annotations.json';

describe('mediaAnnotations service (multi-author)', () => {
  beforeEach(() => {
    fileStore.clear();
  });

  it('listAnnotations returns {} for fresh state', async () => {
    expect(await svc.listAnnotations()).toEqual({});
  });

  it('setAnnotation writes local author entry and returns { own, others }', async () => {
    const r = await svc.setAnnotation('image:foo.png', { starred: true });
    expect(r.own).toMatchObject({ starred: true, note: '', authorName: 'Local User' });
    expect(r.others).toEqual([]);
    const all = await svc.listAnnotations();
    expect(all['image:foo.png'].own.starred).toBe(true);
  });

  it('setAnnotation partial-merges within the local author entry', async () => {
    await svc.setAnnotation('image:a.png', { starred: true });
    const r = await svc.setAnnotation('image:a.png', { note: 'looks great' });
    expect(r.own.starred).toBe(true);
    expect(r.own.note).toBe('looks great');
  });

  it('setAnnotation prunes the local author entry when both fields empty', async () => {
    await svc.setAnnotation('image:a.png', { starred: true, note: 'hi' });
    const r = await svc.setAnnotation('image:a.png', { starred: false, note: '' });
    expect(r.own).toBeNull();
    expect(r.others).toEqual([]);
    const all = await svc.listAnnotations();
    expect(all['image:a.png']).toBeUndefined();
  });

  it('setAnnotation preserves peer authors when local entry is pruned', async () => {
    fileStore.set(STATE_PATH, {
      annotations: {
        'image:a.png': {
          authors: {
            'peer-1': { authorName: 'Peer', starred: true, note: 'keep me', updatedAt: '2026-01-01T00:00:00.000Z' },
            [LOCAL_INSTANCE]: { authorName: 'Local User', starred: true, note: '', updatedAt: '2026-01-02T00:00:00.000Z' },
          },
        },
      },
    });
    const r = await svc.setAnnotation('image:a.png', { starred: false });
    expect(r.own).toBeNull();
    expect(r.others).toHaveLength(1);
    expect(r.others[0]).toMatchObject({ instanceId: 'peer-1', note: 'keep me' });
  });

  it('mergePeerAnnotations applies a peer record without touching local', async () => {
    await svc.setAnnotation('image:a.png', { note: 'my note' });
    const result = await svc.mergePeerAnnotations({
      instanceId: 'peer-1',
      authorName: 'Sam',
      annotations: {
        'image:a.png': { starred: true, note: 'peer note', updatedAt: '2099-01-01T00:00:00.000Z' },
      },
    });
    expect(result.changed).toEqual(['image:a.png']);
    const all = await svc.listAnnotations();
    expect(all['image:a.png'].own.note).toBe('my note');
    expect(all['image:a.png'].others[0]).toMatchObject({ authorName: 'Sam', starred: true, note: 'peer note' });
  });

  it('mergePeerAnnotations is per-author LWW (older payload ignored)', async () => {
    fileStore.set(STATE_PATH, {
      annotations: {
        'image:a.png': {
          authors: {
            'peer-1': { authorName: 'Sam', starred: true, note: 'newer', updatedAt: '2026-02-01T00:00:00.000Z' },
          },
        },
      },
    });
    await svc.mergePeerAnnotations({
      instanceId: 'peer-1',
      authorName: 'Sam',
      annotations: {
        'image:a.png': { starred: false, note: 'older', updatedAt: '2026-01-01T00:00:00.000Z' },
      },
    });
    const all = await svc.listAnnotations();
    expect(all['image:a.png'].others[0].note).toBe('newer');
  });

  it('mergePeerAnnotations refuses to write under local instanceId', async () => {
    const result = await svc.mergePeerAnnotations({
      instanceId: LOCAL_INSTANCE,
      authorName: 'Spoofed',
      annotations: {
        'image:a.png': { starred: true, note: 'spoofed', updatedAt: '2099-01-01T00:00:00.000Z' },
      },
    });
    expect(result.changed).toEqual([]);
  });

  it('legacy single-author entries are lifted into the local author bucket on read', async () => {
    fileStore.set(STATE_PATH, {
      annotations: {
        'image:legacy.png': { starred: true, note: 'old note', updatedAt: '2025-01-01T00:00:00.000Z' },
      },
    });
    const all = await svc.listAnnotations();
    expect(all['image:legacy.png'].own).toMatchObject({ starred: true, note: 'old note' });
    expect(all['image:legacy.png'].others).toEqual([]);
  });

  it('listLocalAuthorAnnotations returns only the local-instance entries', async () => {
    fileStore.set(STATE_PATH, {
      annotations: {
        'image:mine.png': {
          authors: {
            [LOCAL_INSTANCE]: { authorName: 'Local User', starred: true, note: '', updatedAt: '2026-01-01T00:00:00.000Z' },
            'peer-1': { authorName: 'Sam', starred: false, note: 'peer', updatedAt: '2026-01-02T00:00:00.000Z' },
          },
        },
        'image:peers-only.png': {
          authors: {
            'peer-1': { authorName: 'Sam', starred: true, note: '', updatedAt: '2026-01-03T00:00:00.000Z' },
          },
        },
      },
    });
    const mine = await svc.listLocalAuthorAnnotations();
    expect(Object.keys(mine)).toEqual(['image:mine.png']);
    expect(mine['image:mine.png'].starred).toBe(true);
  });

  it('setAnnotation rejects invalid key (no colon)', async () => {
    await expect(svc.setAnnotation('foo.png', { starred: true }))
      .rejects.toMatchObject({ code: svc.ERR_VALIDATION });
  });

  it('setAnnotation rejects unknown kind', async () => {
    await expect(svc.setAnnotation('audio:foo.mp3', { starred: true }))
      .rejects.toMatchObject({ code: svc.ERR_VALIDATION });
  });

  it('setAnnotation rejects ref containing `:`', async () => {
    await expect(svc.setAnnotation('image:foo:bar.png', { starred: true }))
      .rejects.toMatchObject({ code: svc.ERR_VALIDATION });
  });

  it('setAnnotation rejects empty patch', async () => {
    await expect(svc.setAnnotation('image:a.png', {}))
      .rejects.toMatchObject({ code: svc.ERR_VALIDATION });
  });

  it('setAnnotation rejects note over max length', async () => {
    const long = 'x'.repeat(svc.NOTE_MAX_LENGTH + 1);
    await expect(svc.setAnnotation('image:a.png', { note: long }))
      .rejects.toMatchObject({ code: svc.ERR_VALIDATION });
  });

  it('setAnnotation rejects non-boolean starred', async () => {
    await expect(svc.setAnnotation('image:a.png', { starred: 'yes' }))
      .rejects.toMatchObject({ code: svc.ERR_VALIDATION });
  });

  it('listAnnotations filters out invalid keys and entries from disk', async () => {
    fileStore.set(STATE_PATH, {
      annotations: {
        'image:good.png': {
          authors: {
            [LOCAL_INSTANCE]: { authorName: 'Local User', starred: true, note: '', updatedAt: '2026-01-01T00:00:00.000Z' },
          },
        },
        'badkey': {
          authors: { [LOCAL_INSTANCE]: { starred: true } },
        },
        'audio:foo.mp3': {
          authors: { [LOCAL_INSTANCE]: { starred: true } },
        },
        'image:empty.png': {
          authors: { [LOCAL_INSTANCE]: { starred: false, note: '' } },
        },
      },
    });
    const all = await svc.listAnnotations();
    expect(Object.keys(all)).toEqual(['image:good.png']);
  });

  it('isValidKey accepts image:<ref> and video:<ref>', () => {
    expect(svc.isValidKey('image:foo.png')).toBe(true);
    expect(svc.isValidKey('video:uuid-1')).toBe(true);
    expect(svc.isValidKey('image:')).toBe(false);
    expect(svc.isValidKey(':foo')).toBe(false);
    expect(svc.isValidKey('imagefoo')).toBe(false);
    expect(svc.isValidKey(null)).toBe(false);
  });
});
