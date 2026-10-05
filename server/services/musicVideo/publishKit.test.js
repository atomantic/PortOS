/**
 * Publishing kit build + copy (#9281), through the real project store and a
 * real ffmpeg: the build refuses without a final render, turns a finished
 * render into the platform encodes, thumbnails, captions and chapters on the
 * record, and a rebuild frees the files the previous kit made. The copy is
 * one provider call (injected here) whose JSON lands editable on the kit.
 */
import { describe, expect, it, vi, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-mv-publish-kit-'),
}));

const { PATHS } = await import('../../lib/paths.js');
const ffmpegService = await import('../../lib/ffmpeg.js');
const { findFfmpeg, runFfmpegProcess } = ffmpegService;
const projects = await import('./projects.js');
const { saveHistory } = await import('../videoGen/history.js');
const kit = await import('./publishKit.js');
const ffmpeg = await findFfmpeg();

afterAll(() => cleanupTempDataRoots());

const cue = (text, startSec, endSec) => ({ id: `lc-${startSec}`, text, startSec, endSec });
const scene = (startSec, endSec, sectionLabel, shotMode = 'performance') => ({ sceneId: `mvs-${startSec}`, order: startSec, startSec, endSec, sectionLabel, shotMode, takes: [] });

async function renderedProject() {
  const created = await projects.createProject({ name: 'Example Song' });
  await mkdir(PATHS.videos, { recursive: true });
  const filename = `master-${created.id.slice(3, 11)}.mp4`;
  const made = await runFfmpegProcess({ bin: ffmpeg, args: ['-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=36', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=36',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', join(PATHS.videos, filename)] });
  expect(made.ok).toBe(true);
  await saveHistory([{ id: 'render-1', filename, durationSec: 36 }]);
  await projects.mutateProjectRecord(created.id, (current) => ({ project: {
    ...current,
    renderHistoryId: 'render-1',
    audioAnalysis: { durationSec: 36 },
    scenes: [scene(0, 12, 'Verse 1'), scene(12, 24, 'Chorus 1'), scene(24, 36, 'Outro', 'cutaway')],
    lyricCues: [cue('first verse line', 1, 4), cue('the chorus line', 13, 16), cue('last words', 25, 28)],
  } }));
  return created.id;
}

