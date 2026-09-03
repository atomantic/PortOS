import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  detectSolidBorderColor,
  hasMeaningfulAlpha,
  keySolidBackground,
  KEYING_CACHE_VERSION,
  prepareSourceImage,
  subjectFrameLayout,
} from './sourceKeying.js';
import { sha256File } from '../../lib/fileUtils.js';

// Build a raw RGBA buffer from a painter function (x, y) => [r, g, b, a?].
const makeImage = (width, height, paint) => {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a = 255] = paint(x, y);
      const i = (y * width + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
    }
  }
  return { data, width, height };
};

const GREEN = [30, 200, 40];
const BROWN = [140, 90, 50];

// A 20×20 "subject on green screen": a 10×10 brown block centered on flat green.
const subjectOnGreen = () => makeImage(20, 20, (x, y) => (
  x >= 5 && x < 15 && y >= 5 && y < 15 ? BROWN : GREEN
));

// A 20×20 image with no dominant border color (photo-like busy background).
const noisyImage = () => makeImage(20, 20, (x, y) => [
  (x * 37 + y * 91) % 256, (x * 13 + y * 7) % 256, (x * 71 + y * 3) % 256,
]);

const alphaAt = (image, x, y) => image.data[(y * image.width + x) * 4 + 3];

describe('detectSolidBorderColor', () => {
  it('detects a flat border color', () => {
    expect(detectSolidBorderColor(subjectOnGreen())).toEqual(GREEN);
  });

  it('returns null for a busy border', () => {
    expect(detectSolidBorderColor(noisyImage())).toBeNull();
  });

  it('tolerates minor border noise within the match tolerance', () => {
    const slightlyNoisy = makeImage(20, 20, (x, y) => (
      x >= 5 && x < 15 && y >= 5 && y < 15
        ? BROWN
        : [GREEN[0] + ((x + y) % 5), GREEN[1] - ((x * y) % 5), GREEN[2]]
    ));
    const color = detectSolidBorderColor(slightlyNoisy);
    expect(color).not.toBeNull();
  });
});

describe('keySolidBackground', () => {
  it('keys the background transparent and leaves the subject opaque', () => {
    const result = keySolidBackground(subjectOnGreen());
    expect(result).not.toBeNull();
    const keyed = { data: result.data, width: 20, height: 20 };
    expect(alphaAt(keyed, 0, 0)).toBe(0); // background corner
    expect(alphaAt(keyed, 10, 10)).toBe(255); // subject center
    expect(alphaAt(keyed, 6, 6)).toBe(255); // subject interior near the edge
  });

  it('floods through a dirty outer row using the shared border-band seeds', () => {
    const dirtyEdge = makeImage(20, 20, (x, y) => (
      y === 0 ? [255, 0, 0] : (x >= 5 && x < 15 && y >= 5 && y < 15 ? BROWN : GREEN)
    ));
    const result = keySolidBackground(dirtyEdge);
    expect(result).not.toBeNull();
    const keyed = { data: result.data, width: 20, height: 20 };
    expect(alphaAt(keyed, 0, 1)).toBe(0);
    expect(alphaAt(keyed, 0, 0)).toBe(255); // non-background edge artifact is preserved
  });

  it('keys enclosed background pockets the flood fill cannot reach', () => {
    // A brown ring with a green hole in the middle — unreachable from the border.
    const ring = makeImage(20, 20, (x, y) => {
      const inRing = x >= 4 && x < 16 && y >= 4 && y < 16;
      const inHole = x >= 8 && x < 12 && y >= 8 && y < 12;
      if (inHole) return GREEN;
      if (inRing) return BROWN;
      return GREEN;
    });
    const result = keySolidBackground(ring);
    expect(result).not.toBeNull();
    const keyed = { data: result.data, width: 20, height: 20 };
    expect(alphaAt(keyed, 10, 10)).toBe(0); // the enclosed pocket
    expect(alphaAt(keyed, 5, 10)).toBe(255); // the ring itself
  });

  it('returns null when the whole image is background (nothing to keep)', () => {
    expect(keySolidBackground(makeImage(20, 20, () => GREEN))).toBeNull();
  });

  it('returns null when there is no solid background to key', () => {
    expect(keySolidBackground(noisyImage())).toBeNull();
  });
});

