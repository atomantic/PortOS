/**
 * Single artwork (#10331) through the real project store and real sharp: the
 * default image backend is used (no mode passed), revisions keep earlier
 * versions, the composed cover is a 3000×3000 sRGB JPEG, and only an approved
 * composition reaches the DistroKid payload.
 */
import { describe, expect, it, vi, afterAll } from 'vitest';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-mv-single-art-'),
}));

const { PATHS } = await import('../../lib/paths.js');
const projects = await import('./projects.js');
const art = await import('./singleArtwork.js');
const { buildPublishPayload } = await import('./publish/payloads.js');

afterAll(() => cleanupTempDataRoots());

let n = 0;
// A stand-in backend: writes a real PNG to the gallery and records the params it was given.
function fakeImageGen() {
  const calls = [];
  return {
    calls,
    generateImage: async (params) => {
      calls.push(params);
      n += 1;
      const filename = `art-${n}.png`;
      await mkdir(PATHS.images, { recursive: true });
      await sharp({ create: { width: 64, height: 64, channels: 3, background: '#335577' } }).png().toFile(join(PATHS.images, filename));
      return { filename, path: `/data/images/${filename}` };
    },
  };
}

describe('single artwork', () => {
  it('proposes a style from the treatment and generates through the default backend', async () => {
    const created = await projects.createProject({ name: 'Example Song' });
    await projects.mutateProjectRecord(created.id, (c) => ({ project: { ...c, treatment: { brief: { graphicLanguage: 'cut-paper collage', emotion: 'wistful' } } } }));
    expect(art.presentSingleArtwork(await projects.getProject(created.id)).stylePrompt).toMatch(/cut-paper collage/);

    const imageGen = fakeImageGen();
    const { project } = await art.generateSingleArtwork(created.id, { count: 2 }, { imageGen });
    expect(imageGen.calls).toHaveLength(2);
    // No backend is hard-coded: the dispatcher's saved default decides.
    for (const call of imageGen.calls) {
      expect(call).not.toHaveProperty('mode');
      expect(call.musicVideo).toEqual({ projectId: created.id, singleArtwork: true });
    }
    expect(project.publishKit.singleArtwork.options).toHaveLength(2);
  });

  it('keeps earlier versions on adjust, composes 3000×3000 sRGB, and only an approved cover feeds DistroKid', async () => {
    const created = await projects.createProject({ name: 'Example Song' });
    const imageGen = fakeImageGen();
    let { project } = await art.generateSingleArtwork(created.id, { stylePrompt: 'neon harbor at dusk', count: 1 }, { imageGen });
    const first = project.publishKit.singleArtwork.options[0];
    ({ project } = await art.adjustSingleArtwork(created.id, first.id, 'warmer light', { imageGen }));
    const opts = project.publishKit.singleArtwork.options;
    expect(opts).toHaveLength(2);
    expect(opts[1]).toMatchObject({ kind: 'adjust', parentId: first.id });
    expect(imageGen.calls[1].prompt).toMatch(/neon harbor at dusk[\s\S]*warmer light/);

    const who = { artistName: 'Example Artist', songwriterFirst: 'Alex', songwriterLast: 'Example' };
    const withThumb = async () => projects.mutateProjectRecord(created.id, (c) => ({ project: { ...c, publishKit: { ...c.publishKit, thumbnail: 'thumb-1.jpg' } } }));
    await withThumb();
    // Fallback: no approval means the thumbnail, with a warning.
    expect(buildPublishPayload('distrokid', await projects.getProject(created.id), who)).toMatchObject({ cover: { name: 'thumb-1.jpg' }, warnings: [expect.stringMatching(/No single artwork is approved/)] });
    // Approving before composing is refused.
    await expect(art.approveSingleArtwork(created.id, opts[1].id)).rejects.toMatchObject({ status: 409 });

    ({ project } = await art.composeSingleArtwork(created.id, { optionId: opts[1].id, artist: 'Example Artist', type: { position: 'top' } }));
    const { composedPath } = project.publishKit.singleArtwork;
    const meta = await sharp(await readFile(join(PATHS.videoThumbnails, composedPath))).metadata();
    expect(meta).toMatchObject({ format: 'jpeg', width: 3000, height: 3000, space: 'srgb' });

    ({ project } = await art.approveSingleArtwork(created.id, opts[1].id));
    expect(buildPublishPayload('distrokid', project, who)).toMatchObject({ cover: { dir: 'videoThumbnails', name: composedPath, approved: true }, warnings: [] });

    // Re-composing invalidates the approval: the director approves what they last saw.
    ({ project } = await art.composeSingleArtwork(created.id, { optionId: opts[1].id }));
    expect(project.publishKit.singleArtwork.approvedImageId).toBeNull();
  });
});
