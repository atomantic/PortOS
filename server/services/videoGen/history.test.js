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

import { mutateVideoHistory } from './history.js';

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
