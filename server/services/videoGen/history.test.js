import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory store standing in for data/video-history.json so the serialization
// test never touches disk. readJSONFile returns a COPY (a real read wouldn't
// hand back the live array) after a microtask delay to widen the race window;
// atomicWrite replaces the store.
const store = { data: [] };
vi.mock('../../lib/fileUtils.js', () => ({
  PATHS: { data: '/tmp/videohistory-test' },
  readJSONFile: vi.fn(async () => {
    await new Promise((r) => setTimeout(r, 5));
    return store.data.slice();
  }),
  atomicWrite: vi.fn(async (_file, value) => { store.data = value; }),
}));

import { mutateVideoHistory, getHistoryItem } from './history.js';

describe('mutateVideoHistory serialization', () => {
  beforeEach(() => { store.data = []; });

  it('does not lose an entry when two mutations run concurrently', async () => {
    // Without the write tail, both reads see the empty array and the later save
    // clobbers the earlier entry — the store would end with one item, not two.
    await Promise.all([
      mutateVideoHistory((h) => { h.unshift({ id: 'a' }); return h; }),
      mutateVideoHistory((h) => { h.unshift({ id: 'b' }); return h; }),
    ]);
    expect(store.data.map((x) => x.id).sort()).toEqual(['a', 'b']);
  });

  it('applies mutations in call order (later mutation sees earlier writes)', async () => {
    await mutateVideoHistory((h) => { h.unshift({ id: '1' }); return h; });
    const result = await mutateVideoHistory((h) => { h.unshift({ id: '2' }); return h; });
    expect(result.map((x) => x.id)).toEqual(['2', '1']);
  });

  it('a rejecting mutation does not wedge subsequent writes', async () => {
    await expect(mutateVideoHistory(() => { throw new Error('boom'); })).rejects.toThrow('boom');
    await mutateVideoHistory((h) => { h.unshift({ id: 'after' }); return h; });
    expect(store.data.map((x) => x.id)).toEqual(['after']);
  });
});

describe('getHistoryItem', () => {
  beforeEach(() => { store.data = []; });

  it('resolves an id whose filename is unrelated to it (the timeline case)', async () => {
    store.data = [
      { id: 'final-1', filename: 'timeline-abcd1234-1700000000000.mp4' },
      { id: 'scene-1', filename: 'scene-1.mp4' },
    ];
    expect(await getHistoryItem('final-1')).toEqual({
      id: 'final-1',
      filename: 'timeline-abcd1234-1700000000000.mp4',
    });
  });

  it('returns null — not a throw — for an id absent from history', async () => {
    store.data = [{ id: 'scene-1', filename: 'scene-1.mp4' }];
    expect(await getHistoryItem('gone-1')).toBeNull();
  });

  it('returns null on an empty history rather than undefined', async () => {
    expect(await getHistoryItem('anything')).toBeNull();
  });

  it('matches ids exactly — a filename stem is not an id', async () => {
    store.data = [{ id: 'final-1', filename: 'timeline-final-1.mp4' }];
    expect(await getHistoryItem('timeline-final-1')).toBeNull();
  });

  it('survives a malformed entry sitting in the list', async () => {
    // A hand-edited or half-written history file must not make the lookup
    // throw on the null row before it reaches the entry the caller asked for.
    store.data = [null, { filename: 'no-id.mp4' }, { id: 'scene-1', filename: 'scene-1.mp4' }];
    const entry = await getHistoryItem('scene-1');
    expect(entry?.filename).toBe('scene-1.mp4');
  });
});
