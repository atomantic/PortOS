import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const io = vi.hoisted(() => ({ root: '', reads: 0, statError: null }));
vi.mock('node:fs/promises', async original => {
  const real = await original();
  return { ...real, stat: async (...args) => {
    if (io.statError) throw io.statError;
    return real.stat(...args);
  } };
});
vi.mock('../../lib/fileUtils.js', async () => {
  const { readJSONFile } = await import('../../lib/jsonIo.js');
  const { atomicWrite } = await import('../../lib/fileCore.js');
  return {
    PATHS: { data: io.root }, atomicWrite,
    readJSONFile: (...args) => {
      io.reads++;
      return readJSONFile(...args);
    },
  };
});

let history;
let file;
beforeAll(async () => {
  io.root = await mkdtemp(join(tmpdir(), 'video-history-'));
  file = join(io.root, 'video-history.json');
  history = await import('./history.js');
});
beforeEach(async () => {
  io.reads = 0;
  io.statError = null;
  await rm(file, { force: true });
});
afterAll(async () => { await rm(io.root, { recursive: true, force: true }); });

// Keep these tests local to their fixture, without instance identity or peer announcements.
const mutateVideoHistory = mutator => history.mutateVideoHistory(mutator, { stampOrigin: false });

describe('mutateVideoHistory serialization', () => {
  it('does not lose an entry when two mutations run concurrently', async () => {
    // Without the write tail, both reads see the empty array and the later save
    // clobbers the earlier entry — the store would end with one item, not two.
    await Promise.all([
      mutateVideoHistory((h) => { h.unshift({ id: 'a' }); return h; }),
      mutateVideoHistory((h) => { h.unshift({ id: 'b' }); return h; }),
    ]);
    expect((await history.loadHistory()).map((x) => x.id).sort()).toEqual(['a', 'b']);
  });

  it('applies mutations in call order (later mutation sees earlier writes)', async () => {
    await mutateVideoHistory((h) => { h.unshift({ id: '1' }); return h; });
    const result = await mutateVideoHistory((h) => { h.unshift({ id: '2' }); return h; });
    expect(result.map((x) => x.id)).toEqual(['2', '1']);
  });

  it('a rejecting mutation does not wedge subsequent writes', async () => {
    await expect(mutateVideoHistory(() => { throw new Error('boom'); })).rejects.toThrow('boom');
    await mutateVideoHistory((h) => { h.unshift({ id: 'after' }); return h; });
    expect((await history.loadHistory()).map((x) => x.id)).toEqual(['after']);
  });
});

describe('getHistoryItem', () => {
  const getHistoryItem = id => history.getHistoryItem(id);

  it('resolves an id whose filename is unrelated to it (the timeline case)', async () => {
    await history.saveHistory([
      { id: 'final-1', filename: 'timeline-abcd1234-1700000000000.mp4' },
      { id: 'scene-1', filename: 'scene-1.mp4' },
    ]);
    expect(await getHistoryItem('final-1')).toEqual({
      id: 'final-1',
      filename: 'timeline-abcd1234-1700000000000.mp4',
    });
  });

  it('returns null — not a throw — for an id absent from history', async () => {
    await history.saveHistory([{ id: 'scene-1', filename: 'scene-1.mp4' }]);
    expect(await getHistoryItem('gone-1')).toBeNull();
  });

  it('returns null on an empty history rather than undefined', async () => {
    expect(await getHistoryItem('anything')).toBeNull();
  });

  it('matches ids exactly — a filename stem is not an id', async () => {
    await history.saveHistory([{ id: 'final-1', filename: 'timeline-final-1.mp4' }]);
    expect(await getHistoryItem('timeline-final-1')).toBeNull();
  });

  it('survives a malformed entry sitting in the list', async () => {
    // A hand-edited or half-written history file must not make the lookup
    // throw on the null row before it reaches the entry the caller asked for.
    await history.saveHistory([null, { filename: 'no-id.mp4' }, { id: 'scene-1', filename: 'scene-1.mp4' }]);
    const entry = await getHistoryItem('scene-1');
    expect(entry?.filename).toBe('scene-1.mp4');
  });

  it('shares one read between concurrent lookups, list readers and card readers', async () => {
    const row = { id: 'clip', prompt: 'first', settings: { inputs: ['original'] } };
    await history.saveHistory([row, { ...row, prompt: 'duplicate' }]);
    const [full, compact, ...hits] = await Promise.all([
      history.readHistorySnapshot(), history.loadCompactHistory(),
      ...Array.from({ length: 40 }, () => getHistoryItem(row.id)),
    ]);
    expect(hits.every(hit => hit === full[0])).toBe(true);
    expect(await getHistoryItem(row.id)).toEqual(row);
    expect(compact[0]._promptPreviewSource).toBe('first');
    expect(Object.isFrozen(full)).toBe(true);
    expect(Object.isFrozen(full[0].settings)).toBe(true);
    expect(() => hits[0].settings.inputs.push('changed')).toThrow();
    expect(io.reads).toBe(1);
  });

  it('refreshes across saves, mutations and an external file replacement', async () => {
    await history.saveHistory([{ id: 'clip', prompt: 'initial' }]);
    expect((await getHistoryItem('clip')).prompt).toBe('initial');
    await history.saveHistory([{ id: 'clip', prompt: 'saved' }]);
    expect((await getHistoryItem('clip')).prompt).toBe('saved');
    await mutateVideoHistory(rows => {
      rows[0].prompt = 'mutated';
      return rows;
    });
    expect((await getHistoryItem('clip')).prompt).toBe('mutated');
    const replacement = file + '.restore';
    await writeFile(replacement, JSON.stringify([{ id: 'clip', prompt: 'externally replaced' }]));
    await rename(replacement, file);
    expect((await getHistoryItem('clip')).prompt).toBe('externally replaced');
  });

  it('does not expose an in-place edit made by a failed mutator', async () => {
    const row = { id: 'clip', settings: { inputs: ['original'] } };
    await history.saveHistory([row]);
    const cached = await getHistoryItem(row.id);
    await expect(mutateVideoHistory(rows => {
      rows[0].settings.inputs.push('changed');
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(await getHistoryItem(row.id)).toBe(cached);
    expect(cached).toEqual(row);
    expect(await history.loadHistory()).toEqual([row]);
  });

  it('rejects unreadable or corrupt history even after a successful lookup', async () => {
    await history.saveHistory([{ id: 'clip' }]);
    expect(await getHistoryItem('clip')).toEqual({ id: 'clip' });
    io.statError = Object.assign(new Error('unreadable'), { code: 'EACCES' });
    await expect(getHistoryItem('clip')).rejects.toThrow('unreadable');
    io.statError = null;
    await writeFile(file, '{invalid');
    await expect(getHistoryItem('clip')).rejects.toThrow();
  });
});
