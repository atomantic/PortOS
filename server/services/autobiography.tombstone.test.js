/**
 * End-to-end cover for the deleted-autobiography-story tombstone (#3531): a
 * story the user deletes must stay deleted across a peer sync with a machine
 * that still has it, and the delete must PROPAGATE to that machine.
 *
 * Exercises the real disk paths (autobiography/stories.json) with PATHS pointed
 * at a temp dir, so `deleteStory`, the snapshot, and the merge all run for real.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { rmSync } from 'fs';
import { join } from 'path';
import { createTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// `autobiography.js` and `digital-twin-sync.js` both capture PATHS.digitalTwin
// at module load, so the root is fixed for the whole file and per-test isolation
// comes from wiping the dir in beforeEach.
const tempRoot = createTempDataRoot('portos-autobio-tombstone-');
const twinDir = join(tempRoot, 'digital-twin');

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makePathsProxy(actual, {
    dataRoot: tempRoot,
    extraOverrides: (root) => ({ digitalTwin: join(root, 'digital-twin') }),
  });
});

// The prompt scheduler is the only reason autobiography.js touches these — none
// of the tombstone paths call an AI provider or raise a notification.
vi.mock('./notifications.js', () => ({
  addNotification: vi.fn(),
  NOTIFICATION_TYPES: { AUTOBIOGRAPHY_PROMPT: 'autobiography_prompt' },
  exists: vi.fn(() => false),
}));

const { saveStory, updateStory, deleteStory, getStories } = await import('./autobiography.js');
const { applyDigitalTwinRemote, getDigitalTwinSnapshot, mergeAutobiographyStories } = await import('./digital-twin-sync.js');

const storiesFile = join(twinDir, 'autobiography', 'stories.json');
const newStory = (content = 'An example childhood memory.') => saveStory({ promptId: 'childhood-0', content });

const readStoriesFile = async () => {
  const { readJSONFile } = await import('../lib/fileUtils.js');
  return readJSONFile(storiesFile, null);
};

/** The snapshot a peer that still holds the story would ship. */
const peerSnapshotWith = (stories) => ({ autobiography: { stories: { version: 1, stories, usedPrompts: [], deletedStories: [] } } });

beforeEach(() => {
  rmSync(twinDir, { recursive: true, force: true });
});

afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

describe('autobiography story tombstones (#3531)', () => {
  it('records a tombstone on delete and keeps the story deleted through a peer sync', async () => {
    const story = await newStory();
    const peer = peerSnapshotWith([story]);

    expect(await deleteStory(story.id)).toMatchObject({ id: story.id });
    const afterDelete = await readStoriesFile();
    expect(afterDelete.stories).toEqual([]);
    expect(afterDelete.deletedStories.map((t) => t.id)).toEqual([story.id]);

    // The peer still has the story and ships it back — the pre-#3531 bug.
    await applyDigitalTwinRemote(peer);
    expect(await getStories()).toEqual([]);

    // …and it stays deleted on every subsequent cycle, not just the first.
    await applyDigitalTwinRemote(peer);
    expect(await getStories()).toEqual([]);
  });

  it('ships tombstones in the snapshot so peers can see the delete', async () => {
    const story = await newStory();
    await deleteStory(story.id);

    const { data } = await getDigitalTwinSnapshot();
    expect(data.autobiography.stories.deletedStories.map((t) => t.id)).toEqual([story.id]);
    expect(data.autobiography.stories.stories).toEqual([]);
  });

  it('propagates a peer\'s delete: removes the story this machine still has', async () => {
    const story = await newStory();
    expect(await getStories()).toHaveLength(1);

    const { applied } = await applyDigitalTwinRemote({
      autobiography: {
        stories: {
          stories: [],
          deletedStories: [{ id: story.id, deletedAt: new Date(Date.now() + 60_000).toISOString() }],
        },
      },
    });

    expect(applied).toBe(true);
    expect(await getStories()).toEqual([]);
    expect((await readStoriesFile()).deletedStories.map((t) => t.id)).toEqual([story.id]);
  });

  it('keeps a story edited here after another machine deleted it, and drops the stale tombstone', async () => {
    const story = await newStory();
    const edited = await updateStory(story.id, 'A longer, revised memory.');
    expect(edited.updatedAt).toBeTruthy();

    // The peer's delete predates our edit, so the edit is the user's last word.
    const deletedAt = new Date(Date.parse(edited.updatedAt) - 1_000).toISOString();
    await applyDigitalTwinRemote({
      autobiography: { stories: { stories: [], deletedStories: [{ id: story.id, deletedAt }] } },
    });

    expect((await getStories()).map((s) => s.id)).toEqual([story.id]);
    expect((await readStoriesFile()).deletedStories).toEqual([]);
  });

  it('still accepts a story the peer has that was never deleted here', async () => {
    await applyDigitalTwinRemote(peerSnapshotWith([
      { id: 'peer-story-1', themeId: 'family', content: 'Example', createdAt: '2026-01-01T00:00:00.000Z' },
    ]));
    expect((await getStories()).map((s) => s.id)).toEqual(['peer-story-1']);
  });
});

