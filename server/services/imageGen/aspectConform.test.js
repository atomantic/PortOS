import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { conformImageAspect } from './aspectConform.js';

// The crop over the shapes Codex actually returned for 16:9 production stills:
// pins the tolerance boundary (its own 1672x941 must pass byte-for-byte) and
// both crop directions. The provider wiring + sidecar is covered in codex.test.js.
describe('conformImageAspect', () => {
  let dir;
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'aspect-conform-')); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  const frame = async (name, width, height) => {
    const path = join(dir, name);
    await writeFile(path, await sharp({ create: { width, height, channels: 3, background: { r: 90, g: 60, b: 30 } } }).png().toBuffer());
    return path;
  };

  it.each([
    ['square close-up crops height', [1254, 1254, 1920, 1080], { from: '1254x1254', to: '1254x705' }],
    ['near-4:3 crops height', [1448, 1086, 1920, 1080], { from: '1448x1086', to: '1448x815' }],
    ['3:2 crops height', [1536, 1024, 1920, 1080], { from: '1536x1024', to: '1536x864' }],
    ['too-wide frame crops width', [2000, 800, 1920, 1080], { from: '2000x800', to: '1422x800' }],
    ['portrait request from a landscape frame', [1536, 1024, 1024, 1536], { from: '1536x1024', to: '683x1024' }],
  ])('%s', async (label, [sw, sh, tw, th], expected) => {
    const path = await frame(`${label}.png`, sw, sh);
    expect(await conformImageAspect(path, tw, th)).toEqual(expected);
    const [w, h] = expected.to.split('x').map(Number);
    expect(await sharp(path).metadata()).toMatchObject({ width: w, height: h });
  });

  it.each([
    ['Codex 16:9 within tolerance', [1672, 941], [1920, 1080]],
    ['no requested size', [1254, 1254], [null, null]],
  ])('leaves %s untouched', async (label, [sw, sh], [tw, th]) => {
    const path = await frame(`${label}.png`, sw, sh);
    const before = await readFile(path);
    expect(await conformImageAspect(path, tw, th)).toBeNull();
    expect(Buffer.compare(await readFile(path), before)).toBe(0);
  });
});
