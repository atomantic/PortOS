/**
 * Music Video scene completion hooks (#8965) against the real file-backed
 * project store: a completed image/video job becomes an immutable scene take,
 * fills the slot only while it is unselected, never replaces a selection, and a
 * late completion can't resurrect a deleted scene or project. The tag-decode /
 * serialize scaffolding itself is covered by mediaJobImageHook.test.js.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'mv-scene-hooks-test-'));

vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { ...actual.PATHS, data: TEST_DATA_ROOT } };
});
vi.mock('./settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));

const { mediaJobEvents } = await import('./mediaJobQueue/index.js');
const { musicVideoEvents } = await import('./musicVideo/events.js');
const projects = await import('./musicVideo/projects.js');
const imageHook = await import('./musicVideoSceneImageHook.js');
const videoHook = await import('./musicVideoSceneVideoHook.js');

async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor: predicate never became true');
}

const imageJob = (projectId, sceneId, filename, queuedAt) => ({
  kind: 'image', id: filename.replace(/\.png$/, ''), queuedAt,
  params: { musicVideo: { projectId, sceneId }, prompt: `frame ${filename}` },
  result: { filename },
});
const videoJob = (projectId, sceneId, id) => ({
  kind: 'video', id,
  params: { musicVideo: { projectId, sceneId }, prompt: 'slow dolly', sourceImagePath: '/abs/server/path/images/frame-a.png' },
  result: { generationId: id },
});

async function sceneOf(projectId, sceneId) {
  const project = await projects.getProject(projectId);
  return project?.scenes.find((s) => s.sceneId === sceneId);
}

describe('music-video scene completion hooks → takes', () => {
  let emitted;
  const capture = (event) => (data) => emitted.push({ event, ...data });
  const onImage = capture('scene-image');
  const onVideo = capture('scene-video');
  let project;
  let scene;

  beforeEach(async () => {
    rmSync(join(TEST_DATA_ROOT, 'music-video-projects.json'), { force: true });
    imageHook.__testing.reset();
    videoHook.__testing.reset();
    imageHook.initMusicVideoSceneImageHook();
    videoHook.initMusicVideoSceneVideoHook();
    emitted = [];
    musicVideoEvents.on('scene-image', onImage);
    musicVideoEvents.on('scene-video', onVideo);
    project = await projects.createProject({ name: 'Example Video' });
    scene = await projects.addProjectScene(project.id, { prompt: 'a lighthouse at dusk' });
  });

  afterEach(() => {
    imageHook.__testing.reset();
    videoHook.__testing.reset();
    musicVideoEvents.off('scene-image', onImage);
    musicVideoEvents.off('scene-video', onVideo);
  });

  afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

  it('keeps both of two out-of-order renders; the first to land fills the empty slot', async () => {
    // The newer-queued render completes first, then the older one lands late —
    // before #8965 the older render was dropped (or, reversed, overwrote the
    // newer frame). Now both are candidates and the selection stays put.
    mediaJobEvents.emit('completed', imageJob(project.id, scene.sceneId, 'newer.png', '2026-09-01T00:00:02.000Z'));
    await waitFor(() => emitted.length === 1);
    mediaJobEvents.emit('completed', imageJob(project.id, scene.sceneId, 'older.png', '2026-09-01T00:00:01.000Z'));
    await waitFor(() => emitted.length === 2);

    const stored = await sceneOf(project.id, scene.sceneId);
    expect(stored.takes.map((t) => t.assetId)).toEqual(['newer.png', 'older.png']);
    expect(stored.takes.every((t) => t.source === 'generated' && t.provider === 'portos' && t.status === 'candidate')).toBe(true);
    expect(stored.takes[1]).toMatchObject({ jobId: 'older', prompt: 'frame older.png' });
    expect(stored.referenceImageId).toBe('newer.png');
    // The socket payload carries the current selection + the full list.
    expect(emitted[1]).toMatchObject({ event: 'scene-image', sceneId: scene.sceneId, referenceImageId: 'newer.png' });
    expect(emitted[1].takes).toHaveLength(2);
  });

  it('never replaces an explicitly selected take, and a replayed completion adds no duplicate', async () => {
    mediaJobEvents.emit('completed', imageJob(project.id, scene.sceneId, 'first.png'));
    mediaJobEvents.emit('completed', imageJob(project.id, scene.sceneId, 'second.png'));
    await waitFor(() => emitted.length === 2);
    const second = (await sceneOf(project.id, scene.sceneId)).takes.find((t) => t.assetId === 'second.png');
    await projects.selectSceneTake(project.id, scene.sceneId, second.takeId);

    mediaJobEvents.emit('completed', imageJob(project.id, scene.sceneId, 'third.png'));
    mediaJobEvents.emit('completed', imageJob(project.id, scene.sceneId, 'first.png')); // replay
    await waitFor(() => emitted.length === 4);

    const stored = await sceneOf(project.id, scene.sceneId);
    expect(stored.referenceImageId).toBe('second.png');
    expect(stored.takes.map((t) => t.assetId)).toEqual(['first.png', 'second.png', 'third.png']);
  });

  it('records a clip take with its source frame as a basename, filling only an empty video slot', async () => {
    mediaJobEvents.emit('completed', videoJob(project.id, scene.sceneId, 'clip-1'));
    mediaJobEvents.emit('completed', videoJob(project.id, scene.sceneId, 'clip-2'));
    await waitFor(() => emitted.length === 2);
    const stored = await sceneOf(project.id, scene.sceneId);
    expect(stored.videoHistoryId).toBe('clip-1');
    expect(stored.takes.map((t) => [t.kind, t.assetId, t.sourceImageId])).toEqual([
      ['video', 'clip-1', 'frame-a.png'],
      ['video', 'clip-2', 'frame-a.png'],
    ]);
    expect(emitted[1]).toMatchObject({ event: 'scene-video', videoHistoryId: 'clip-1' });
  });

  it('a late completion cannot resurrect a deleted scene or a deleted project', async () => {
    const other = await projects.addProjectScene(project.id, { prompt: 'second scene' });
    await projects.deleteScene(project.id, scene.sceneId);
    mediaJobEvents.emit('completed', imageJob(project.id, scene.sceneId, 'late.png'));
    // A render for the surviving scene proves the hook ran past the failed one.
    mediaJobEvents.emit('completed', imageJob(project.id, other.sceneId, 'kept.png'));
    await waitFor(() => emitted.length === 1);
    const afterSceneDelete = await projects.getProject(project.id);
    expect(afterSceneDelete.scenes.map((s) => s.sceneId)).toEqual([other.sceneId]);
    expect(emitted[0].sceneId).toBe(other.sceneId);

    await projects.deleteProject(project.id);
    mediaJobEvents.emit('completed', videoJob(project.id, other.sceneId, 'late-clip'));
    await new Promise((r) => setTimeout(r, 40));
    expect(await projects.getProject(project.id)).toBeNull();
    const tombstone = await projects.getProject(project.id, { includeDeleted: true });
    expect(tombstone.deleted).toBe(true);
    expect(tombstone.scenes[0].takes.map((t) => t.assetId)).toEqual(['kept.png']);
    expect(emitted).toHaveLength(1);
  });
});
