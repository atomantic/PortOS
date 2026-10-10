/**
 * Film-look bake — a gallery still viewed through a film look, saved as a new
 * copy beside the original (the original is never changed).
 *
 * The bake renders the SAME SVG filter the live preview and the final render
 * use (lib/filmLook.js), in the sandboxed composition browser: a one-file page
 * sized to the image, the image filtered on its root, one screenshot. So what
 * the editor shows on a phone is what lands in the gallery, at the image's own
 * resolution.
 *
 * The copy is a variant of its source (`cleanedFrom` = the group root, like a
 * clean or a watermark removal), so the lightbox offers an Original / Film look
 * toggle and the copy files into every collection the source is in.
 */

import { copyFile, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { extname, join } from 'node:path';
import { randomUUID } from 'crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS } from '../../lib/fileUtils.js';
import { describeFilmLook, filmLookFilterMarkup, isFilmLookNeutral, normalizeFilmLook } from '../../lib/filmLook.js';
import { persistVariant } from './variants.js';

export const FILM_LOOK_SCRATCH_DIR = 'film-look-bakes';
// The composition browser screenshots the whole viewport in one frame; past
// this a 4K-plus still would stall it rather than finish.
export const FILM_LOOK_BAKE_MAX_SIDE = 4096;
const SOURCE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/** The one-image page a bake screenshots: the image at its own size, the look on it, frame 0. Pure. */
function filmLookBakePage(look, { width, height, src }) {
  const built = filmLookFilterMarkup(normalizeFilmLook(look), { frame: 0, width, height });
  return `<!doctype html><html><head><meta charset="utf-8"><title>Film look</title>
<style>html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:#000}img{display:block;width:${width}px;height:${height}px;filter:${built.active ? built.css : 'none'}}</style>
</head><body>${built.svg}<img src="${src}" alt=""></body></html>\n`;
}

/**
 * Bake `look` into a new copy of gallery image `filename`; resolves the
 * gallery-compatible record of the copy (persistVariant's shape).
 */
export async function applyFilmLookBake({ filename, sourceMeta, look: input, signal }) {
  const look = normalizeFilmLook(input);
  if (!look || isFilmLookNeutral(look)) throw new ServerError('The film look has no effect; move a control before saving a copy', { status: 422, code: 'FILM_LOOK_NEUTRAL' });
  const ext = extname(filename).toLowerCase();
  if (!SOURCE_EXT.has(ext)) throw new ServerError('Only PNG, JPEG and WebP images take a film look', { status: 422, code: 'FILM_LOOK_SOURCE_TYPE' });
  const sourcePath = join(PATHS.images, filename);
  const buffer = await readFile(sourcePath).catch((err) => {
    if (err.code === 'ENOENT') throw new ServerError('Image not found', { status: 404, code: 'NOT_FOUND' });
    throw err;
  });
  const { default: sharp } = await import('sharp');
  const meta = await sharp(buffer).metadata().catch(() => null);
  const width = meta?.width;
  const height = meta?.height;
  if (!(width > 0 && height > 0)) throw new ServerError('Invalid or corrupt image', { status: 400, code: 'INVALID_IMAGE' });
  if (Math.max(width, height) > FILM_LOOK_BAKE_MAX_SIDE) {
    throw new ServerError(`The image is larger than ${FILM_LOOK_BAKE_MAX_SIDE}px on a side; downscale it before applying a film look`, { status: 422, code: 'FILM_LOOK_TOO_LARGE' });
  }

  const { openComposition } = await import('../htmlComposition/browser.js');
  const id = randomUUID();
  const scratch = join(PATHS.data, FILM_LOOK_SCRATCH_DIR, id);
  let page;
  let png;
  try {
    await mkdir(scratch, { recursive: true });
    const src = `source${ext}`;
    await copyFile(sourcePath, join(scratch, src));
    await writeFile(join(scratch, 'index.html'), filmLookBakePage(look, { width, height, src }));
    page = await openComposition(`${FILM_LOOK_SCRATCH_DIR}/${id}`, { signal, ownedBrowser: true });
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    // The resize relays out the page; the screenshot waits for the paint after it.
    await page.evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    page.check();
    ({ data: png } = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }));
    page.check();
    await page.close({ verify: true });
    page = null;
  } finally {
    if (page) await page.close().catch(() => {});
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
  const data = Buffer.from(png, 'base64');

  const base = filename.slice(0, -ext.length);
  const outFilename = `${base}_look-${look.preset}-${id.slice(0, 8)}.png`;
  // Anchor the copy at the group root so a look on a cleaned copy still toggles against the original.
  const groupRoot = typeof sourceMeta.cleanedFrom === 'string' && sourceMeta.cleanedFrom ? sourceMeta.cleanedFrom : filename;
  const createdAt = new Date().toISOString();
  // Drop the fields that would mislabel the copy (the lightbox reads them before the film-look lineage) and the
  // identity fields listGallery would otherwise spread over the copy's own.
  const {
    hidden: _hidden, filename: _srcFilename, id: _srcId,
    regenerated: _regenerated, regenStrength: _regenStrength, regenSteps: _regenSteps, regenModelId: _regenModelId,
    regenPixelDeltaPct: _regenPixelDeltaPct, regenPsnr: _regenPsnr, regenMethod: _regenMethod,
    watermarkRemoved: _watermarkRemoved, watermarkRegion: _watermarkRegion, cleanLevel: _cleanLevel, c2paStripped: _c2paStripped,
    ...sourceMetaForVariant
  } = sourceMeta;
  const lineage = { createdAt, cleanedFrom: groupRoot, filmLookFrom: filename, filmLook: look, filmLookWords: describeFilmLook(look) };
  return persistVariant({
    sourceFilename: filename,
    outFilename,
    data,
    variantMeta: { ...sourceMetaForVariant, ...lineage },
    width,
    height,
    sizeBefore: buffer.length,
    sizeAfter: data.length,
    logLine: `🎞️ Film look ${look.preset} ${filename} → ${outFilename} (${width}×${height})`,
    extraFields: lineage,
  });
}
