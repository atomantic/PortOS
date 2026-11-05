import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setPhotorealTextureDepsForTests, installTexture, listInstalledTextures, searchTextures, stagePhotorealTextures } from './photorealTextures.js';

const JPEG = (tag) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(tag)]);
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const map = (id, name) => ({ '2k': { jpg: { url: `https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/${id}/${id}_${name}_2k.jpg`, md5: createHash('md5').update(JPEG(name)).digest('hex') } } });

const assets = {
  oak_planks: { name: 'Oak Planks', categories: ['floor', 'wood'], tags: ['plank', 'parquet'], download_count: 10 },
  pine_floor: { name: 'Pine Floor', categories: ['floor', 'wood'], tags: [], download_count: 50 },
  white_plaster: { name: 'White Plaster', categories: ['wall', 'plaster'], tags: ['painted'], download_count: 99 },
  'Bad Id': { name: 'Bad', categories: ['wood', 'floor'], tags: ['plank'] },
};

let root;
let fetch;
const routes = new Map();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'photoreal-textures-'));
  routes.clear();
  routes.set('https://api.polyhaven.com/assets?t=textures', () => json(assets));
  routes.set('https://api.polyhaven.com/files/oak_planks', () => json({ Diffuse: map('oak_planks', 'diff'), Rough: map('oak_planks', 'rough'), nor_gl: map('oak_planks', 'nor_gl'), nor_dx: map('oak_planks', 'nor_dx') }));
  routes.set('https://api.polyhaven.com/info/oak_planks', () => json({ name: 'Oak Planks', type: 1, dimensions: [2400, 2400] }));
  for (const name of ['diff', 'rough', 'nor_gl']) {
    routes.set(`https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/oak_planks/oak_planks_${name}_2k.jpg`, () => new Response(JPEG(name)));
  }
  fetch = vi.fn(async (url) => (routes.get(url) || (() => new Response('missing', { status: 404 })))());
  __setPhotorealTextureDepsForTests({ fetch, root: () => root });
});

afterEach(() => rm(root, { recursive: true, force: true }));

describe('CC0 photo textures', () => {
  it('finds a preset\'s textures by name, tags and categories, best match first', async () => {
    const results = await searchTextures({ preset: 'wood-floor' });
    expect(results.map((r) => r.id)).toEqual(['oak_planks', 'pine_floor']);
    expect(results[0]).toMatchObject({ name: 'Oak Planks', installed: false, thumbnail: expect.stringContaining('cdn.polyhaven.com') });
    expect((await searchTextures({ preset: 'wood-floor', query: 'pine' })).map((r) => r.id)).toEqual(['pine_floor']);
    // The catalog is fetched once and reused.
    await searchTextures({ preset: 'painted-wall' });
    expect(fetch.mock.calls.filter(([url]) => url.includes('/assets')).length).toBe(1);
  });

  it('downloads the 2K maps once on install and stages them for Blender with their real size', async () => {
    const installed = await installTexture('oak_planks');
    expect(installed).toMatchObject({ id: 'oak_planks', name: 'Oak Planks', sizeM: 2.4 });
    expect(await readFile(join(root, 'oak_planks', 'normal.jpg'))).toEqual(JPEG('nor_gl'));
    expect(JSON.parse(await readFile(join(root, 'oak_planks', 'texture.json'), 'utf8'))).toMatchObject({ license: 'CC0', maps: ['color', 'roughness', 'normal'] });
    const calls = fetch.mock.calls.length;
    await installTexture('oak_planks');
    expect(fetch.mock.calls.length).toBe(calls);
    expect((await listInstalledTextures()).map((t) => t.id)).toEqual(['oak_planks']);
    expect((await searchTextures({ preset: 'wood-floor' }))[0].installed).toBe(true);

    const staged = await stagePhotorealTextures({ 'wood-floor': 'oak_planks', tile: 'oak_planks', carpet: 'not_here' });
    expect(staged.files.map((f) => f.path)).toEqual(['textures/oak_planks/color.jpg', 'textures/oak_planks/roughness.jpg', 'textures/oak_planks/normal.jpg']);
    expect(staged.job['wood-floor']).toEqual({ id: 'oak_planks', sizeM: 2.4, maps: { color: 'textures/oak_planks/color.jpg', roughness: 'textures/oak_planks/roughness.jpg', normal: 'textures/oak_planks/normal.jpg' } });
    expect(staged.job.tile).toBe(staged.job['wood-floor']);
    expect(staged.missing).toEqual(['not_here']);
  });

  it('refuses a map from another host or one that is not a JPEG, and leaves nothing installed', async () => {
    routes.set('https://api.polyhaven.com/files/oak_planks', () => json({ Diffuse: { '2k': { jpg: { url: 'https://example.com/x.jpg' } } } }));
    await expect(installTexture('oak_planks')).rejects.toMatchObject({ code: 'PHOTOREAL_TEXTURE_HOST' });
    routes.set('https://api.polyhaven.com/files/oak_planks', () => json({ Diffuse: map('oak_planks', 'diff') }));
    routes.set('https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/oak_planks/oak_planks_diff_2k.jpg', () => new Response('<html>'));
    await expect(installTexture('oak_planks')).rejects.toMatchObject({ code: 'PHOTOREAL_TEXTURE_INVALID' });
    routes.set('https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/oak_planks/oak_planks_diff_2k.jpg', () => new Response(JPEG('tampered')));
    await expect(installTexture('oak_planks')).rejects.toMatchObject({ code: 'PHOTOREAL_TEXTURE_INVALID', message: expect.stringContaining('checksum') });
    await expect(installTexture('../etc')).rejects.toMatchObject({ code: 'PHOTOREAL_TEXTURE_ID' });
    expect(await listInstalledTextures()).toEqual([]);
  });
});
