/**
 * The YouTube thumbnail, through the real project store and real sharp: it is
 * composed 16:9 from a kit frame in the cover's lettering, the YouTube post
 * uploads it over the bare frame, a new cover design re-sets it, and the
 * Test & Compare set keeps up to three variants whose files outlive the next
 * thumbnail and go once removed.
 */
import { describe, expect, it, vi, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-mv-yt-thumb-'),
}));

const { PATHS } = await import('../../lib/paths.js');
const projects = await import('./projects.js');
const thumbs = await import('./youtubeThumbnail.js');
const cover = await import('./coverArt.js');
const { buildPublishPayload } = await import('./publish/payloads.js');
const sharp = (await import('sharp')).default;

afterAll(() => cleanupTempDataRoots());

async function projectWithFrame() {
  const { id } = await projects.createProject({ name: 'Example Song' });
  await mkdir(PATHS.videoThumbnails, { recursive: true });
  const frame = `frame-${id.slice(3, 11)}.jpg`;
  // A square frame, so the 16:9 crop has height to spare and focusY moves it.
  await sharp({ create: { width: 800, height: 800, channels: 3, background: '#446688' } }).jpeg().toFile(join(PATHS.videoThumbnails, frame));
  await projects.mutateProjectRecord(id, (current) => ({ project: { ...current, publishKit: { thumbnails: [frame], thumbnail: frame } } }));
  return { id, frame };
}
const kitOf = async (id) => (await projects.getProject(id)).publishKit;

describe('YouTube thumbnail', () => {
  it('composes a 1280x720 thumbnail with the title, which the YouTube post uploads over the bare frame', async () => {
    const { id, frame } = await projectWithFrame();
    await thumbs.composeProjectYoutubeThumbnail(id, { source: { kind: 'thumbnail', filename: frame }, focusY: 0.2 });
    const made = (await kitOf(id)).youtubeThumbnail;
    expect(made).toMatchObject({ source: { kind: 'thumbnail', filename: frame }, title: 'Example Song', focusY: 0.2, lettering: true });
    const image = sharp(await readFile(join(PATHS.videoThumbnails, made.filename)));
    expect(await image.metadata()).toMatchObject({ format: 'jpeg', width: 1280, height: 720 });
    // The title is drawn over the flat frame.
    expect(Math.max(...(await image.stats()).channels.map((c) => c.stdev))).toBeGreaterThan(5);

    const project = await projects.getProject(id);
    const payload = buildPublishPayload('youtube', { ...project, publishKit: { ...project.publishKit, master: { filename: 'master.mp4' }, copy: { youtube: { title: 'Example title' } } } }, {});
    expect(payload.thumbnail).toMatchObject({ dir: 'videoThumbnails', name: made.filename, made: true });

    // Going back to the frame drops the made file.
    await thumbs.clearProjectYoutubeThumbnail(id);
    expect((await kitOf(id)).youtubeThumbnail).toBeUndefined();
    expect(existsSync(join(PATHS.videoThumbnails, made.filename))).toBe(false);
  });

  it('re-sets a lettered thumbnail when the cover lettering changes', async () => {
    const { id, frame } = await projectWithFrame();
    await thumbs.composeProjectYoutubeThumbnail(id, { source: { kind: 'thumbnail', filename: frame }, title: 'Example' });
    const before = (await kitOf(id)).youtubeThumbnail.filename;
    const { project } = await cover.saveCoverDesign(id, { layout: 'top-center' });
    expect(project.publishKit.youtubeThumbnail.filename).not.toBe(before);
    expect(project.publishKit.youtubeThumbnail.title).toBe('Example');
    expect(existsSync(join(PATHS.videoThumbnails, before))).toBe(false);
  });

  it('keeps up to three variants for Test & Compare, past the next thumbnail, and frees one once removed', async () => {
    const { id, frame } = await projectWithFrame();
    await expect(thumbs.addYoutubeThumbnailTest(id)).rejects.toMatchObject({ status: 422 });
    const kept = [];
    for (const title of ['One', 'Two', 'Three']) {
      await thumbs.composeProjectYoutubeThumbnail(id, { source: { kind: 'thumbnail', filename: frame }, title });
      await thumbs.addYoutubeThumbnailTest(id);
      await thumbs.addYoutubeThumbnailTest(id); // adding the same one twice keeps one
      kept.push((await kitOf(id)).youtubeThumbnail.filename);
    }
    expect((await kitOf(id)).youtubeThumbnailTests.map((t) => t.title)).toEqual(['One', 'Two', 'Three']);
    // Making the next thumbnail leaves every variant's file in place.
    await thumbs.composeProjectYoutubeThumbnail(id, { title: 'Four' });
    for (const f of kept) expect(existsSync(join(PATHS.videoThumbnails, f))).toBe(true);
    await expect(thumbs.addYoutubeThumbnailTest(id)).rejects.toMatchObject({ status: 422 });

    await thumbs.removeYoutubeThumbnailTest(id, kept[0]);
    expect((await kitOf(id)).youtubeThumbnailTests).toHaveLength(2);
    expect(existsSync(join(PATHS.videoThumbnails, kept[0]))).toBe(false);
    // A name the set never held is never deleted.
    await thumbs.removeYoutubeThumbnailTest(id, frame);
    expect(existsSync(join(PATHS.videoThumbnails, frame))).toBe(true);
  });
});
