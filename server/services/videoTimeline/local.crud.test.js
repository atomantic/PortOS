import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { mockPathsDataRoot } from '../../lib/mockPathsDataRoot.js';

// CRUD round-trip for the layered timeline: a v1 project loads as lanes, both
// PATCH shapes converge on `segments`, and the derived `clips` mirror is
// rebuilt on every write.
const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'timeline-crud-' });

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return makeProxy(actual);
});

const { createProject, getProject, listProjects, updateProject, deleteProject } = await import('./local.js');

const PROJECTS_FILE = join(tempRoot, 'video-projects.json');
const CLIP_A = '11111111-1111-4111-8111-111111111111';
const CLIP_B = '22222222-2222-4222-8222-222222222222';

const seed = (projects) => {
  mkdirSync(tempRoot, { recursive: true });
  writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
};
const onDisk = () => JSON.parse(readFileSync(PROJECTS_FILE, 'utf8'));

beforeEach(() => seed([]));
afterAll(() => cleanup());

describe('createProject', () => {
  it('starts a new project at the current schema version with three empty lanes', async () => {
    const project = await createProject('Example Project');
    expect(project).toMatchObject({
      name: 'Example Project',
      schemaVersion: 2,
      segments: [],
      overlays: [],
      audio: { clipVolume: 1, tracks: [] },
      clips: [],
    });
  });
});

describe('loading a v1 project', () => {
  it('presents a legacy clips-only project as lanes without needing the migration to have run', async () => {
    seed([{ id: 'p1', name: 'Legacy', updatedAt: 'u1', clips: [{ clipId: CLIP_A, inSec: 0, outSec: 4 }] }]);

    const project = await getProject('p1');

    expect(project.schemaVersion).toBe(2);
    expect(project.segments).toEqual([
      { type: 'clip', clipId: CLIP_A, inSec: 0, outSec: 4, fadeInSec: 0, fadeOutSec: 0, volume: 1 },
    ]);
    expect(project.overlays).toEqual([]);
    // Read-only: the file itself is untouched until something writes.
    expect(onDisk()[0].segments).toBeUndefined();
  });

  it('lists a corrupt file as empty rather than crashing', async () => {
    writeFileSync(PROJECTS_FILE, JSON.stringify({ projects: [] }));
    expect(await listProjects()).toEqual([]);
  });
});

