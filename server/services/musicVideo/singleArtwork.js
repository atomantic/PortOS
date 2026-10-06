/**
 * Music Video — the song's own single artwork (#10331).
 *
 * A single's cover is not a video frame. This keeps `publishKit.singleArtwork`
 * (`{ stylePrompt, options[], approvedImageId, composedPath }`): a style prompt
 * proposed from the treatment, square options generated through the install's
 * DEFAULT image-gen backend (no mode is ever passed), revisions that keep the
 * earlier versions, a 3000×3000 sRGB JPEG with the title and artist set by
 * sharp (never drawn by the model), and an explicit approve the DistroKid
 * payload reads. Generation is always a direct user action (AI Provider Usage
 * Policy): nothing here runs at boot or on project creation.
 */
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { writeFile } from 'fs/promises';
import sharp from 'sharp';
import { join } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { trimTo as str } from '../../lib/textUtils.js';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { resolveGalleryImage } from '../../lib/pathSafety.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { getProject, mutateProjectRecord } from './projects.js';
import { projectPublishKit } from './publishKit.js';

export const SINGLE_ARTWORK_PX = 3000;
const GEN_PX = 1024;
const MAX_OPTIONS = 24;
const MAX_COUNT = 4;
const GEN_TIMEOUT_MS = 21 * 60 * 1000;
export const ARTWORK_POSITIONS = Object.freeze(['top', 'center', 'bottom']);
const DEFAULT_TYPE = Object.freeze({ position: 'bottom', color: '#ffffff', fontFamily: 'Helvetica, Arial, sans-serif', titleScale: 1, showArtist: true });

const fail = (status, code, message) => new ServerError(message, { status, code });

/** The style a single's artwork starts from: the treatment's own look, never a reference cover. */
function proposeSingleArtworkStyle(project) {
  const brief = project?.treatment?.brief || {};
  const parts = [
    str(project?.treatment?.styleLook, 400),
    str(brief.graphicLanguage, 300),
    str(brief.emotion, 200) && `Mood: ${str(brief.emotion, 200)}`,
    str(brief.premise, 300) && `Inspired by: ${str(brief.premise, 300)}`,
    str(project?.concept?.moodBoardStyle, 300),
  ].filter(Boolean);
  const look = parts.length ? parts.join('. ') : 'A bold, simple graphic composition with one strong focal subject';
  return `Square single artwork, original composition. ${look}. No text, lettering, logos or watermarks.`;
}

export const singleArtworkOf = (project) => {
  const art = projectPublishKit(project).singleArtwork;
  return {
    stylePrompt: str(art?.stylePrompt, 4000),
    options: Array.isArray(art?.options) ? art.options : [],
    approvedImageId: art?.approvedImageId || null,
    composedPath: art?.composedPath || null,
    composedOptionId: art?.composedOptionId || null,
    referenceImages: Array.isArray(art?.referenceImages) ? art.referenceImages : [],
    type: { ...DEFAULT_TYPE, ...(art?.type || {}) },
  };
};

/** What the UI shows: the stored state with a proposed style filled in until the director writes one. */
export const presentSingleArtwork = (project) => {
  const art = singleArtworkOf(project);
  return { ...art, stylePrompt: art.stylePrompt || proposeSingleArtworkStyle(project), proposedStylePrompt: proposeSingleArtworkStyle(project) };
};

async function requireProject(projectId) {
  const project = await getProject(projectId);
  if (!project) throw fail(404, 'NOT_FOUND', 'Project not found');
  return project;
}

const writeArtwork = (projectId, fn) => mutateProjectRecord(projectId, (current) => {
  const kit = projectPublishKit(current);
  const next = fn(singleArtworkOf(current), current);
  return { project: { ...current, publishKit: { ...kit, singleArtwork: next } } };
});

/** Save the director's edited style prompt, reference images and type settings. */
export async function updateSingleArtwork(projectId, patch = {}) {
  await requireProject(projectId);
  return writeArtwork(projectId, (art) => ({
    ...art,
    ...(typeof patch.stylePrompt === 'string' ? { stylePrompt: str(patch.stylePrompt, 4000) } : {}),
    ...(Array.isArray(patch.referenceImages) ? { referenceImages: patch.referenceImages.filter((f) => typeof f === 'string').slice(0, 4) } : {}),
    ...(patch.type ? { type: { ...art.type, ...patch.type } } : {}),
  }));
}

