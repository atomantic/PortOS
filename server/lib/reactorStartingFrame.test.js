import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareReactorStartingFrame, readImageSize } from './reactorStartingFrame.js';

let dir;
const writeImage = async (name, width, height) => {
  const path = join(dir, name);
  await sharp({ create: { width, height, channels: 3, background: '#204080' } }).png().toFile(path);
  return path;
};

beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'reactor-frame-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe('prepareReactorStartingFrame', () => {
  // The reported failure: a tall phone photo opened a 1344x768 session, so
  // reactor's own fit left almost nothing of it to animate.
  it('opens a portrait session for a portrait frame and crops it to that canvas', async () => {
    const source = await writeImage('portrait.png', 900, 1600);
    const out = join(dir, 'portrait-render.mp4');
    const frame = await prepareReactorStartingFrame(source, undefined, out);
    expect(frame.aspect).toBe('9:16');
    expect(frame.framePath).toBe(`${out}.start.png`);
    expect(frame.fittedPath).toBe(frame.framePath);
    await expect(readImageSize(frame.framePath)).resolves.toEqual({ width: 768, height: 1344 });
  });

  it('honours an explicitly requested canvas over the frame it was given', async () => {
    const source = await writeImage('explicit.png', 900, 1600);
    const out = join(dir, 'explicit-render.mp4');
    const frame = await prepareReactorStartingFrame(source, '1:1', out);
    expect(frame.aspect).toBe('1:1');
    await expect(readImageSize(frame.framePath)).resolves.toEqual({ width: 768, height: 768 });
  });

  // A re-encode of an already-correct frame is a lossy no-op plus a temp file
  // the caller then has to delete.
  it('uploads a frame that already matches the canvas untouched', async () => {
    const source = await writeImage('exact.png', 1344, 768);
    const frame = await prepareReactorStartingFrame(source, undefined, join(dir, 'exact-render.mp4'));
    expect(frame).toMatchObject({ aspect: '16:9', framePath: source, fittedPath: null });
  });

  // reactor decodes more container formats than sharp does, so failing to
  // MEASURE a frame must not fail a render reactor could have fitted itself.
  it('passes an unreadable frame through on the default canvas', async () => {
    const frame = await prepareReactorStartingFrame(join(dir, 'missing.heic'), undefined, join(dir, 'missing-render.mp4'));
    expect(frame).toMatchObject({ aspect: '16:9', framePath: join(dir, 'missing.heic'), fittedPath: null });
    expect(frame.canvas).toMatchObject({ width: 1344, height: 768 });
  });

  it('resolves a text render to the requested canvas with no frame at all', async () => {
    expect(await prepareReactorStartingFrame(null, '9:16', join(dir, 't.mp4')))
      .toMatchObject({ aspect: '9:16', framePath: null, fittedPath: null });
    expect(await prepareReactorStartingFrame(null, undefined, join(dir, 't.mp4')))
      .toMatchObject({ aspect: '16:9', framePath: null, fittedPath: null });
  });
});
