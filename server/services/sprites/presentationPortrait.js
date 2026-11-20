/**
 * Deterministic high-resolution presentation portrait derived from a sprite's
 * locked identity master. Runtime atlases optimize for gameplay cells; menus
 * should not upscale those cells when the immutable source art is available.
 */

import { readFile } from 'fs/promises';
import { ServerError } from '../../lib/errorHandler.js';
import { keyChannelSplit } from './chromaKey.js';
import { resolveSpriteAssetPath } from './paths.js';
import { loadManifest } from './reference.js';
import { resolveChromaKey } from './walk.js';
import { decodeTransparentSpriteSource, sha256Buffer } from './walkPostprocess.js';

export const PRESENTATION_PORTRAIT_SIZE = 512;

export async function buildPresentationPortrait(recordId, record) {
  const manifest = await loadManifest(recordId);
  const source = manifest?.mainReference;
  if (!source?.locked || !source.path) {
    throw new ServerError(
      'Lock the main reference before publishing a presentation portrait',
      { status: 422, code: 'PORTRAIT_REFERENCE_REQUIRED' },
    );
  }

  const sourceAbs = resolveSpriteAssetPath(recordId, source.path);
  const sourceBuffer = await readFile(sourceAbs).catch(() => null);
  if (!sourceBuffer) {
    throw new ServerError(
      'The locked main reference is missing on disk',
      { status: 422, code: 'PORTRAIT_REFERENCE_MISSING' },
    );
  }

  const chromaKey = resolveChromaKey({ manifest, record });
  const frame = await decodeTransparentSpriteSource(
    sourceBuffer,
    keyChannelSplit(chromaKey),
    chromaKey,
  );
  const { default: sharp } = await import('sharp');
  const portraitBuffer = await sharp(frame.data, {
    raw: { width: frame.width, height: frame.height, channels: 4 },
  })
    .resize(PRESENTATION_PORTRAIT_SIZE, PRESENTATION_PORTRAIT_SIZE, {
      fit: 'fill',
      kernel: sharp.kernel.nearest,
    })
    .png()
    .toBuffer();

  return {
    buffer: portraitBuffer,
    sha256: sha256Buffer(portraitBuffer),
    sourcePath: source.path,
    sourceSha256: sha256Buffer(sourceBuffer),
    size: PRESENTATION_PORTRAIT_SIZE,
  };
}
