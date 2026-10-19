import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-feedback-' });

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makeProxy(actual);
});

vi.mock('./digital-twin.js', () => ({ digitalTwinEvents: { emit: vi.fn() } }));

const FILE = join(tempRoot, 'digital-twin', 'feedback.json');
const entry = (id, createdAt, validation = 'sounds_like_me') => ({ id, validation, createdAt, contentType: 'enrichment', documentsUsed: [] });
const doc = (entries, updatedAt) => ({
  version: '1.0.0', entries, updatedAt,
  stats: { totalFeedback: entries.length, soundsLikeMe: entries.length, doesntSoundLikeMe: 0 },
  documentWeightAdjustments: {}, lastCalculatedAt: null,
});
const readDisk = async () => JSON.parse(await readFile(FILE, 'utf-8'));

let feedback;
let sync;
beforeEach(async () => {
  vi.resetModules();
  await rm(join(tempRoot, 'digital-twin'), { recursive: true, force: true });
  await mkdir(join(tempRoot, 'digital-twin'), { recursive: true });
  feedback = await import('./feedbackLoop.js');
  sync = await import('./digital-twin-sync.js');
});
afterAll(cleanup);

const merge = (remote) => feedback.applyFeedbackMerge((local) => sync.mergeFeedback(local, remote));

describe('feedback peer merge vs local submit', () => {
  it('keeps synced entries when a local submit follows a peer merge (stale cache)', async () => {
    await feedback.submitFeedback({ contentType: 'enrichment', validation: 'sounds_like_me', contentSnippet: 'a' }); // primes cache
    expect(await merge(doc([entry('remote-1', '2026-01-01T00:00:00.000Z')], '2026-01-01T00:00:00.000Z'))).toBe(true);

    await feedback.submitFeedback({ contentType: 'enrichment', validation: 'not_quite', contentSnippet: 'b' });

    const ids = (await readDisk()).entries.map((e) => e.id);
    expect(ids).toContain('remote-1');
    expect(ids).toHaveLength(3);
    expect((await feedback.getRecentFeedback()).length).toBe(3);
  });

  it('converges to the union when both machines recorded feedback between syncs', async () => {
    const a = doc([entry('shared', '2026-01-01T00:00:00.000Z'), entry('a-only', '2026-01-02T00:00:00.000Z')], '2026-01-03T00:00:00.000Z');
    const b = doc([entry('shared', '2026-01-01T00:00:00.000Z'), entry('b-only', '2026-01-02T12:00:00.000Z')], '2026-01-02T12:00:00.000Z');
    await writeFile(FILE, JSON.stringify(a));

    await merge(b);
    const onA = (await readDisk()).entries.map((e) => e.id).sort();
    const onB = sync.mergeFeedback(b, a).merged.entries.map((e) => e.id).sort();
    expect(onA).toEqual(['a-only', 'b-only', 'shared']);
    expect(onB).toEqual(onA);
  });

  it('does not rewrite when the remote adds nothing', async () => {
    const a = doc([entry('x', '2026-01-01T00:00:00.000Z')], '2026-01-03T00:00:00.000Z');
    await writeFile(FILE, JSON.stringify(a));
    expect(await merge(doc([entry('x', '2026-01-01T00:00:00.000Z')], '2026-01-04T00:00:00.000Z'))).toBe(false);
  });

  it('refuses to overwrite a malformed feedback.json on merge or submit', async () => {
    await writeFile(FILE, '{ not json');
    await expect(merge(doc([entry('r', '2026-01-01T00:00:00.000Z')], 'x'))).rejects.toThrow();
    await expect(feedback.submitFeedback({ contentType: 'enrichment', validation: 'sounds_like_me', contentSnippet: 'c' })).rejects.toThrow();
    expect(await readFile(FILE, 'utf-8')).toBe('{ not json');
  });

  it('initializes a missing file on first submit', async () => {
    await feedback.submitFeedback({ contentType: 'enrichment', validation: 'sounds_like_me', contentSnippet: 'c' });
    expect((await readDisk()).stats.totalFeedback).toBe(1);
  });
});
