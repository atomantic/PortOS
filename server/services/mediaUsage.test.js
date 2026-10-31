import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({ query: vi.fn(), stamp: 'a' }));
vi.mock('../lib/db.js', () => ({ query: db.query }));
vi.mock('../lib/pgFileFacade.js', () => ({ isFileBackend: () => false }));
vi.mock('./videoGen/history.js', () => ({
  loadHistory: async () => [{ id: 'vid-1', filename: 'clip-1.mp4' }, { id: 'vid-2', filename: 'clip-2.mp4' }],
}));
vi.mock('./videoTimeline/local.js', () => ({
  listProjects: async () => [{ id: 'tl-1', name: 'Cut A', segments: [{ videoId: 'vid-2' }] }],
}));

const { getMediaUsageIndex, assertMediaDeletable } = await import('./mediaUsage.js');

const tables = {
  music_video_projects: [{
    id: 'mv-1', title: 'Example Song', data: {
      name: 'Example Song',
      renderHistoryId: 'vid-1',
      scenes: [
        { sceneId: 's-a', referenceImageId: 'still-a.png', takes: [{ kind: 'image', assetId: 'pool-only.png' }] },
        { sceneId: 's-b', videoHistoryId: 'vid-1' },
      ],
      assetMarks: { 'image:marked.png': 'bad' },
    },
  }],
  storyboards: [{
    id: 'sb-1', title: 'Board', data: { beats: [{ panels: [{ id: 'p-1' }] }, { panels: [{ id: 'p-2', image: '/data/images/still-a.png?v=2' }] }] },
  }],
  mood_boards: [{
    id: 'mb-1', title: 'Mood', data: { items: [{ mediaKey: 'video:clip-2.mp4' }, { imageUrl: '/data/image-thumbnails/still-a.webp' }, { imageUrl: 'https://example.com/pin.jpg' }] },
  }],
};

function fakeQuery(sql) {
  if (sql.includes('UNION ALL')) return { rows: [{ i: 0, f: db.stamp }] };
  if (sql.includes('FROM catalog_ingredient_media m')) {
    return { rows: [
      { media_key: 'still-a.png', kind: 'reference', role: 'sheet:turnaround', id: 'cat-chr-1', name: 'Alice', type: 'character' },
      { media_key: 'set.png', kind: 'reference', role: 'plate', id: 'cat-plc-1', name: 'Example Set', type: 'place' },
    ] };
  }
  const name = /FROM (\w+) WHERE/.exec(sql)?.[1];
  return { rows: tables[name] || [] };
}

let run = 0;
beforeEach(() => {
  // A fresh fingerprint per test, so no test reads another's cached index.
  db.stamp = `t-${++run}`;
  db.query.mockReset();
  db.query.mockImplementation(async (sql) => fakeQuery(sql));
});

describe('media usage index', () => {
  it('finds what records use now, with a link to the shot, panel or record tab', async () => {
    const index = await getMediaUsageIndex();
    expect(index['image:still-a.png']).toEqual([
      { source: 'music-video', label: 'Music video', id: 'mv-1', title: 'Example Song', role: 'Shot 1', href: '/music-video/mv-1/scene/s-a' },
      { source: 'storyboard', label: 'Storyboard', id: 'sb-1', title: 'Board', role: 'Panel 2', href: '/storyboards/sb-1/panel/p-2' },
      { source: 'catalog', label: 'Casting', id: 'cat-chr-1', title: 'Alice', role: 'Sheet', href: '/casting/cat-chr-1/sheets' },
    ]);
    expect(index['video:vid-1'].map((u) => u.role)).toEqual(['Final render', 'Shot 2']);
    expect(index['video:vid-2'].map((u) => [u.source, u.href])).toEqual([['mood-board', '/mood-boards/mb-1'], ['video-timeline', '/media/timeline/tl-1']]);
    expect(index['image:set.png'][0].href).toBe('/environments/cat-plc-1/plates');
    // Unused takes, marks, thumbnails and outside URLs are not uses.
    expect(index['image:pool-only.png']).toBeUndefined();
    expect(index['image:marked.png']).toBeUndefined();
    expect(index['image:still-a.webp']).toBeUndefined();
    expect(index['image:pin.jpg']).toBeUndefined();
  });

  it('rebuilds only when a source changes', async () => {
    await getMediaUsageIndex();
    const scans = db.query.mock.calls.length;
    await getMediaUsageIndex();
    expect(db.query.mock.calls.length).toBe(scans + 1);
    db.stamp = `${db.stamp}-changed`;
    await getMediaUsageIndex();
    expect(db.query.mock.calls.length).toBeGreaterThan(scans + 2);
  });
});

describe('assertMediaDeletable', () => {
  it('refuses a used file with its usages unless forced', async () => {
    const err = await assertMediaDeletable('image:still-a.png').catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.code).toBe('MEDIA_IN_USE');
    expect(err.context.usages).toHaveLength(3);
    expect(err.message).toContain('Music video "Example Song" Shot 1');
    await expect(assertMediaDeletable('image:still-a.png', { force: true })).resolves.toBeUndefined();
    await expect(assertMediaDeletable('image:unused.png')).resolves.toBeUndefined();
  });
});
