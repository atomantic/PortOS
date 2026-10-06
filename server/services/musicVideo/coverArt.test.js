/**
 * Release cover art, through the real project store: composing writes one
 * square cover onto the kit (title from the project, tag from the DistroKid
 * artist) and frees the previous one; "make a cover image" queues one tagged
 * image job, and its completion composes the cover from the result, or
 * records why it failed. The lettering itself renders through real sharp once.
 */
import { describe, expect, it, vi, afterAll, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-mv-cover-art-'),
}));

const { PATHS } = await import('../../lib/paths.js');
const projects = await import('./projects.js');
const { musicVideoEvents } = await import('./events.js');
const cover = await import('./coverArt.js');
const { composeCoverArt } = await import('./coverArtCompose.js');

afterAll(() => cleanupTempDataRoots());

const compose = vi.fn(async ({ out }) => { await writeFile(out, 'jpeg'); return { width: 3000, height: 3000 }; });
const enqueue = vi.fn(async () => ({ jobId: 'job-example' }));
const jobStatus = vi.fn(async () => 'queued');
const chooseRoute = vi.fn(async (_project, { preferred } = {}) => (preferred?.mode === 'codex' ? { mode: 'codex', model: null } : null));

beforeEach(() => {
  compose.mockClear(); enqueue.mockReset(); enqueue.mockResolvedValue({ jobId: 'job-example' }); chooseRoute.mockClear();
  jobStatus.mockReset(); jobStatus.mockResolvedValue('queued');
  cover.__setCoverArtDepsForTests({
    compose, enqueue, chooseRoute, jobStatus,
    getSettings: async () => ({}),
    getPlatforms: async () => ({ distrokid: { enabled: true, account: 'Example Artist' } }),
    imageParams: async (_settings, route, common) => ({ ...common, provider: route.mode }),
    withStyle: async (_project, params) => params,
  });
});

async function projectWithThumbnail(name = 'Example Song') {
  const { id } = await projects.createProject({ name });
  await mkdir(PATHS.videoThumbnails, { recursive: true });
  const thumb = `thumb-${id.slice(3, 11)}.jpg`;
  await writeFile(join(PATHS.videoThumbnails, thumb), 'jpeg');
  await projects.mutateProjectRecord(id, (current) => ({ project: { ...current, publishKit: { thumbnails: [thumb], thumbnail: thumb } } }));
  return { id, thumb };
}