describe('updateProject — lane writes', () => {
  it('accepts the v1 clips payload and upgrades it into the video lane', async () => {
    seed([{ id: 'p1', name: 'Legacy', updatedAt: 'u1', clips: [] }]);

    const updated = await updateProject('p1', { clips: [{ clipId: CLIP_A, inSec: 0, outSec: 2 }] });

    expect(updated.segments).toEqual([
      { type: 'clip', clipId: CLIP_A, inSec: 0, outSec: 2, fadeInSec: 0, fadeOutSec: 0, volume: 1 },
    ]);
    expect(onDisk()[0].schemaVersion).toBe(2);
  });

  it('lets segments win when a client sends both shapes', async () => {
    seed([{ id: 'p1', updatedAt: 'u1', clips: [] }]);

    const updated = await updateProject('p1', {
      clips: [{ clipId: CLIP_A, inSec: 0, outSec: 2 }],
      segments: [{ type: 'clip', clipId: CLIP_B, inSec: 0, outSec: 3 }],
    });

    expect(updated.segments).toHaveLength(1);
    expect(updated.segments[0].clipId).toBe(CLIP_B);
  });

  it('rebuilds the clips mirror from the written lane on every save', async () => {
    seed([{ id: 'p1', updatedAt: 'u1', clips: [{ clipId: CLIP_A, inSec: 0, outSec: 9 }] }]);

    const updated = await updateProject('p1', {
      segments: [
        { type: 'clip', clipId: CLIP_B, inSec: 1, outSec: 3 },
        { type: 'still', assetKind: 'images', assetFile: 'plate.png', durationSec: 2 },
      ],
    });

    // The stale mirror entry is gone; the still contributes nothing to it.
    expect(updated.clips).toEqual([{ clipId: CLIP_B, inSec: 1, outSec: 3 }]);
    expect(onDisk()[0].clips).toEqual([{ clipId: CLIP_B, inSec: 1, outSec: 3 }]);
  });

  it('persists overlays and the audio mix', async () => {
    seed([{ id: 'p1', updatedAt: 'u1', clips: [] }]);

    const updated = await updateProject('p1', {
      segments: [{ type: 'clip', clipId: CLIP_A, inSec: 0, outSec: 5 }],
      overlays: [{ assetKind: 'images', assetFile: 'logo.png', startSec: 1, durationSec: 2, opacity: 0.5 }],
      audio: { clipVolume: 0.3, tracks: [{ assetKind: 'music', assetFile: 'bed.mp3', startSec: 0, durationSec: 4, volume: 0.7 }] },
    });

    expect(updated.overlays[0]).toMatchObject({ type: 'image', assetFile: 'logo.png', opacity: 0.5 });
    expect(updated.audio).toMatchObject({ clipVolume: 0.3 });
    expect(updated.audio.tracks[0]).toMatchObject({ assetFile: 'bed.mp3', volume: 0.7 });
  });

  it('clears a lane when the client sends it empty', async () => {
    seed([{
      id: 'p1', updatedAt: 'u1', schemaVersion: 2, clips: [],
      segments: [], overlays: [{ assetKind: 'images', assetFile: 'logo.png', startSec: 0, durationSec: 1 }],
      audio: { clipVolume: 1, tracks: [] },
    }]);

    expect((await updateProject('p1', { overlays: [] })).overlays).toEqual([]);
  });

  it('leaves an unmentioned lane alone', async () => {
    seed([{
      id: 'p1', updatedAt: 'u1', schemaVersion: 2, clips: [],
      segments: [], overlays: [{ assetKind: 'images', assetFile: 'logo.png', startSec: 0, durationSec: 1 }],
      audio: { clipVolume: 0.4, tracks: [] },
    }]);

    const updated = await updateProject('p1', { name: 'Renamed' });

    expect(updated.name).toBe('Renamed');
    expect(updated.overlays).toHaveLength(1);
    expect(updated.audio.clipVolume).toBe(0.4);
  });

  it('rejects an invalid lane without writing anything', async () => {
    seed([{ id: 'p1', updatedAt: 'u1', schemaVersion: 2, segments: [], overlays: [], audio: { clipVolume: 1, tracks: [] }, clips: [] }]);

    await expect(updateProject('p1', {
      overlays: [{ assetKind: 'images', assetFile: '../../etc/passwd', startSec: 0, durationSec: 1 }],
    })).rejects.toThrow(/plain filename/);

    expect(onDisk()[0].updatedAt).toBe('u1');
  });

  it('still refuses a stale expectedUpdatedAt across the new lanes', async () => {
    seed([{ id: 'p1', updatedAt: 'u2', schemaVersion: 2, segments: [], overlays: [], audio: { clipVolume: 1, tracks: [] }, clips: [] }]);

    await expect(updateProject('p1', { overlays: [] }, 'u1')).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('deleteProject', () => {
  it('removes the project and 404s on a second attempt', async () => {
    seed([{ id: 'p1', updatedAt: 'u1', clips: [] }]);
    expect(await deleteProject('p1')).toEqual({ ok: true });
    await expect(deleteProject('p1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('updateProject — the v1 clips payload cannot silently destroy the new lanes', () => {
  it('refuses a clips-only save against a project holding stills', async () => {
    seed([{
      id: 'p1', updatedAt: 'u1', schemaVersion: 2, clips: [{ clipId: CLIP_A, inSec: 0, outSec: 2 }],
      segments: [
        { type: 'clip', clipId: CLIP_A, inSec: 0, outSec: 2 },
        { type: 'still', assetKind: 'images', assetFile: 'plate.png', durationSec: 3 },
      ],
      overlays: [], audio: { clipVolume: 1, tracks: [] },
    }]);

    // A rolled-back v1 editor reads only the `clips` mirror, so writing it back
    // would drop the still it never saw.
    await expect(updateProject('p1', { clips: [{ clipId: CLIP_A, inSec: 0, outSec: 2 }] }))
      .rejects.toMatchObject({ code: 'SCHEMA_TOO_NEW' });

    expect(onDisk()[0].segments).toHaveLength(2);
    expect(onDisk()[0].updatedAt).toBe('u1');
  });

  it('still accepts a clips-only save when the lane is all clips — nothing can be lost', async () => {
    seed([{
      id: 'p1', updatedAt: 'u1', schemaVersion: 2, clips: [{ clipId: CLIP_A, inSec: 0, outSec: 2 }],
      segments: [{ type: 'clip', clipId: CLIP_A, inSec: 0, outSec: 2 }],
      overlays: [], audio: { clipVolume: 1, tracks: [] },
    }]);

    const updated = await updateProject('p1', { clips: [{ clipId: CLIP_B, inSec: 0, outSec: 5 }] });
    expect(updated.segments[0].clipId).toBe(CLIP_B);
  });

  it('lets a v2 client edit the same project through the segments lane', async () => {
    seed([{
      id: 'p1', updatedAt: 'u1', schemaVersion: 2, clips: [],
      segments: [{ type: 'still', assetKind: 'images', assetFile: 'plate.png', durationSec: 3 }],
      overlays: [], audio: { clipVolume: 1, tracks: [] },
    }]);

    const updated = await updateProject('p1', {
      segments: [{ type: 'still', assetKind: 'images', assetFile: 'plate.png', durationSec: 4 }],
    });
    expect(updated.segments[0].durationSec).toBe(4);
  });
});

describe('updateProject — a legacy save cannot silently reset clip effects', () => {
  it('refuses a clips-only save against a lane carrying fades', async () => {
    seed([{
      id: 'p1', updatedAt: 'u1', schemaVersion: 2, clips: [{ clipId: CLIP_A, inSec: 0, outSec: 4 }],
      segments: [{ type: 'clip', clipId: CLIP_A, inSec: 0, outSec: 4, fadeInSec: 1, fadeOutSec: 0, volume: 1 }],
      overlays: [], audio: { clipVolume: 1, tracks: [] },
    }]);

    // The v1 payload has no fade field, so rebuilding from it would reset the
    // fade to zero without telling anyone.
    await expect(updateProject('p1', { clips: [{ clipId: CLIP_A, inSec: 0, outSec: 4 }] }))
      .rejects.toMatchObject({ code: 'SCHEMA_TOO_NEW' });
  });

  it('refuses a clips-only save against a lane carrying a non-default volume', async () => {
    seed([{
      id: 'p1', updatedAt: 'u1', schemaVersion: 2, clips: [{ clipId: CLIP_A, inSec: 0, outSec: 4 }],
      segments: [{ type: 'clip', clipId: CLIP_A, inSec: 0, outSec: 4, fadeInSec: 0, fadeOutSec: 0, volume: 0.4 }],
      overlays: [], audio: { clipVolume: 1, tracks: [] },
    }]);

    await expect(updateProject('p1', { clips: [{ clipId: CLIP_A, inSec: 0, outSec: 4 }] }))
      .rejects.toMatchObject({ code: 'SCHEMA_TOO_NEW' });
  });

  it('accepts it when every clip is at its neutral defaults — nothing can be lost', async () => {
    seed([{
      id: 'p1', updatedAt: 'u1', schemaVersion: 2, clips: [{ clipId: CLIP_A, inSec: 0, outSec: 4 }],
      segments: [{ type: 'clip', clipId: CLIP_A, inSec: 0, outSec: 4, fadeInSec: 0, fadeOutSec: 0, volume: 1 }],
      overlays: [], audio: { clipVolume: 1, tracks: [] },
    }]);

    const updated = await updateProject('p1', { clips: [{ clipId: CLIP_B, inSec: 1, outSec: 6 }] });
    expect(updated.segments[0]).toMatchObject({ clipId: CLIP_B, inSec: 1, outSec: 6 });
  });
});