describe('publishing kit build (#9281)', () => {
  it('refuses to build before there is a final render', async () => {
    const { id } = await projects.createProject({ name: 'Unrendered' });
    await expect(kit.startPublishKitBuild(id)).rejects.toMatchObject({ status: 409, code: 'NO_FINAL_RENDER' });
  });

  it('reserves a build before async prerequisites and releases the reservation after setup fails', async () => {
    const { id } = await projects.createProject({ name: 'Example Concurrent Build' });
    await mkdir(PATHS.videos, { recursive: true });
    await writeFile(join(PATHS.videos, 'concurrent-master.mp4'), 'placeholder; never encoded');
    await saveHistory([{ id: 'concurrent-render', filename: 'concurrent-master.mp4', durationSec: 36 }]);
    await projects.mutateProjectRecord(id, current => ({ project: { ...current, renderHistoryId: 'concurrent-render' } }));
    let releasePrerequisite;
    const pendingPrerequisite = new Promise(resolve => { releasePrerequisite = resolve; });
    const probe = vi.spyOn(ffmpegService, 'findFfmpeg').mockReturnValue(pendingPrerequisite);
    try {
      const first = kit.startPublishKitBuild(id);
      const firstFailure = first.catch(error => error);
      await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
      const overlap = kit.startPublishKitBuild(id);
      releasePrerequisite(null);
      // No SSE job exists yet, so nothing is advertised as attachable.
      expect(kit.getActivePublishKitBuild(id)).toBeNull();
      await expect(overlap).rejects.toMatchObject({ status: 409, code: 'PUBLISH_KIT_BUILD_IN_PROGRESS' });
      expect(await firstFailure).toMatchObject({ code: 'FFMPEG_MISSING' });
      expect(probe).toHaveBeenCalledTimes(1);
      // A failed setup must leave the project available for the next attempt.
      await expect(kit.startPublishKitBuild(id)).rejects.toMatchObject({ code: 'FFMPEG_MISSING' });
      expect(probe).toHaveBeenCalledTimes(2);
    } finally {
      releasePrerequisite(null);
      probe.mockRestore();
    }
  });

  it('keeps the original master identity when a new render finishes during a kit build', async () => {
    const { id } = await projects.createProject({ name: 'Example Master Identity' });
    await mkdir(PATHS.videos, { recursive: true });
    await writeFile(join(PATHS.videos, 'original-master.mp4'), 'placeholder; encoding is injected');
    await saveHistory([{ id: 'original-render', filename: 'original-master.mp4', durationSec: 36 }]);
    await projects.mutateProjectRecord(id, current => ({ project: { ...current, renderHistoryId: 'original-render' } }));
    let releaseEncode;
    const pendingEncode = new Promise(resolve => { releaseEncode = resolve; });
    const probe = vi.spyOn(ffmpegService, 'findFfmpeg').mockResolvedValue('example-ffmpeg');
    const encode = vi.spyOn(ffmpegService, 'runFfmpegProcess')
      .mockResolvedValue({ ok: true }).mockImplementationOnce(() => pendingEncode);
    try {
      await kit.startPublishKitBuild(id);
      await vi.waitFor(() => expect(encode).toHaveBeenCalledTimes(1));
      await projects.mutateProjectRecord(id, current => ({ project: { ...current, renderHistoryId: 'new-render' } }));
      releaseEncode({ ok: true });
      await vi.waitFor(async () => expect((await projects.getProject(id)).publishKit?.builtAt).toBeTruthy());
      const project = await projects.getProject(id);
      expect(project.renderHistoryId).toBe('new-render');
      expect(project.publishKit.master).toEqual({ filename: 'original-master.mp4', renderHistoryId: 'original-render' });
    } finally {
      releaseEncode({ ok: true });
      probe.mockRestore();
      encode.mockRestore();
    }
  });

  it.skipIf(!ffmpeg)('turns the final render into encodes, thumbnails, captions and chapters, and frees a rebuilt kit\'s old files', { timeout: 120000 }, async () => {
    const id = await renderedProject();
    await kit.startPublishKitBuild(id);
    await vi.waitFor(async () => expect((await projects.getProject(id)).publishKit?.builtAt).toBeTruthy(), { timeout: 90000, interval: 250 });
    const first = (await projects.getProject(id)).publishKit;
    expect(first.exports.map((e) => e.kind)).toEqual(['x-1080p', 'preview-720p', 'teaser', 'vertical-9x16']);
    for (const e of first.exports) expect(existsSync(join(PATHS.videos, e.filename))).toBe(true);
    expect(first.thumbnails).toHaveLength(2); // the two performance shots
    expect(first.thumbnail).toBe(first.thumbnails[0]);
    expect(await readFile(join(PATHS.videos, first.captionsFilename), 'utf8')).toContain('the chorus line');
    expect(first.chapters.map((c) => c.label)).toEqual(['first verse line', 'the chorus line', 'last words']);

    await expect(kit.startPublishKitBuild(id).then(() => kit.startPublishKitBuild(id))).rejects.toMatchObject({ code: 'PUBLISH_KIT_BUILD_IN_PROGRESS' });
    await vi.waitFor(async () => expect((await projects.getProject(id)).publishKit.builtAt).not.toBe(first.builtAt), { timeout: 90000, interval: 250 });
    await vi.waitFor(() => expect(existsSync(join(PATHS.videos, first.exports[0].filename))).toBe(false));
  });
});

const ALL_ON = Object.fromEntries(['youtube', 'shorts', 'x', 'tiktok', 'instagram', 'reddit', 'stackerNews', 'suno'].map((t) => [t, { enabled: true }]));

