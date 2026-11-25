/** Deterministic, non-destructive optical and print lettering for shot images. */

import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { readFile, stat, utimes } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { atomicWrite, ensureDir } from '../../lib/fileCore.js';
import { PATHS } from '../../lib/paths.js';
import { resolveGalleryImage } from '../../lib/pathSafety.js';
import { ServerError } from '../../lib/errorHandler.js';
import { imageTreatmentDateText, shotImageTreatment } from '../../lib/musicVideo/musicVideoImageTreatments.js';

const PIXEL_LIMIT = 40_000_000;
const RENDERER_VERSION = 2;
const PAPER = '#faf8f1';
const ASPECTS = { '16:9': [16, 9], '9:16': [9, 16], '1:1': [1, 1] };
const TREATED_FRAME_MAX_EDGE = 4096;
const DIGITS = ['abcdef', 'bc', 'abdeg', 'abcdg', 'bcfg', 'acdfg', 'acdefg', 'abc', 'abcdefg', 'abcdfg'];
const SEGMENTS = { a: 'M1.5 1h3', b: 'M5 1.6v2', c: 'M5 4.5v2', d: 'M1.5 7h3', e: 'M1 4.5v2', f: 'M1 1.6v2', g: 'M1.5 4h3' };

// A fixed type-wheel inspired face, encoded as five columns by seven rows.
// No font is borrowed from the editor/browser or loaded from the host.
const BLOCKS = {
  0: [14,17,19,21,25,17,14], 1: [4,12,4,4,4,4,14], 2: [14,17,1,2,4,8,31],
  3: [30,1,1,14,1,1,30], 4: [2,6,10,18,31,2,2], 5: [31,16,16,30,1,1,30],
  6: [14,16,16,30,17,17,14], 7: [31,1,2,4,8,8,8], 8: [14,17,17,14,17,17,14], 9: [14,17,17,15,1,1,14],
  A: [14,17,17,31,17,17,17], B: [30,17,17,30,17,17,30], C: [14,17,16,16,16,17,14],
  D: [30,17,17,17,17,17,30], E: [31,16,16,30,16,16,31], F: [31,16,16,30,16,16,16],
  G: [14,17,16,23,17,17,14], J: [7,2,2,2,18,18,12], L: [16,16,16,16,16,16,31],
  M: [17,27,21,21,17,17,17], N: [17,25,25,21,19,19,17], O: [14,17,17,17,17,17,14],
  P: [30,17,17,30,16,16,16], R: [30,17,17,30,20,18,17], S: [15,16,16,14,1,1,30],
  T: [31,4,4,4,4,4,4], U: [17,17,17,17,17,17,14], V: [17,17,17,17,17,10,4],
  Y: [17,17,10,4,4,4,4],
};

const srgb = color => [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));

function quartzPath(mark) {
  if (mark === "'") return 'M2.1 1.2v1.4';
  return [...(DIGITS[mark] || '')].map(segment => SEGMENTS[segment]).join('');
}

function blockPath(mark) {
  return (BLOCKS[mark] || []).flatMap((bits, y) => Array.from({ length: 5 }, (_, x) => (
    bits & (1 << (4 - x)) ? `M${x} ${y}h1v1h-1z` : ''
  ))).join('');
}

