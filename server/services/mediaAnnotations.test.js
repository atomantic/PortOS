import { describe, it, expect, vi, beforeEach } from 'vitest';

const fileStore = new Map();

vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { data: '/mock/data' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn(async (path, data) => { fileStore.set(path, data); }),
  readJSONFile: vi.fn(async (path, fallback) => fileStore.has(path) ? fileStore.get(path) : fallback),
}));

const svc = await import('./mediaAnnotations.js');

describe('mediaAnnotations service', () => {
  beforeEach(() => {
    fileStore.clear();
  });

  it('listAnnotations returns {} for fresh state', async () => {
    expect(await svc.listAnnotations()).toEqual({});
  });

  it('setAnnotation persists a starred entry', async () => {
    const r = await svc.setAnnotation('image:foo.png', { starred: true });
    expect(r.starred).toBe(true);
    expect(r.note).toBe('');
    expect(typeof r.updatedAt).toBe('string');
    const all = await svc.listAnnotations();
    expect(all['image:foo.png'].starred).toBe(true);
  });

  it('setAnnotation persists a note-only entry', async () => {
    const r = await svc.setAnnotation('video:abc-1', { note: 'reshoot at 24fps' });
    expect(r.starred).toBe(false);
    expect(r.note).toBe('reshoot at 24fps');
  });

  it('setAnnotation partial-merges (note keeps prior starred)', async () => {
    await svc.setAnnotation('image:a.png', { starred: true });
    const r = await svc.setAnnotation('image:a.png', { note: 'looks great' });
    expect(r.starred).toBe(true);
    expect(r.note).toBe('looks great');
  });

  it('setAnnotation prunes when both fields become empty', async () => {
    await svc.setAnnotation('image:a.png', { starred: true, note: 'hi' });
    const r = await svc.setAnnotation('image:a.png', { starred: false, note: '' });
    expect(r).toBeNull();
    const all = await svc.listAnnotations();
    expect(all['image:a.png']).toBeUndefined();
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
    fileStore.set('/mock/data/media-annotations.json', {
      annotations: {
        'image:good.png': { starred: true, note: '', updatedAt: '2026-01-01T00:00:00.000Z' },
        'badkey': { starred: true },
        'audio:foo.mp3': { starred: true },
        'image:empty.png': { starred: false, note: '' },
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