describe('mergeAutobiographyStories tombstones (#3531)', () => {
  const deletedAt = '2026-02-01T00:00:00.000Z';

  it('unions tombstones in both directions', () => {
    const local = { stories: [], deletedStories: [{ id: 's1', deletedAt }] };
    const remote = { stories: [], deletedStories: [{ id: 's2', deletedAt }] };
    expect(mergeAutobiographyStories(local, remote).merged.deletedStories.map((t) => t.id).sort()).toEqual(['s1', 's2']);
    expect(mergeAutobiographyStories(remote, local).merged.deletedStories.map((t) => t.id).sort()).toEqual(['s1', 's2']);
  });

  it('reaps a story a peer tombstoned after it was created', () => {
    const local = { stories: [{ id: 's1', createdAt: '2026-01-01T00:00:00.000Z' }], deletedStories: [] };
    const { merged, changed } = mergeAutobiographyStories(local, { stories: [], deletedStories: [{ id: 's1', deletedAt }] });
    expect(merged.stories).toEqual([]);
    expect(changed).toBe(true);
  });

  it('does not rewrite the file when the peer only re-sends a story we tombstoned', () => {
    const local = { stories: [], usedPrompts: [], deletedStories: [{ id: 's1', deletedAt }] };
    const remote = { stories: [{ id: 's1', createdAt: '2026-01-01T00:00:00.000Z' }], usedPrompts: [], deletedStories: [] };
    expect(mergeAutobiographyStories(local, remote).changed).toBe(false);
  });

  it('rewrites a merely-unsorted local usedPrompts so two peers converge on one checksum', () => {
    // saveStory appends in write order, so the on-disk list is often unsorted —
    // a length-only comparison would call this a no-op and never converge.
    const local = { stories: [], usedPrompts: ['family-0', 'childhood-0'], deletedStories: [] };
    const { merged, changed } = mergeAutobiographyStories(local, { stories: [], usedPrompts: ['childhood-0'], deletedStories: [] });
    expect(changed).toBe(true);
    expect(merged.usedPrompts).toEqual(['childhood-0', 'family-0']);
  });

  it('drops a peer story with no usable id rather than keying the union on undefined', () => {
    const local = { stories: [], usedPrompts: [], deletedStories: [] };
    const remote = { stories: [{ content: 'no id' }, { id: '', content: 'empty id' }], usedPrompts: [], deletedStories: [] };
    expect(mergeAutobiographyStories(local, remote)).toEqual({ merged: { ...local, stories: [], usedPrompts: [], deletedStories: [] }, changed: false });
  });

  it('tolerates a legacy peer that sends no tombstone key at all', () => {
    const local = { stories: [{ id: 's1', createdAt: '2026-01-01T00:00:00.000Z' }], usedPrompts: [] };
    const { merged, changed } = mergeAutobiographyStories(local, { stories: [{ id: 's1', createdAt: '2026-01-01T00:00:00.000Z' }], usedPrompts: [] });
    expect(changed).toBe(false);
    expect(merged.stories.map((s) => s.id)).toEqual(['s1']);
    expect(merged.deletedStories).toEqual([]);
  });
});