describe('release cover art', () => {
  it('composes a cover from a kit thumbnail with the project title and the DistroKid artist, and frees the one it replaces', async () => {
    const { id, thumb } = await projectWithThumbnail();
    const events = [];
    const onCover = (e) => events.push(e);
    musicVideoEvents.on('cover-art', onCover);
    try {
      const { project } = await cover.composeProjectCoverArt(id, { source: { kind: 'thumbnail', filename: thumb } });
      const art = project.publishKit.coverArt;
      expect(art).toMatchObject({ title: 'Example Song', tag: 'Example Artist', focusX: 0.5, source: { kind: 'thumbnail', filename: thumb } });
      expect(compose).toHaveBeenCalledWith(expect.objectContaining({ source: join(PATHS.videoThumbnails, thumb), title: 'Example Song', tag: 'Example Artist' }));
      expect(existsSync(join(PATHS.videoThumbnails, art.filename))).toBe(true);
      // The thumbnail stays the YouTube thumbnail; the cover is its own file.
      expect(project.publishKit.thumbnail).toBe(thumb);

      // A re-compose keeps the source and edits only what it names.
      const again = (await cover.composeProjectCoverArt(id, { title: 'Example Retitle', focusX: 0.2 })).project.publishKit.coverArt;
      expect(again).toMatchObject({ title: 'Example Retitle', tag: 'Example Artist', focusX: 0.2, source: { kind: 'thumbnail', filename: thumb } });
      expect(existsSync(join(PATHS.videoThumbnails, art.filename))).toBe(false);
      expect(events.map((e) => e.projectId)).toEqual([id, id]);
    } finally {
      musicVideoEvents.off('cover-art', onCover);
    }
  });

  it('refuses a thumbnail the kit did not cut and a gallery image that is not there', async () => {
    const { id } = await projectWithThumbnail();
    await expect(cover.composeProjectCoverArt(id, { source: { kind: 'thumbnail', filename: 'other.jpg' } })).rejects.toMatchObject({ status: 422 });
    await expect(cover.composeProjectCoverArt(id, { source: { kind: 'image', filename: 'missing-example.png' } })).rejects.toMatchObject({ status: 422, code: 'PUBLISH_ASSET_MISSING' });
    await expect(cover.composeProjectCoverArt(id, {})).rejects.toMatchObject({ status: 422 });
    expect(compose).not.toHaveBeenCalled();
  });

  it('queues one tagged cover image on Codex, then composes the cover from it when it lands', async () => {
    const { id } = await projectWithThumbnail();
    const { project } = await cover.generateCoverArtSource(id, { notes: 'Close-up profile of the singer' });
    expect(project.publishKit.coverArt.pending).toMatchObject({ jobId: 'job-example', mode: 'codex' });
    const { requestId } = project.publishKit.coverArt.pending;
    const job = enqueue.mock.calls[0][0];
    expect(job).toMatchObject({ kind: 'image', params: { width: 1024, height: 1024, provider: 'codex', musicVideo: { projectId: id, coverArt: { requestId } } } });
    expect(job.params.prompt).toContain('Close-up profile of the singer');
    expect(job.params.prompt).toContain('No text');
    await expect(cover.generateCoverArtSource(id)).rejects.toMatchObject({ status: 409, code: 'COVER_ART_IN_PROGRESS' });

    await mkdir(PATHS.images, { recursive: true });
    await writeFile(join(PATHS.images, 'job-example.png'), 'png');
    expect(await cover.onCoverArtImageSettled({ projectId: id, requestId, filename: 'job-example.png' })).toBe(true);
    const art = (await projects.getProject(id)).publishKit.coverArt;
    expect(art).toMatchObject({ pending: null, generated: ['job-example.png'], source: { kind: 'image', filename: 'job-example.png' } });
    expect(art.filename).toMatch(/^cover-.+\.jpg$/);
  });

  it('records a failed cover image, and a stale one only joins the pickable sources', async () => {
    const { id } = await projectWithThumbnail();
    const { requestId } = (await cover.generateCoverArtSource(id)).project.publishKit.coverArt.pending;
    expect(await cover.onCoverArtImageSettled({ projectId: id, requestId: 'req-stale', filename: 'stale-example.png' })).toBe(true);
    let art = (await projects.getProject(id)).publishKit.coverArt;
    expect(art.generated).toEqual(['stale-example.png']);
    expect(art.pending.requestId).toBe(requestId);
    expect(compose).not.toHaveBeenCalled();

    await cover.onCoverArtImageSettled({ projectId: id, requestId, status: 'failed', error: 'Codex refused the prompt' });
    art = (await projects.getProject(id)).publishKit.coverArt;
    expect(art).toMatchObject({ pending: null, lastError: 'Codex refused the prompt' });
  });

  it('files a render that settles before the queue call returns, and frees a failed enqueue', async () => {
    const { id } = await projectWithThumbnail();
    await mkdir(PATHS.images, { recursive: true });
    await writeFile(join(PATHS.images, 'fast-example.png'), 'png');
    // The hook fires while enqueue is still in flight: the reservation is already current.
    enqueue.mockImplementationOnce(async (job) => {
      await cover.onCoverArtImageSettled({ projectId: id, requestId: job.params.musicVideo.coverArt.requestId, filename: 'fast-example.png' });
      return { jobId: 'job-fast' };
    });
    const { project } = await cover.generateCoverArtSource(id);
    expect(project.publishKit.coverArt).toMatchObject({ pending: null, source: { kind: 'image', filename: 'fast-example.png' } });

    enqueue.mockRejectedValueOnce(new Error('Codex is signed out'));
    await expect(cover.generateCoverArtSource(id)).rejects.toThrow('Codex is signed out');
    const art = (await projects.getProject(id)).publishKit.coverArt;
    expect(art.pending).toBeNull();
    expect(art.lastError).toMatch(/Codex is signed out/);
  });

  it('lets the director ask again once a pending render is no longer in the queue', async () => {
    const { id } = await projectWithThumbnail();
    const first = (await cover.generateCoverArtSource(id)).project.publishKit.coverArt.pending;
    await expect(cover.generateCoverArtSource(id)).rejects.toMatchObject({ status: 409 });
    // A restart lost the job's terminal event: the queue no longer holds it live.
    jobStatus.mockResolvedValue('failed');
    const next = (await cover.generateCoverArtSource(id)).project.publishKit.coverArt.pending;
    expect(next.requestId).not.toBe(first.requestId);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('says so when no image backend is enabled', async () => {
    const { id } = await projectWithThumbnail();
    chooseRoute.mockResolvedValue(null);
    await expect(cover.generateCoverArtSource(id)).rejects.toMatchObject({ status: 409, code: 'COVER_ART_ROUTE_UNAVAILABLE' });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('cover lettering', () => {
  it('renders a store-size square JPEG from a wide still', async () => {
    const sharp = (await import('sharp')).default;
    const dir = join(PATHS.videoThumbnails, 'lettering');
    await mkdir(dir, { recursive: true });
    const source = join(dir, 'wide.png');
    await sharp({ create: { width: 640, height: 360, channels: 3, background: '#335577' } }).png().toFile(source);
    const out = join(dir, 'cover.jpg');
    await composeCoverArt({ source, out, title: 'Example Song', tag: 'Example Artist', size: 1000 });
    const meta = await sharp(out).metadata();
    expect(meta).toMatchObject({ format: 'jpeg', width: 1000, height: 1000 });

    // A portrait phone photo stored landscape with an EXIF rotation crops on the upright image.
    const rotated = join(dir, 'rotated.jpg');
    await sharp({ create: { width: 640, height: 360, channels: 3, background: '#775533' } }).jpeg().withMetadata({ orientation: 6 }).toFile(rotated);
    await composeCoverArt({ source: rotated, out, title: 'Example Song', focusX: 1, size: 1000 });
    expect(await sharp(out).metadata()).toMatchObject({ width: 1000, height: 1000 });
  });
});
