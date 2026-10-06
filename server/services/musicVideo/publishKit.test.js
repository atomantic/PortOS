/**
 * Publishing kit build + copy (#9281), through the real project store and a
 * real ffmpeg: the build refuses without a final render, turns a finished
 * render into the platform encodes, thumbnails, captions and chapters on the
 * record, and a rebuild frees the files the previous kit made. The copy is
 * one provider call (injected here) whose JSON lands editable on the kit.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
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
const excerptRender = await import('./excerptRender.js');
const { captureMusicVideoEvidence } = await import('../../lib/musicVideoDependencies.js');
const ffmpeg = await findFfmpeg();
const watchedBuilds = new Set();
const startPublishKitBuild = kit.startPublishKitBuild.bind(kit);
vi.spyOn(kit, 'startPublishKitBuild').mockImplementation(async (id, ...rest) => {
  watchedBuilds.add(id);
  return startPublishKitBuild(id, ...rest);
});

// A timed-out encode keeps writing this file's shared video directory. Cancel
// the job and wait until it has left the active set before the next case runs.
async function drainPublishKitBuilds() {
  for (const id of watchedBuilds) {
    const active = kit.getActivePublishKitBuild(id);
    if (active) kit.cancelPublishKitBuild(active.jobId);
  }
  const pending = [...watchedBuilds].some(id => kit.getActivePublishKitBuild(id));
  if (!pending) return;
  await vi.waitFor(() => {
    expect([...watchedBuilds].every(id => kit.getActivePublishKitBuild(id) === null)).toBe(true);
  }, { timeout: 15000, interval: 20 });
}

afterEach(drainPublishKitBuilds);
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

  it('stops a superseded kit build before the next case reuses the project', async () => {
    const { id } = await projects.createProject({ name: 'Example Held Build' });
    await mkdir(PATHS.videos, { recursive: true });
    await writeFile(join(PATHS.videos, 'held-master.mp4'), 'placeholder; encoding is held');
    await saveHistory([{ id: 'held-render', filename: 'held-master.mp4', durationSec: 36 }]);
    await projects.mutateProjectRecord(id, current => ({ project: { ...current, renderHistoryId: 'held-render' } }));
    const probe = vi.spyOn(ffmpegService, 'findFfmpeg').mockResolvedValue('example-ffmpeg');
    const encode = vi.spyOn(ffmpegService, 'runFfmpegProcess').mockImplementation(({ signal }) => new Promise(resolve => {
      if (signal?.aborted) resolve({ ok: false, reason: 'cancelled' });
      else signal?.addEventListener('abort', () => resolve({ ok: false, reason: 'cancelled' }), { once: true });
    }));
    try {
      await kit.startPublishKitBuild(id);
      await vi.waitFor(() => expect(kit.getActivePublishKitBuild(id)?.jobId).toBeTruthy());
      await drainPublishKitBuilds();
      await projects.mutateProjectRecord(id, current => ({ project: { ...current, marker: 'next-case' } }));
      await new Promise(resolve => setTimeout(resolve, 30));
      const project = await projects.getProject(id);
      expect(project.marker).toBe('next-case');
      expect(project.publishKit?.builtAt).toBeFalsy();
    } finally {
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
    // #10377: the vertical cut fits the whole frame over a blurred fill instead of center-cropping text away.
    const vertical = first.exports.find((e) => e.kind === 'vertical-9x16');
    const probed = await runFfmpegProcess({ bin: ffmpeg, args: ['-hide_banner', '-i', join(PATHS.videos, vertical.filename), '-f', 'null', '-'] });
    expect(probed.ok).toBe(true);
    expect(first.thumbnails).toHaveLength(2); // the two performance shots
    expect(first.thumbnail).toBe(first.thumbnails[0]);
    expect(await readFile(join(PATHS.videos, first.captionsFilename), 'utf8')).toContain('the chorus line');
    expect(first.chapters.map((c) => c.label)).toEqual(['first verse line', 'the chorus line', 'last words']);

    await expect(kit.startPublishKitBuild(id).then(() => kit.startPublishKitBuild(id))).rejects.toMatchObject({ code: 'PUBLISH_KIT_BUILD_IN_PROGRESS' });
    await vi.waitFor(async () => expect((await projects.getProject(id)).publishKit.builtAt).not.toBe(first.builtAt), { timeout: 90000, interval: 250 });
    await vi.waitFor(() => expect(existsSync(join(PATHS.videos, first.exports[0].filename))).toBe(false));
  });

  // A document project whose final render was made from its current composition.
  const documentRendered = async () => {
    const id = await renderedProject();
    await projects.mutateProjectRecord(id, (current) => {
      const next = { ...current, composition: { mode: 'document', version: 'v1' } };
      return { project: { ...next, renderDependencies: captureMusicVideoEvidence(next) } };
    });
    return id;
  };

  it.skipIf(!ffmpeg)('renders the 9:16 cut natively when the composition lays itself out at that frame', { timeout: 120000 }, async () => {
    const id = await documentRendered();
    const progress = [];
    const native = vi.spyOn(excerptRender, 'renderSeekedWindow').mockImplementation(async (project, { outputPath, aspect, startSec, endSec, fade, onProgress }) => {
      onProgress(0.5);
      progress.push(0.5);
      expect({ id: project.id, aspect, fade }).toEqual({ id, aspect: '9:16', fade: true });
      expect(endSec).toBeGreaterThan(startSec);
      await writeFile(outputPath, 'native 9:16 render');
      return { width: 1080, height: 1920 };
    });
    const encode = vi.spyOn(ffmpegService, 'runFfmpegProcess');
    try {
      await kit.startPublishKitBuild(id);
      await vi.waitFor(async () => expect((await projects.getProject(id)).publishKit?.builtAt).toBeTruthy(), { timeout: 90000, interval: 250 });
      const vertical = (await projects.getProject(id)).publishKit.exports.find((e) => e.kind === 'vertical-9x16');
      expect(vertical.layout).toBe('native');
      expect(await readFile(join(PATHS.videos, vertical.filename), 'utf8')).toBe('native 9:16 render');
      // the master was never squeezed into 9:16 for it
      expect(encode.mock.calls.some(([o]) => o.args.includes(kit.VERTICAL_FIT_FILTER))).toBe(false);
    } finally {
      native.mockRestore();
      encode.mockRestore();
    }
  });

  it.skipIf(!ffmpeg)('fits the master when the composition has no 9:16 layout', { timeout: 120000 }, async () => {
    const id = await documentRendered();
    const native = vi.spyOn(excerptRender, 'renderSeekedWindow').mockImplementation(async (_project, { outputPath }) => {
      await writeFile(outputPath, 'partial');
      throw Object.assign(new Error('The composition document is 1920x1080 and does not declare 1080x1920'), { code: 'COMPOSITION_DOCUMENT_FORMAT' });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await kit.startPublishKitBuild(id);
      await vi.waitFor(async () => expect((await projects.getProject(id)).publishKit?.builtAt).toBeTruthy(), { timeout: 90000, interval: 250 });
      const vertical = (await projects.getProject(id)).publishKit.exports.find((e) => e.kind === 'vertical-9x16');
      expect(vertical.layout).toBe('fit');
      const probed = await runFfmpegProcess({ bin: ffmpeg, args: ['-hide_banner', '-i', join(PATHS.videos, vertical.filename), '-f', 'null', '-'] });
      expect(probed.ok).toBe(true);
      expect(warn.mock.calls.some(([m]) => /fitting the master/.test(m))).toBe(true);
    } finally {
      native.mockRestore();
      warn.mockRestore();
    }
  });

  it.skipIf(!ffmpeg)('fits the master when the composition changed since the final render', { timeout: 120000 }, async () => {
    const id = await documentRendered();
    await projects.mutateProjectRecord(id, (current) => ({ project: { ...current, composition: { ...current.composition, version: 'v2' } } }));
    const native = vi.spyOn(excerptRender, 'renderSeekedWindow');
    try {
      await kit.startPublishKitBuild(id);
      await vi.waitFor(async () => expect((await projects.getProject(id)).publishKit?.builtAt).toBeTruthy(), { timeout: 90000, interval: 250 });
      expect((await projects.getProject(id)).publishKit.exports.find((e) => e.kind === 'vertical-9x16').layout).toBe('fit');
      expect(native).not.toHaveBeenCalled();
    } finally {
      native.mockRestore();
    }
  });

  it.skipIf(!ffmpeg)('cancelling during the native cut cancels the build and leaves no partial file', { timeout: 120000 }, async () => {
    const id = await documentRendered();
    let partial = null;
    const native = vi.spyOn(excerptRender, 'renderSeekedWindow').mockImplementation(async (_project, { outputPath, signal }) => {
      partial = outputPath;
      await writeFile(outputPath, 'partial');
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('Render cancelled'), { code: 'CANCELED' })), { once: true }));
    });
    const encode = vi.spyOn(ffmpegService, 'runFfmpegProcess');
    try {
      await kit.startPublishKitBuild(id);
      await vi.waitFor(() => expect(partial).toBeTruthy(), { timeout: 90000, interval: 50 });
      const fitsBefore = encode.mock.calls.length;
      kit.cancelPublishKitBuild(kit.getActivePublishKitBuild(id).jobId);
      await vi.waitFor(() => expect(kit.getActivePublishKitBuild(id)).toBeNull(), { timeout: 15000, interval: 20 });
      expect(existsSync(partial)).toBe(false);
      expect(encode.mock.calls.slice(fitsBefore).some(([o]) => o.args.includes(kit.VERTICAL_FIT_FILTER))).toBe(false);
      expect((await projects.getProject(id)).publishKit?.builtAt).toBeFalsy();
    } finally {
      native.mockRestore();
      encode.mockRestore();
    }
  });
});

describe('renderSeekedWindow (the kit\'s native 9:16 cut)', () => {
  it('has nothing to render for a footage project', async () => {
    expect(await excerptRender.renderSeekedWindow({ id: 'mv-x', composition: { mode: 'footage' } }, { startSec: 0, endSec: 10, aspect: '9:16' }, { renderers: {} })).toBeNull();
  });

  it('renders the window at the asked aspect, clamped to the song', async () => {
    const encode = vi.fn(async (input) => ({ width: 1080, height: 1920, input }));
    const renderers = { document: { prepare: vi.fn(async (project) => ({ totalSec: 30, project })), encode } };
    const stored = { id: 'mv-x', aspect: '16:9', composition: { mode: 'document' } };
    const out = await excerptRender.renderSeekedWindow(stored, { startSec: 20, endSec: 45, aspect: '9:16', fade: true, outputPath: '/tmp/v.mp4', jobId: 'job' }, { renderers, resolveAudio: async () => '/tmp/song.wav' });
    expect(out).toMatchObject({ width: 1080, height: 1920 });
    const input = encode.mock.calls[0][0];
    expect(input).toMatchObject({ startSec: 20, endSec: 30, fade: true, outputPath: '/tmp/v.mp4', audioPath: '/tmp/song.wav', soundBed: null });
    expect(renderers.document.prepare.mock.calls[0][0]).not.toBe(stored); // re-framed view, the record untouched
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
    // Nothing beyond the title is ticked by default, so the model's tags are dropped and the choice is kept for a redraft.
    expect(project.publishKit).toMatchObject({ notes: 'made it on a Sunday', links: { youtube: 'https://example.com/v' }, copy: { youtube: { title: 'A title' }, x: { hook: 'a hook' } } });
    expect(project.publishKit.copy.youtube).not.toHaveProperty('tags');
    expect(project.publishKit.draftOptions).toEqual({ include: { title: true, lyrics: false, spend: false, chapters: false, hashtags: false }, length: 'short' });
    const edited = await kit.updatePublishKitCopy(id, { x: { hook: 'my own hook' } });
    expect(edited.project.publishKit.copy.x).toEqual({ hook: 'my own hook', story: 'story' });
    expect(edited.project.publishKit.copy.youtube.title).toBe('A title');
  });

  it('will not replace posts edited by hand unless the director confirms, and keeps fields the draft leaves out', async () => {
    const { id } = await projects.createProject({ name: 'Example Song' });
    await kit.updatePublishKitCopy(id, { youtube: { title: 'My title', tags: ['my tag'] } });
    const deps = { platforms: ALL_ON, history: {}, runner: runner(JSON.stringify({ youtube: { title: 'Drafted', description: 'd', tags: ['model tag'] } })) };
    await expect(kit.draftPublishKitCopy(id, {}, deps)).rejects.toMatchObject({ status: 409, code: 'PUBLISH_COPY_EDITED' });
    expect(deps.runner.runPromptThroughProvider).not.toHaveBeenCalled();
    const { project } = await kit.draftPublishKitCopy(id, { replaceEdited: true }, deps);
    expect(project.publishKit.copy.youtube).toEqual({ title: 'Drafted', description: 'd', tags: ['my tag'] });
    // Right after a draft nothing was edited, so redrafting needs no confirmation.
    await expect(kit.draftPublishKitCopy(id, {}, deps)).resolves.toBeTruthy();
  });

  it('clears tags an earlier draft wrote once hashtags are unticked', async () => {
    const { id } = await projects.createProject({ name: 'Example Song' });
    const reply = JSON.stringify({ youtube: { title: 'Drafted', description: 'd', tags: ['model tag'] } });
    const deps = { platforms: { youtube: { enabled: true } }, history: {}, runner: runner(reply) };
    const first = await kit.draftPublishKitCopy(id, { include: { hashtags: true } }, deps);
    expect(first.project.publishKit.copy.youtube.tags).toEqual(['model tag']);
    // A draft with YouTube off in between still remembers which tags the model wrote.
    await kit.draftPublishKitCopy(id, {}, { ...deps, platforms: { x: { enabled: true } }, runner: runner(JSON.stringify({ x: { hook: 'h' } })) });
    const second = await kit.draftPublishKitCopy(id, {}, deps);
    expect(second.project.publishKit.copy.youtube.tags).toEqual([]);
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