function letteringSvg(text, quartz, width, height, unit, pad) {
  const pathFor = quartz ? quartzPath : blockPath;
  const glyphs = [...text].map((letter, i) => `<path transform="translate(${i * 6.3} 0)" d="${pathFor(letter)}"/>`).join('');
  const paint = quartz ? 'fill="none" stroke="white" stroke-width="0.86" stroke-linecap="round"' : 'fill="white"';
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><g transform="translate(${pad} ${pad}) scale(${unit})" ${paint}>${glyphs}</g></svg>`);
}

function imprintGeometry(width, height, text, treatment) {
  const short = Math.min(width, height);
  const unit = Math.min(short * treatment.size / 8, width * 0.83 / (text.length * 6.3 + 3));
  const pad = Math.max(2, Math.ceil(unit * 2));
  const w = Math.min(width, Math.ceil(unit * text.length * 6.3 + pad * 2));
  const h = Math.min(height, Math.ceil(unit * 8 + pad * 2));
  const edge = Math.max(0, Math.floor(short * 0.033) - pad);
  const top = treatment.position.startsWith('top');
  const left = treatment.position.endsWith('left');
  return {
    w, h, unit, pad, x: left ? edge : Math.max(0, width - edge - w),
    y: top ? edge : Math.max(0, height - edge - h), top,
  };
}

// Frame the full picture in paper without changing aspect ratio or cropping its content.
async function paperPrint(base, width, height, area) {
  const edge = Math.max(1, Math.floor(Math.min(width, height) * 0.025));
  const stampedEdge = Math.min(Math.floor(height / 3), area.h + edge);
  const innerW = Math.max(1, width - 2 * edge);
  const innerH = Math.max(1, height - stampedEdge - edge);
  const photo = await sharp(base).resize(innerW, innerH, { fit: 'contain', background: PAPER }).png().toBuffer();
  return sharp({ create: { width, height, channels: 3, background: PAPER } })
    .composite([{ input: photo, left: edge, top: area.top ? stampedEdge : edge }]).png().toBuffer();
}

async function letterMasks(text, treatment, area) {
  const quartz = treatment.type === 'quartz';
  const svg = letteringSvg(text, quartz, area.w, area.h, area.unit, area.pad);
  // Flatten alpha to luminance so the Gaussian spreads coverage (not only RGB).
  const mask = () => sharp(svg).flatten({ background: '#000' }).greyscale();
  const soft = treatment.type === 'print' ? 0.18 : quartz ? 0.32 : 0.25;
  const core = await mask().blur(Math.max(0.3, area.unit * soft)).raw().toBuffer();
  const halo = treatment.type === 'print' || !treatment.intensity ? null
    : await mask().blur(Math.max(0.3, area.unit * (0.8 + treatment.intensity * 1.1))).raw().toBuffer();
  return { core, halo };
}

function stampPatch(pixels, { core, halo }, treatment, area) {
  const tone = srgb(treatment.color);
  for (let i = 0; i < core.length; i++) {
    const k = i * 3;
    const luma = (pixels[k] * 0.2126 + pixels[k + 1] * 0.7152 + pixels[k + 2] * 0.0722) / 255;
    const ink = treatment.type === 'print';
    // Imperfect transfer varies deterministically across the glyph. For film,
    // a brighter exposure masks the imprint and shifts its apparent hue.
    const wear = 0.76 + ((i * 37 + Math.floor(i / area.w) * 19) % 23) / 96;
    const coverage = core[i] / 255;
    const alpha = treatment.opacity * (ink
      ? coverage * (1 - treatment.intensity * (1 - wear))
      : (coverage * (0.74 + 0.26 * treatment.intensity) + (halo?.[i] || 0) / 255 * treatment.intensity * 0.42) * (1 - luma * 0.79));
    if (alpha <= 0) continue;
    for (let c = 0; c < 3; c++) {
      const color = ink ? tone[c] : tone[c] + (255 - tone[c]) * luma * 0.26;
      pixels[k + c] = Math.round(pixels[k + c] * (1 - Math.min(1, alpha)) + color * Math.min(1, alpha));
    }
  }
  return pixels;
}

async function stampImage(source, treatment, maxEdge) {
  const sourceImage = sharp(source, { limitInputPixels: PIXEL_LIMIT }).autoOrient().flatten({ background: PAPER }).toColourspace('srgb');
  if (maxEdge) sourceImage.resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: true });
  let { data: base, info: { width, height } } = await sourceImage.png().toBuffer({ resolveWithObject: true });
  if (Math.min(width, height) < 32) return base;
  const text = imageTreatmentDateText(treatment);
  const area = imprintGeometry(width, height, text, treatment);
  if (treatment.type === 'print') base = await paperPrint(base, width, height, area);
  if (!treatment.opacity) return base;
  const pixels = await sharp(base).extract({ left: area.x, top: area.y, width: area.w, height: area.h }).removeAlpha().raw().toBuffer();
  const patch = stampPatch(pixels, await letterMasks(text, treatment, area), treatment, area);
  return sharp(base).composite([{ input: patch, raw: { width: area.w, height: area.h, channels: 3 }, left: area.x, top: area.y }]).png().toBuffer();
}

// Registry keeps the image pipeline independent of the treatments it runs.
// The first three effects share the stamp renderer, not the same lettering.
const operations = Object.freeze({ quartz: stampImage, early: stampImage, print: stampImage });

// Optical stamps belong to the scanned picture. Fit it within the output
// aspect if a different aspect's cover crop would remove part of the imprint.
async function fitTreatedFrame(png, aspect, maxEdge = TREATED_FRAME_MAX_EDGE) {
  const ratio = ASPECTS[aspect];
  if (!ratio) return png;
  const image = sharp(png);
  const { width, height } = await image.metadata();
  const factor = Math.max(width / ratio[0], height / ratio[1]);
  const scale = Math.min(factor, maxEdge / Math.max(...ratio));
  const w = Math.max(1, Math.round(ratio[0] * scale));
  const h = Math.max(1, Math.round(ratio[1] * scale));
  if (w === width && h === height) return png;
  return image.resize(w, h, { fit: 'contain', background: '#000000' }).png().toBuffer();
}

export async function renderImageTreatment(source, settings, { maxEdge, aspect } = {}) {
  if (!settings) return source;
  const operation = operations[settings.type];
  if (!Object.hasOwn(operations, settings.type)) throw new Error('Unknown image treatment');
  try {
    const png = await operation(source, settings, maxEdge);
    return await fitTreatedFrame(png, aspect, maxEdge);
  }
  catch (cause) {
    throw new ServerError('Could not process this photo. Use a readable still image up to 40 megapixels.', {
      status: 422, code: 'MUSIC_VIDEO_IMAGE_TREATMENT_FAILED', cause,
    });
  }
}

// The preview does not write a file. Full-size render inputs share a
// content-addressed derivative in image-refs (not the image gallery). Its
// ref-* name participates in the existing age-gated staged-reference cleanup.
export async function resolveTreatedShotImage(scene, id, source = undefined, aspect = null) {
  const original = source === undefined ? resolveGalleryImage(id) : source;
  const settings = shotImageTreatment(scene, id);
  if (!original || !settings) return original;
  const bytes = await readFile(original);
  const { imageId: _id, ...treatment } = settings;
  const digest = createHash('sha256').update(bytes).update(JSON.stringify([RENDERER_VERSION, treatment, aspect])).digest('hex');
  const path = join(PATHS.imageRefs, `ref-${digest}.png`);
  if ((await stat(path).catch(() => null))?.isFile()) {
    const now = new Date();
    await utimes(path, now, now);
    return path;
  }
  const png = await renderImageTreatment(bytes, treatment, { aspect });
  await ensureDir(PATHS.imageRefs);
  await atomicWrite(path, png);
  return path;
}

export async function treatedShotImageMedia(scene, id, source, aspect) {
  const path = await resolveTreatedShotImage(scene, id, source, aspect);
  return path ? { path, ext: (extname(path).slice(1) || 'png').toLowerCase().replace('jpeg', 'jpg') } : null;
}

/** Apply treatments after the admission/provenance checks, to the actual queued bytes. */
export async function applyVideoImageTreatments(scene, params, aspect) {
  if (!scene?.imageTreatments?.length) return;
  async function replace(path) {
    // Only original gallery paths can own an editable shot treatment. An
    // uploaded, synthesized or temporary frame with a matching name cannot.
    const id = typeof path === 'string' ? basename(path) : null;
    const original = shotImageTreatment(scene, id) ? resolveGalleryImage(id) : null;
    return original && original === path ? resolveTreatedShotImage(scene, id, path, aspect) : path;
  }
  for (const key of ['sourceImagePath', 'lastImagePath']) {
    if (params[key]) params[key] = await replace(params[key]);
  }
  for (const key of ['referenceImagePaths', 'icReferencePaths']) {
    if (params[key]?.length) params[key] = await Promise.all(params[key].map(replace));
  }
  if (params.castReferences?.length) {
    params.castReferences = await Promise.all(params.castReferences.map(async entry => ({ ...entry, path: await replace(entry.path) })));
  }
  if (params.remoteMedia?.inputAssets?.length) {
    const inputAssets = await Promise.all(params.remoteMedia.inputAssets.map(async entry => (
      entry.role === 'sourceImage' || entry.role === 'lastImage'
        ? { ...entry, path: await replace(resolveGalleryImage(entry.path) || entry.path) } : entry
    )));
    params.remoteMedia = { ...params.remoteMedia, inputAssets };
  }
}
