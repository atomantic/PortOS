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
  const onFailure = capture('scene-failure');
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
    musicVideoEvents.on('scene-failure', onFailure);
    project = await projects.createProject({ name: 'Example Video' });
    scene = await projects.addProjectScene(project.id, { prompt: 'a lighthouse at dusk' });
  });

  afterEach(() => {
    imageHook.__testing.reset();
    videoHook.__testing.reset();
    musicVideoEvents.off('scene-image', onImage);
    musicVideoEvents.off('scene-video', onVideo);
    musicVideoEvents.off('scene-failure', onFailure);
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

  it('a completion racing a director selection loses neither (one write tail on the file store)', async () => {
    mediaJobEvents.emit('completed', imageJob(project.id, scene.sceneId, 'one.png'));
    mediaJobEvents.emit('completed', imageJob(project.id, scene.sceneId, 'two.png'));
    await waitFor(() => emitted.length === 2);
    const two = (await sceneOf(project.id, scene.sceneId)).takes.find((t) => t.assetId === 'two.png');
    // Same tick: a third render lands while the director picks take two.
    mediaJobEvents.emit('completed', imageJob(project.id, scene.sceneId, 'three.png'));
    await Promise.all([
      projects.selectSceneTake(project.id, scene.sceneId, two.takeId),
      projects.updateScene(project.id, scene.sceneId, { prompt: 'edited while rendering' }),
    ]);
    await waitFor(() => emitted.length === 3);
    const stored = await sceneOf(project.id, scene.sceneId);
    expect(stored.referenceImageId).toBe('two.png');
    expect(stored.prompt).toBe('edited while rendering');
    expect(stored.takes.map((t) => t.assetId)).toEqual(['one.png', 'two.png', 'three.png']);
  });

  it('records a clip take with its source frame as a basename, filling only an empty video slot', async () => {
    await projects.updateScene(project.id, scene.sceneId, { referenceImageId: 'frame-a.png' });
    mediaJobEvents.emit('completed', videoJob(project.id, scene.sceneId, 'clip-1'));
    mediaJobEvents.emit('completed', videoJob(project.id, scene.sceneId, 'clip-2'));
    await waitFor(() => emitted.length === 2);
    const stored = await sceneOf(project.id, scene.sceneId);
    expect(stored.videoHistoryId).toBe('clip-1');
    expect(stored.takes.filter((t) => t.kind === 'video').map((t) => [t.kind, t.assetId, t.sourceImageId])).toEqual([
      ['video', 'clip-1', 'frame-a.png'],
      ['video', 'clip-2', 'frame-a.png'],
    ]);
    expect(emitted[1]).toMatchObject({ event: 'scene-video', videoHistoryId: 'clip-1' });
  });

  it('keeps a late clip as a historical candidate when its source plate was replaced', async () => {
    await projects.updateScene(project.id, scene.sceneId, { referenceImageId: 'frame-b.png' });
    mediaJobEvents.emit('completed', videoJob(project.id, scene.sceneId, 'clip-old'));
    await waitFor(() => emitted.length === 1);
    const stored = await sceneOf(project.id, scene.sceneId);
    expect(stored.videoHistoryId).toBeNull();
    expect(stored.takes.find((take) => take.assetId === 'clip-old')).toMatchObject({ sourceImageId: 'frame-a.png', dependencyState: { status: 'stale' } });
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

  // #10154 — a failed render is persisted on the scene so the board can say
  // which scene failed and why (including after a reload), and a landed take
  // for the same lane retires it.
  describe('scene lastFailure (#10154)', () => {
    it('records a failed frame and clip render on the scene and announces it', async () => {
      mediaJobEvents.emit('failed', { ...imageJob(project.id, scene.sceneId, 'x.png'), status: 'failed', error: 'CUDA out of memory\n  at step 3' });
      await waitFor(() => emitted.some((e) => e.event === 'scene-failure'));
      let stored = await sceneOf(project.id, scene.sceneId);
      expect(stored.lastFailure).toMatchObject({ lane: 'image', error: 'CUDA out of memory at step 3' });
      expect(typeof stored.lastFailure.at).toBe('string');
      expect(emitted.find((e) => e.event === 'scene-failure')).toMatchObject({ projectId: project.id, sceneId: scene.sceneId, lastFailure: stored.lastFailure });

      mediaJobEvents.emit('failed', { ...videoJob(project.id, scene.sceneId, 'clip-x'), status: 'failed', error: 'provider timed out' });
      await waitFor(async () => (await sceneOf(project.id, scene.sceneId)).lastFailure?.lane === 'video');
      stored = await sceneOf(project.id, scene.sceneId);
      expect(stored.lastFailure).toMatchObject({ lane: 'video', error: 'provider timed out' });
    });

    it('does not record a cancel as a failure', async () => {
      mediaJobEvents.emit('canceled', { ...imageJob(project.id, scene.sceneId, 'x.png'), status: 'canceled', error: 'Canceled' });
      // A later failure for the surviving scene proves the cancel was processed first.
      const other = await projects.addProjectScene(project.id, { prompt: 'second' });
      mediaJobEvents.emit('failed', { ...imageJob(project.id, other.sceneId, 'y.png'), status: 'failed', error: 'boom' });
      await waitFor(() => emitted.some((e) => e.event === 'scene-failure'));
      expect((await sceneOf(project.id, scene.sceneId)).lastFailure).toBeUndefined();
      expect((await sceneOf(project.id, other.sceneId)).lastFailure).toMatchObject({ error: 'boom' });
    });

    it('a landed take for the failed lane clears it; the other lane keeps it', async () => {
      mediaJobEvents.emit('failed', { ...videoJob(project.id, scene.sceneId, 'clip-x'), status: 'failed', error: 'clip broke' });
      await waitFor(async () => (await sceneOf(project.id, scene.sceneId)).lastFailure?.lane === 'video');

      mediaJobEvents.emit('completed', imageJob(project.id, scene.sceneId, 'frame.png'));
      await waitFor(() => emitted.some((e) => e.event === 'scene-image'));
      expect((await sceneOf(project.id, scene.sceneId)).lastFailure).toMatchObject({ lane: 'video' });
      expect(emitted.find((e) => e.event === 'scene-image').lastFailure).toMatchObject({ lane: 'video' });

      await projects.updateScene(project.id, scene.sceneId, { referenceImageId: 'frame.png' });
      mediaJobEvents.emit('completed', videoJob(project.id, scene.sceneId, 'clip-ok'));
      await waitFor(() => emitted.some((e) => e.event === 'scene-video'));
      expect((await sceneOf(project.id, scene.sceneId)).lastFailure).toBeUndefined();
      expect(emitted.find((e) => e.event === 'scene-video').lastFailure).toBeNull();
    });

    it('a failure for a deleted scene is dropped without resurrecting it', async () => {
      const other = await projects.addProjectScene(project.id, { prompt: 'second' });
      await projects.deleteScene(project.id, scene.sceneId);
      mediaJobEvents.emit('failed', { ...imageJob(project.id, scene.sceneId, 'late.png'), status: 'failed', error: 'late' });
      mediaJobEvents.emit('failed', { ...imageJob(project.id, other.sceneId, 'kept.png'), status: 'failed', error: 'kept' });
      await waitFor(() => emitted.some((e) => e.event === 'scene-failure'));
      const stored = await projects.getProject(project.id);
      expect(stored.scenes.map((s) => s.sceneId)).toEqual([other.sceneId]);
      expect(emitted.filter((e) => e.event === 'scene-failure')).toHaveLength(1);
    });
  });
});
