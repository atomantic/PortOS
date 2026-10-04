/**
 * Gallery sidecar edits (#10039): prompt and visibility updates are whole-file
 * read→modify→write cycles, so overlapping calls on one image must serialize
 * or the later write restores the earlier call's stale copy.
 *
 * The first sidecar write is held open (gate) so the second call is in flight
 * while it is pending — unserialized, both read the same original copy.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { makePathsProxy } from '../../lib/mockPathsDataRoot.js';

let imagesDir;
let writeGate = null; // () => Promise — awaited before the next sidecar write lands
let failNextWrite = false;
vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  const proxy = makePathsProxy(actual, {
    dataRoot: () => imagesDir,
    extraOverrides: () => ({ images: imagesDir }),
  });
  return new Proxy(proxy, {
    get(target, prop) {
      if (prop === 'atomicWrite') {
        return async (path, data, ...rest) => {
          if (String(path).endsWith('.metadata.json')) {
            const gate = writeGate;
            writeGate = null;
            if (gate) await gate();
            if (failNextWrite) { failNextWrite = false; throw new Error('disk full'); }
          }
          return actual.atomicWrite(path, data, ...rest);
        };
      }
      return target[prop];
    },
  });
});

vi.mock('../../lib/pythonSetup.js', () => ({
  resolveFlux2Python: () => null,
  FLUX2_VENV_DEFAULT: '/fake/home/.portos/venv-flux2/bin/python3',
}));

const indexed = [];
vi.mock('../mediaAssetIndex/index.js', () => ({
  indexImage: vi.fn(async ({ filename }) => {
    indexed.push(JSON.parse(readFileSync(join(imagesDir, filename.replace('.png', '.metadata.json')), 'utf8')));
  }),
  unindexImage: vi.fn(async () => {}),
}));

let tmpRoot;
let setImageHidden;
let updateImagePrompt;

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'portos-gallery-sidecar-test-'));
  imagesDir = join(tmpRoot, 'images');
  process.env.PORTOS_MEDIA_MODELS_FILE = join(tmpRoot, 'media-models.json');
  vi.resetModules();
  ({ setImageHidden, updateImagePrompt } = await import('./local.js'));
});

afterAll(() => {
  delete process.env.PORTOS_MEDIA_MODELS_FILE;
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  writeGate = null;
  failNextWrite = false;
  indexed.length = 0;
  rmSync(imagesDir, { recursive: true, force: true });
  mkdirSync(imagesDir, { recursive: true });
});

const sidecar = (f) => join(imagesDir, f.replace('.png', '.metadata.json'));
const seed = (f) => writeFileSync(sidecar(f), JSON.stringify({ prompt: 'before', hidden: false }));
const read = (f) => JSON.parse(readFileSync(sidecar(f), 'utf8'));

describe('gallery sidecar edits', () => {
  it('keeps both the prompt and visibility edit when they overlap', async () => {
    seed('a.png');
    let release;
    writeGate = () => new Promise((r) => { release = r; });
    const prompt = updateImagePrompt('a.png', 'after');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const hidden = setImageHidden('a.png', true);
    await new Promise((r) => setTimeout(r, 20));
    release();
    await Promise.all([prompt, hidden]);

    expect(read('a.png')).toEqual({ prompt: 'after', hidden: true });
    expect(indexed.at(-1)).toEqual({ prompt: 'after', hidden: true });
  });

  it('lets a later edit succeed after a write failed', async () => {
    seed('b.png');
    failNextWrite = true;
    await expect(setImageHidden('b.png', true)).rejects.toThrow('disk full');
    await expect(updateImagePrompt('b.png', 'later')).resolves.toEqual({ filename: 'b.png', prompt: 'later' });
    expect(read('b.png')).toEqual({ prompt: 'later', hidden: false });
  });

  it('does not make different images wait on each other', async () => {
    seed('c.png');
    seed('d.png');
    let release;
    writeGate = () => new Promise((r) => { release = r; });
    const held = setImageHidden('c.png', true);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await updateImagePrompt('d.png', 'free');
    expect(read('d.png').prompt).toBe('free');
    release();
    await held;
  });
});