describe('hasMeaningfulAlpha', () => {
  it('distinguishes an all-opaque alpha channel from a real one', () => {
    expect(hasMeaningfulAlpha(subjectOnGreen().data)).toBe(false);
    const withAlpha = makeImage(4, 4, (x) => [0, 0, 0, x === 0 ? 0 : 255]);
    expect(hasMeaningfulAlpha(withAlpha.data)).toBe(true);
  });
});

describe('prepareSourceImage', () => {
  let dir;
  const tempDir = async () => {
    dir = dir || await mkdtemp(join(tmpdir(), 'portos-keying-'));
    return dir;
  };
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  const writePng = async (name, image) => {
    const path = join(await tempDir(), name);
    await sharp(Buffer.from(image.data), {
      raw: { width: image.width, height: image.height, channels: 4 },
    }).png().toFile(path);
    return path;
  };

  it('returns null for a transparent source — the pipeline uses real alpha directly', async () => {
    const withAlpha = makeImage(20, 20, (x, y) => (
      x >= 5 && x < 15 && y >= 5 && y < 15 ? [...BROWN, 255] : [0, 0, 0, 0]
    ));
    const sourcePath = await writePng('transparent.png', withAlpha);
    const result = await prepareSourceImage({ sourcePath, targetPath: join(await tempDir(), 'never.png') });
    expect(result).toBeNull();
  });

  it('keys a solid-background source into the target path and returns it', async () => {
    const sourcePath = await writePng('green.png', subjectOnGreen());
    const targetPath = join(await tempDir(), 'keyed.png');
    const result = await prepareSourceImage({ sourcePath, targetPath });
    expect(result).toEqual({ path: targetPath, keyed: true, framed: false });

    const { data, info } = await sharp(targetPath).ensureAlpha().raw()
      .toBuffer({ resolveWithObject: true });
    const keyed = { data, width: info.width, height: info.height };
    expect(alphaAt(keyed, 0, 0)).toBe(0);
    expect(alphaAt(keyed, 10, 10)).toBe(255);
  });

  it('returns null for a busy-background source — the pipeline’s own matting applies', async () => {
    const noisy = noisyImage();
    const sourcePath = await writePng('noisy.png', noisy);
    const result = await prepareSourceImage({ sourcePath, targetPath: join(await tempDir(), 'never2.png') });
    expect(result).toBeNull();
  });

  it('returns null for a source over the pixel cap without decoding it', async () => {
    // Just over KEY_MAX_PIXELS (16 MP): 4020×4000. Solid color, so the PNG
    // itself is tiny — only the header is read before the cap bails.
    const sourcePath = join(await tempDir(), 'huge.png');
    await sharp({
      create: { width: 4020, height: 4000, channels: 4, background: { r: 30, g: 200, b: 40, alpha: 1 } },
    }).png().toFile(sourcePath);
    const result = await prepareSourceImage({ sourcePath, targetPath: join(await tempDir(), 'never3.png') });
    expect(result).toBeNull();
  });

  it('reuses a keyed target newer than the gallery source', async () => {
    const sourcePath = await writePng('cache-source.png', subjectOnGreen());
    const cachedTarget = await writePng('cache-target.png', makeImage(20, 20, () => [255, 0, 0, 255]));
    const sourceSha256 = await sha256File(sourcePath);
    await writeFile(`${cachedTarget}.meta.json`, JSON.stringify({
      version: KEYING_CACHE_VERSION,
      sourceSha256,
      keyBackground: true,
      subjectScale: 1,
      keyed: true,
      framed: false,
    }));
    const fresh = new Date(Date.now() + 60_000);
    await utimes(cachedTarget, fresh, fresh);

    const result = await prepareSourceImage({ sourcePath, targetPath: cachedTarget });
    expect(result).toEqual({ path: cachedTarget, keyed: true, framed: false });
    const { data } = await sharp(cachedTarget).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect([...data.slice(0, 4)]).toEqual([255, 0, 0, 255]);
  });

  it('rekeys when source bytes change despite an older source mtime', async () => {
    const sourcePath = await writePng('fingerprint-source.png', subjectOnGreen());
    const cachedTarget = await writePng('fingerprint-target.png', makeImage(20, 20, () => [255, 0, 0, 255]));
    await writeFile(`${cachedTarget}.meta.json`, JSON.stringify({
      version: KEYING_CACHE_VERSION,
      sourceSha256: await sha256File(sourcePath),
      keyBackground: true,
      subjectScale: 1,
      keyed: true,
      framed: false,
    }));
    const targetTime = new Date(Date.now() + 60_000);
    await utimes(cachedTarget, targetTime, targetTime);

    await writePng('fingerprint-source.png', makeImage(20, 20, (x, y) => (
      x >= 6 && x < 14 && y >= 6 && y < 14 ? [90, 80, 200] : GREEN
    )));
    const oldSourceTime = new Date(Date.now() - 60_000);
    await utimes(sourcePath, oldSourceTime, oldSourceTime);

    const result = await prepareSourceImage({ sourcePath, targetPath: cachedTarget });
    expect(result).toEqual({ path: cachedTarget, keyed: true, framed: false });
    const { data } = await sharp(cachedTarget).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(alphaAt({ data, width: 20, height: 20 }, 0, 0)).toBe(0);
    expect(JSON.parse(await readFile(`${cachedTarget}.meta.json`, 'utf8')).sourceSha256)
      .toBe(await sha256File(sourcePath));
  });

  it('recomputes a fresh target when its keying-version metadata is stale', async () => {
    const sourcePath = await writePng('version-source.png', subjectOnGreen());
    const targetPath = await writePng('version-target.png', makeImage(20, 20, () => [255, 0, 0, 255]));
    await writeFile(`${targetPath}.meta.json`, JSON.stringify({ version: 'source-keying-old' }));
    const fresh = new Date(Date.now() + 60_000);
    await utimes(targetPath, fresh, fresh);

    const result = await prepareSourceImage({ sourcePath, targetPath });
    expect(result).toEqual({ path: targetPath, keyed: true, framed: false });
    const { data } = await sharp(targetPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(alphaAt({ data, width: 20, height: 20 }, 0, 0)).toBe(0);
    expect(JSON.parse(await readFile(`${targetPath}.meta.json`, 'utf8'))).toEqual({
      version: KEYING_CACHE_VERSION,
      sourceSha256: await sha256File(sourcePath),
      keyBackground: true,
      subjectScale: 1,
      keyed: true,
      framed: false,
    });
  });
});

describe('subjectFrameLayout', () => {
  // The margin is the whole product outcome: a subject at 65% of a square canvas
  // leaves ~17.5% of the canvas empty beyond each of its extremities, which is the
  // context the decoder needs to resolve a fingertip instead of clipping it.
  it('centers a landscape source on a canvas of its longest side', () => {
    expect(subjectFrameLayout({ width: 100, height: 50, subjectScale: 0.6 })).toEqual({
      canvasSize: 100, innerWidth: 60, innerHeight: 30, left: 20, top: 35,
    });
  });

  it('centers a portrait source with the same margins, transposed', () => {
    expect(subjectFrameLayout({ width: 50, height: 100, subjectScale: 0.6 })).toEqual({
      canvasSize: 100, innerWidth: 30, innerHeight: 60, left: 35, top: 20,
    });
  });

  it('never upsamples — the canvas is the source’s longest side, not a fixed size', () => {
    const { canvasSize, innerWidth } = subjectFrameLayout({ width: 37, height: 12, subjectScale: 1 });
    expect(canvasSize).toBe(37);
    expect(innerWidth).toBe(37);
  });

  it('floors both dimensions at 1px so a thin source can’t produce an invalid resize', () => {
    // 4 x 0.05 rounds to 0, which sharp rejects outright.
    expect(subjectFrameLayout({ width: 400, height: 4, subjectScale: 0.05 }))
      .toMatchObject({ innerWidth: 20, innerHeight: 1 });
  });
});

describe('prepareSourceImage subject framing', () => {
  let dir;
  const tempDir = async () => {
    dir = dir || await mkdtemp(join(tmpdir(), 'portos-framing-'));
    return dir;
  };
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  const writePng = async (name, image) => {
    const path = join(await tempDir(), name);
    await sharp(Buffer.from(image.data), {
      raw: { width: image.width, height: image.height, channels: 4 },
    }).png().toFile(path);
    return path;
  };

  const readRgba = async (path) => {
    const { data, info } = await sharp(path).ensureAlpha().raw()
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  };

  const pixelAt = (image, x, y) => {
    const i = (y * image.width + x) * 4;
    return [image.data[i], image.data[i + 1], image.data[i + 2], image.data[i + 3]];
  };

  // A 40x20 landscape photo-like source: no alpha, and a busy border so keying
  // would decline it even if it were asked for.
  const landscapePhoto = () => makeImage(40, 20, (x, y) => [
    (x * 37 + y * 91) % 256, (x * 13 + y * 7) % 256, (x * 71 + y * 3) % 256,
  ]);

  it('is a pass-through at the default scale with keying off — the original is used', async () => {
    // The strongest form of "byte-identical": nothing is written at all, so the
    // render consumes the untouched gallery file.
    const sourcePath = await writePng('identity.png', landscapePhoto());
    const targetPath = join(await tempDir(), 'identity-out.png');
    expect(await prepareSourceImage({
      sourcePath, targetPath, keyBackground: false, subjectScale: 1,
    })).toBeNull();
    await expect(readFile(targetPath)).rejects.toThrow();
  });

  it.each([0, 1.5, -0.2, NaN, '0.5', null])(
    'treats the out-of-range scale %s as the identity rather than framing on it',
    async (bad) => {
      const sourcePath = await writePng(`bad-${String(bad)}.png`, landscapePhoto());
      expect(await prepareSourceImage({
        sourcePath,
        targetPath: join(await tempDir(), `bad-${String(bad)}-out.png`),
        keyBackground: false,
        subjectScale: bad,
      })).toBeNull();
    },
  );

  it('frames an opaque source on a square canvas without keying it', async () => {
    const sourcePath = await writePng('frame-opaque.png', landscapePhoto());
    const targetPath = join(await tempDir(), 'frame-opaque-out.png');
    const result = await prepareSourceImage({
      sourcePath, targetPath, keyBackground: false, subjectScale: 0.5,
    });
    expect(result).toEqual({ path: targetPath, keyed: false, framed: true });

    const framed = await readRgba(targetPath);
    // Canvas = the source's longest side (40), subject 20x10 centered at (10, 15).
    expect([framed.width, framed.height]).toEqual([40, 40]);
    // An opaque source must stay opaque: a transparent pad would read to TRELLIS.2
    // as "already matted" and silently disable its own background removal.
    expect(pixelAt(framed, 0, 0)[3]).toBe(255);
    expect(pixelAt(framed, 20, 20)[3]).toBe(255);
    // The margin is real: the corners are pad, not subject.
    expect(pixelAt(framed, 1, 1).slice(0, 3)).toEqual([255, 255, 255]);
  });

  it('pads with the source’s own solid border color, so the margin is invisible', async () => {
    const sourcePath = await writePng('frame-green.png', subjectOnGreen());
    const targetPath = join(await tempDir(), 'frame-green-out.png');
    const result = await prepareSourceImage({
      sourcePath, targetPath, keyBackground: false, subjectScale: 0.5,
    });
    expect(result).toEqual({ path: targetPath, keyed: false, framed: true });
    const framed = await readRgba(targetPath);
    expect(pixelAt(framed, 0, 0)).toEqual([...GREEN, 255]);
  });

  it('preserves alpha for an alpha-bearing source and pads transparent', async () => {
    // A transparent source is already matted, so keying declines it — but framing
    // still applies, and the pad MUST stay transparent or the matte is undone.
    const withAlpha = makeImage(20, 20, (x, y) => (
      x >= 5 && x < 15 && y >= 5 && y < 15 ? [...BROWN, 255] : [0, 0, 0, 0]
    ));
    const sourcePath = await writePng('frame-alpha.png', withAlpha);
    const targetPath = join(await tempDir(), 'frame-alpha-out.png');
    const result = await prepareSourceImage({
      sourcePath, targetPath, keyBackground: true, subjectScale: 0.5,
    });
    expect(result).toEqual({ path: targetPath, keyed: false, framed: true });

    const framed = await readRgba(targetPath);
    expect([framed.width, framed.height]).toEqual([20, 20]);
    expect(pixelAt(framed, 0, 0)[3]).toBe(0);
    // Subject center: the 10x10 block resized to 5x5 and centered at (5, 5). Near-
    // rather than fully-opaque because a 2x downscale of a hard alpha edge on a
    // 5px block resamples some of the transparent surround into it — the contrast
    // that matters is against the fully-transparent pad above.
    expect(pixelAt(framed, 10, 10)[3]).toBeGreaterThan(200);
  });

  it('keys first and frames second, so the flood fill still samples the real border', async () => {
    // Order is not interchangeable: framing first would move the border pixels the
    // keyer measures, and its "is this background solid" gate would be reading the
    // pad color instead of the image's.
    const sourcePath = await writePng('key-then-frame.png', subjectOnGreen());
    const targetPath = join(await tempDir(), 'key-then-frame-out.png');
    const result = await prepareSourceImage({
      sourcePath, targetPath, keyBackground: true, subjectScale: 0.5,
    });
    expect(result).toEqual({ path: targetPath, keyed: true, framed: true });

    const framed = await readRgba(targetPath);
    // Keyed → the pad joins the keyed background as transparent, subject stays opaque.
    expect(pixelAt(framed, 0, 0)[3]).toBe(0);
    expect(pixelAt(framed, 10, 10)[3]).toBeGreaterThan(200);
  });

  it('measures an EXIF-rotated source after transposition', async () => {
    // Stored 40x20 (left half red, right half blue) with orientation 6 — a 90° CW
    // display rotation, so the viewer sees 20x40 with red on TOP. Framing on the
    // STORED dimensions would put the subject in a landscape band and leave the
    // sampled points below on empty pad, and the PNG written here carries no
    // orientation tag of its own to fix it downstream.
    const sourcePath = join(await tempDir(), 'exif.jpg');
    await sharp(Buffer.from(makeImage(40, 20, (x) => (x < 20 ? [220, 20, 20] : [20, 20, 220])).data), {
      raw: { width: 40, height: 20, channels: 4 },
    }).withMetadata({ orientation: 6 }).jpeg({ quality: 100 }).toFile(sourcePath);

    const targetPath = join(await tempDir(), 'exif-out.png');
    const result = await prepareSourceImage({
      sourcePath, targetPath, keyBackground: false, subjectScale: 0.5,
    });
    expect(result).toEqual({ path: targetPath, keyed: false, framed: true });

    const framed = await readRgba(targetPath);
    expect([framed.width, framed.height]).toEqual([40, 40]);
    // Subject 10x20 centered at (15, 10): red in its top half, blue in its bottom.
    const [topR, , topB] = pixelAt(framed, 20, 13);
    const [botR, , botB] = pixelAt(framed, 20, 27);
    expect(topR).toBeGreaterThan(topB);
    expect(botB).toBeGreaterThan(botR);
  });

  it('re-frames rather than reusing the cache when the scale changes', async () => {
    // KEYING_CACHE_VERSION alone cannot carry a PER-RUN parameter, so the framing
    // request is part of the cache identity in the metadata. Without this a
    // re-render at a new scale silently serves the previously prepared image.
    const sourcePath = await writePng('cache-scale.png', landscapePhoto());
    const targetPath = join(await tempDir(), 'cache-scale-out.png');

    await prepareSourceImage({ sourcePath, targetPath, keyBackground: false, subjectScale: 0.5 });
    const first = await readFile(targetPath);
    expect(JSON.parse(await readFile(`${targetPath}.meta.json`, 'utf8'))).toMatchObject({
      version: KEYING_CACHE_VERSION, keyBackground: false, subjectScale: 0.5, framed: true,
    });

    await prepareSourceImage({ sourcePath, targetPath, keyBackground: false, subjectScale: 0.8 });
    expect(await readFile(targetPath)).not.toEqual(first);
    expect(JSON.parse(await readFile(`${targetPath}.meta.json`, 'utf8')))
      .toMatchObject({ subjectScale: 0.8 });

    // And the SAME request is still served from cache — the identity check must not
    // have degenerated into "always recompute".
    const fresh = new Date(Date.now() + 60_000);
    await utimes(targetPath, fresh, fresh);
    const cached = await readFile(targetPath);
    await prepareSourceImage({ sourcePath, targetPath, keyBackground: false, subjectScale: 0.8 });
    expect(await readFile(targetPath)).toEqual(cached);
  });
});