describe('publishing kit copy (#9281)', () => {
  const runner = (text) => ({
    resolveProviderAndModel: vi.fn(async () => ({ provider: { id: 'p1' }, selectedModel: 'm1' })),
    runPromptThroughProvider: vi.fn(async () => ({ text })),
  });

  it('drafts every platform from one call and keeps each field editable', async () => {
    const { id } = await projects.createProject({ name: 'Example Song' });
    const deps = { platforms: ALL_ON, history: {}, runner: runner(JSON.stringify({ youtube: { title: 'A title', description: 'desc', tags: ['music'] }, x: { hook: 'a hook', story: 'story' } })) };
    const { project } = await kit.draftPublishKitCopy(id, { notes: 'made it on a Sunday', links: { youtube: 'https://example.com/v' } }, deps);
    expect(deps.runner.runPromptThroughProvider).toHaveBeenCalledTimes(1);
    expect(deps.runner.runPromptThroughProvider.mock.calls[0][0]).toMatchObject({ source: 'music-video-publish-copy' });
    expect(project.publishKit).toMatchObject({ notes: 'made it on a Sunday', links: { youtube: 'https://example.com/v' }, copy: { youtube: { title: 'A title' }, x: { hook: 'a hook' } } });
    const edited = await kit.updatePublishKitCopy(id, { x: { hook: 'my own hook' } });
    expect(edited.project.publishKit.copy.x).toEqual({ hook: 'my own hook', story: 'story' });
    expect(edited.project.publishKit.copy.youtube.title).toBe('A title');
  });

  it('reports an unusable draft instead of saving it', async () => {
    const { id } = await projects.createProject({ name: 'Example Song' });
    await expect(kit.draftPublishKitCopy(id, {}, { platforms: ALL_ON, history: {}, runner: runner('sorry, no JSON') })).rejects.toMatchObject({ status: 502, code: 'PUBLISH_COPY_UNPARSEABLE' });
    expect((await projects.getProject(id)).publishKit).toBeFalsy();
  });

  it('drafts only the platforms the director posts to, keeps other copy, and passes their ratings on', async () => {
    const { id } = await projects.createProject({ name: 'Example Song' });
    await projects.mutateProjectRecord(id, (current) => ({ project: { ...current, publishKit: { copy: { reddit: { title: 'kept', body: '' } } } } }));
    const deps = {
      platforms: { x: { enabled: true }, suno: { enabled: true }, reddit: { enabled: false } },
      history: { x: { notes: [{ reception: 'good', notes: 'the cost hook worked' }] }, reddit: { notes: [{ reception: 'poor', notes: 'downvoted' }] } },
      runner: runner(JSON.stringify({ youtube: { title: 'T' }, x: { hook: 'h' }, reddit: { title: 'ignored' } })),
    };
    const { project } = await kit.draftPublishKitCopy(id, {}, deps);
    const prompt = deps.runner.runPromptThroughProvider.mock.calls[0][0].prompt;
    expect(prompt).toContain('"x":{');
    expect(prompt).toContain('"youtube":{'); // Suno's caption reuses it
    expect(prompt).not.toContain('"reddit":{');
    expect(prompt).toContain('x (good): the cost hook worked');
    expect(prompt).not.toContain('downvoted');
    expect(Object.keys(project.publishKit.copy).sort()).toEqual(['reddit', 'x', 'youtube']);
    expect(project.publishKit.copy.reddit.title).toBe('kept');
  });

  it('refuses to draft before any platform is turned on', async () => {
    const { id } = await projects.createProject({ name: 'Example Song' });
    await expect(kit.draftPublishKitCopy(id, {}, { platforms: {}, history: {}, runner: runner('{}') })).rejects.toMatchObject({ status: 409, code: 'PUBLISH_NO_PLATFORMS' });
  });

  it('only selects a thumbnail the kit built', async () => {
    const { id } = await projects.createProject({ name: 'Example Song' });
    await projects.mutateProjectRecord(id, (current) => ({ project: { ...current, publishKit: { thumbnails: ['a.jpg', 'b.jpg'], thumbnail: 'a.jpg' } } }));
    expect((await kit.selectPublishKitThumbnail(id, 'b.jpg')).project.publishKit.thumbnail).toBe('b.jpg');
    await expect(kit.selectPublishKitThumbnail(id, 'elsewhere.jpg')).rejects.toMatchObject({ status: 422 });
  });
});
