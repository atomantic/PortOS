import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  detectSolidBorderColor,
  hasMeaningfulAlpha,
  keySolidBackground,
  prepareSourceImage,
} from './sourceKeying.js';

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
    expect(result).toBe(targetPath);

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
});