/** One image through the install's default backend, awaited to the file on disk. */
async function generateOne(params, deps) {
  const imageGen = deps.imageGen || await import('../imageGen/index.js');
  const { createImageGenWaiter } = await import('../imageGenWaiter.js');
  const waiter = createImageGenWaiter({
    timeoutMs: deps.timeoutMs || GEN_TIMEOUT_MS,
    onTimeout: () => fail(504, 'SINGLE_ARTWORK_TIMEOUT', 'Single artwork generation timed out'),
    onFailed: (ev) => fail(502, 'SINGLE_ARTWORK_FAILED', `Single artwork generation failed: ${ev?.error || 'unknown error'}`),
  });
  const jobId = randomUUID();
  waiter.register(jobId);
  let result;
  // No `mode`: the install's saved Image Gen backend decides (#10331).
  try { result = await imageGen.generateImage({ ...params, jobId }); } catch (err) { waiter.cleanup(); throw err; }
  const filename = result?.filename || null;
  if (filename) { waiter.cleanup(); return filename; } // synchronous backend: the file is already there
  const done = await waiter.promise;
  if (!done?.filename) throw fail(502, 'SINGLE_ARTWORK_FAILED', 'The image backend returned no file');
  return done.filename;
}

function referencePaths(filenames) {
  return (filenames || []).map((f) => resolveGalleryImage(f)).filter((p) => p && existsSync(p));
}

/** Generate `count` square options from the style prompt (or `adjust` one existing option). */
async function generateOptions(projectId, { prompt, count, parent = null, referenceImages = [], kind }, deps) {
  const project = await requireProject(projectId);
  const refs = referencePaths(referenceImages);
  const made = [];
  for (let i = 0; i < count; i += 1) {
    const filename = await generateOne({
      prompt, width: GEN_PX, height: GEN_PX,
      ...(refs.length ? { referenceImagePaths: refs, referenceImageStrengths: refs.map(() => 1) } : {}),
      // Links the gallery record to the project; carries no sceneId, so scene hooks ignore it.
      musicVideo: { projectId: project.id, singleArtwork: true },
    }, deps);
    made.push({ id: `sa-${randomUUID().slice(0, 8)}`, filename, kind, prompt, parentId: parent?.id || null, createdAt: new Date().toISOString() });
  }
  return writeArtwork(projectId, (art) => ({ ...art, options: [...art.options, ...made].slice(-MAX_OPTIONS) }));
}

export async function generateSingleArtwork(projectId, { stylePrompt, count = 2, referenceImages } = {}, deps = {}) {
  const project = await requireProject(projectId);
  const stored = singleArtworkOf(project);
  const prompt = str(stylePrompt, 4000) || stored.stylePrompt || proposeSingleArtworkStyle(project);
  const refs = Array.isArray(referenceImages) ? referenceImages : stored.referenceImages;
  await writeArtwork(projectId, (art) => ({ ...art, stylePrompt: prompt, referenceImages: refs.slice(0, 4) }));
  return generateOptions(projectId, { prompt, count: Math.min(MAX_COUNT, Math.max(1, count)), referenceImages: refs, kind: 'generate' }, deps);
}

/** Revise one option: the old version stays in `options`, the new one links back to it. */
export async function adjustSingleArtwork(projectId, optionId, adjustPrompt, deps = {}) {
  const project = await requireProject(projectId);
  const art = singleArtworkOf(project);
  const parent = art.options.find((o) => o.id === optionId);
  if (!parent) throw fail(404, 'NOT_FOUND', 'That artwork option does not exist');
  const note = str(adjustPrompt, 2000);
  if (!note) throw fail(422, 'VALIDATION_ERROR', 'Say what to change');
  const prompt = `${art.stylePrompt || proposeSingleArtworkStyle(project)}\nRevise the supplied artwork: ${note}`;
  // Edit-capable backends take the option as an input image; the rest regenerate from the revised prompt.
  return generateOptions(projectId, { prompt, count: 1, parent, referenceImages: [parent.filename], kind: 'adjust' }, deps);
}

const escapeXml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

/** The title/artist layer: SVG text sharp rasterizes, so the model never draws lettering. */
function typeOverlaySvg({ title, artist, type }) {
  const t = { ...DEFAULT_TYPE, ...(type || {}) };
  const size = Math.round(SINGLE_ARTWORK_PX * 0.095 * Math.min(2, Math.max(0.4, Number(t.titleScale) || 1)));
  const pos = ARTWORK_POSITIONS.includes(t.position) ? t.position : 'bottom';
  const y = pos === 'top' ? size * 1.4 : pos === 'center' ? SINGLE_ARTWORK_PX / 2 : SINGLE_ARTWORK_PX - size * 1.6;
  const color = /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : DEFAULT_TYPE.color;
  const family = escapeXml(String(t.fontFamily || DEFAULT_TYPE.fontFamily).slice(0, 100));
  const shadow = 'style="paint-order:stroke;stroke:rgba(0,0,0,0.55);stroke-width:' + Math.round(size * 0.06) + 'px"';
  const lines = [`<text x="50%" y="${y}" text-anchor="middle" font-family="${family}" font-weight="700" font-size="${size}" fill="${color}" ${shadow}>${escapeXml(title)}</text>`];
  if (t.showArtist !== false && artist) {
    lines.push(`<text x="50%" y="${y + size * 0.85}" text-anchor="middle" font-family="${family}" font-size="${Math.round(size * 0.5)}" fill="${color}" ${shadow}>${escapeXml(artist)}</text>`);
  }
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SINGLE_ARTWORK_PX}" height="${SINGLE_ARTWORK_PX}">${lines.join('')}</svg>`);
}

/** Render an option to the 3000×3000 sRGB JPEG DistroKid takes, with the title and artist set on top. */
export async function composeSingleArtwork(projectId, { optionId, artist, type } = {}) {
  const project = await requireProject(projectId);
  const art = singleArtworkOf(project);
  const option = art.options.find((o) => o.id === optionId);
  if (!option) throw fail(404, 'NOT_FOUND', 'That artwork option does not exist');
  const source = resolveGalleryImage(option.filename);
  if (!source || !existsSync(source)) throw fail(422, 'PUBLISH_ASSET_MISSING', 'The artwork image is missing on disk: generate it again');
  const title = str(project.name, 200);
  if (!title) throw fail(422, 'VALIDATION_ERROR', 'Name the project first: it is the song title on the cover');
  const nextType = { ...art.type, ...(type || {}) };
  await ensureDir(PATHS.videoThumbnails);
  const name = `single-artwork-${project.id.slice(0, 8)}-${Date.now()}.jpg`;
  const jpeg = await sharp(source)
    .resize(SINGLE_ARTWORK_PX, SINGLE_ARTWORK_PX, { fit: 'cover' })
    .composite([{ input: typeOverlaySvg({ title, artist: str(artist, 200), type: nextType }) }])
    .toColorspace('srgb')
    .jpeg({ quality: 92 })
    .toBuffer();
  await withBackupAssetPublication(async () => {
    await writeFile(join(PATHS.videoThumbnails, name), jpeg);
    await writeArtwork(projectId, (cur) => ({
      ...cur, type: nextType,
      // A new composition invalidates a prior approval: the director approves what they last saw.
      composedOptionId: option.id, composedPath: name, approvedImageId: null,
    }));
  });
  return { project: await getProject(projectId) };
}

/** The explicit approve the DistroKid publish reads. Only the composed option can be approved. */
export async function approveSingleArtwork(projectId, optionId) {
  const project = await requireProject(projectId);
  const art = singleArtworkOf(project);
  if (!art.composedPath || art.composedOptionId !== optionId) throw fail(409, 'VALIDATION_ERROR', 'Compose this option with its title and artist before approving it');
  return writeArtwork(projectId, (cur) => ({ ...cur, approvedImageId: optionId }));
}

/** Withdraw the approval (publishing falls back to the thumbnail, with a warning). */
export const clearSingleArtworkApproval = (projectId) => writeArtwork(projectId, (cur) => ({ ...cur, approvedImageId: null }));
