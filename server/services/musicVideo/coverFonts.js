/**
 * Music Video cover lettering: typefaces the director uploads (#10345).
 *
 * A font file (.ttf/.otf/.woff2) lives under `data/cover-fonts/` with an index
 * of `{ id, family, ext, width }`. A design names one as `font:<id>`
 * (musicVideoCoverOverlay.js). The title is drawn by librsvg through sharp, so
 * the font has to be known to the renderer's font system, and that differs by
 * platform: fontconfig platforms take the file through libvips' text-op
 * `fontfile` hook (adds it to the process-wide config, live), while macOS
 * renders through CoreText, which only sees fonts in a Fonts folder, so each
 * font is mirrored into `~/Library/Fonts/PortOS` (picked up by the running
 * process within a couple of seconds).
 *
 * An upload is accepted only after the renderer proves it can set text in the
 * font: a probe string must measure differently from a missing family. That
 * probe also yields the font's measured average advance (`width`), which the
 * layout uses in place of a built-in face's hard-coded one.
 */
import { createHash } from 'crypto';
import { copyFile, readFile, rm, stat, mkdir } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { fontContainer, fontFamilyName } from '../../lib/fontMetadata.js';
import { atomicWrite } from '../../lib/fileCore.js';
import { readJSONFile } from '../../lib/jsonIo.js';
import { PATHS } from '../../lib/paths.js';
import { measureWidths } from './coverArtCompose.js';

export const MAX_COVER_FONT_BYTES = 8 * 1024 * 1024;
export const MAX_COVER_FONTS = 24;
const EXTENSIONS = new Set(['ttf', 'otf', 'woff2']);
const PROBE_TEXT = 'Hamburgefonstiv 0123 Quartz';
const MISSING_FAMILY = 'zz-portos-no-such-family';
const POLL_MS = 400;

const defaults = {
  sharp: async () => (await import('sharp')).default,
  // macOS only: CoreText reads fonts from a Fonts folder, not from a fontconfig directory.
  mirrorDir: process.platform === 'darwin' && !process.env.VITEST ? join(homedir(), 'Library', 'Fonts', 'PortOS') : null,
  waitMs: 6000,
};
let deps = { ...defaults };
export function __setCoverFontDepsForTests(overrides) { deps = { ...defaults, ...overrides }; resetRegistered(); }

const fontError = (status, code, message) => new ServerError(message, { status, code });
const indexFile = () => join(PATHS.coverFonts, 'fonts.json');
const fontFile = (font) => join(PATHS.coverFonts, `${font.id}.${font.ext}`);
const registered = new Set();
function resetRegistered() { registered.clear(); }

// Every write reads the index fresh and goes through one tail, so two uploads never overwrite each other's row.
let writeTail = Promise.resolve();
const serialized = (task) => {
  const run = writeTail.then(task);
  writeTail = run.catch(() => {});
  return run;
};

const isFont = (v) => v && typeof v === 'object' && typeof v.id === 'string' && typeof v.family === 'string'
  && EXTENSIONS.has(v.ext) && Number.isFinite(v.width) && v.width > 0;

/** The uploaded typefaces, oldest first: `{ id, family, ext, width, addedAt }`. */
export async function listCoverFonts() {
  const stored = await readJSONFile(indexFile(), { fonts: [] }, { allowArray: false });
  return (Array.isArray(stored?.fonts) ? stored.fonts : []).filter(isFont);
}

/** A font file's absolute path, or null when `id` names none. */
export async function coverFontPath(id) {
  const font = (await listCoverFonts()).find((f) => f.id === id);
  return font ? { font, path: fontFile(font) } : null;
}

const slugOf = (family) => family.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'font';
// A family is written into CSS and XML attributes; keep it to plain name characters.
const cleanFamily = (family) => family.replace(/[^\p{L}\p{N} ._+-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 60);

/**
 * Tell the renderer about `fonts`. Idempotent per process. fontconfig
 * platforms register through libvips; macOS mirrors into the user's Fonts
 * folder (a missing mirror is rewritten, so a wiped folder heals on the next compose).
 */
export async function registerCoverFonts(fonts) {
  if (!fonts.length) return;
  if (deps.mirrorDir) {
    await mkdir(deps.mirrorDir, { recursive: true });
    for (const font of fonts) {
      const target = join(deps.mirrorDir, `${font.id}.${font.ext}`);
      if (!(await stat(target).catch(() => null))) await copyFile(fontFile(font), target);
    }
    return;
  }
  const sharp = await deps.sharp();
  for (const font of fonts) {
    const file = fontFile(font);
    if (registered.has(file)) continue;
    await sharp({ text: { text: 'A', fontfile: file, rgba: true } }).png().toBuffer().catch((err) => {
      console.warn(`⚠️ Cover font ${font.id}: renderer would not take the file (${err.message})`);
    });
    registered.add(file);
  }
}

const familyAttr = (family) => `font-family="'${family}',sans-serif"`;

/**
 * The font's average advance per character (fraction of the font size) as the
 * renderer sets it, once it can: polls until the probe differs from a missing
 * family's fallback, or `waitMs` runs out (null).
 */
async function measureRegistered(sharp, family) {
  const deadline = Date.now() + deps.waitMs;
  for (;;) {
    const [own, fallback] = await Promise.all([
      measureWidths(sharp, [PROBE_TEXT], familyAttr(family)).then((w) => w(PROBE_TEXT)),
      measureWidths(sharp, [PROBE_TEXT], familyAttr(MISSING_FAMILY)).then((w) => w(PROBE_TEXT)),
    ]);
    if (own && fallback && Math.abs(own - fallback) / fallback > 0.005) return Math.round((own / PROBE_TEXT.length) * 1000) / 1000;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/**
 * Accept an uploaded font file (already on disk at `tempPath`). The same
 * family uploaded again replaces its file, so designs naming it keep working.
 */
export async function addCoverFont({ tempPath, originalName = '' }) {
  const ext = String(originalName).toLowerCase().split('.').pop();
  if (!EXTENSIONS.has(ext)) throw fontError(400, 'VALIDATION_ERROR', 'Cover fonts must be .ttf, .otf or .woff2 files');
  const size = (await stat(tempPath)).size;
  if (size > MAX_COVER_FONT_BYTES) throw fontError(413, 'VALIDATION_ERROR', `That font file is over ${MAX_COVER_FONT_BYTES / 1024 / 1024} MB`);
  const buffer = await readFile(tempPath);
  if (!fontContainer(buffer)) throw fontError(422, 'VALIDATION_ERROR', 'That file is not a single-font TrueType, OpenType or WOFF2 file');
  const stem = String(originalName).replace(/\.[^.]+$/, '');
  const family = cleanFamily(fontFamilyName(buffer) || stem);
  if (!family) throw fontError(422, 'VALIDATION_ERROR', 'That font has no usable family name');

  return serialized(async () => {
    const fonts = await listCoverFonts();
    const same = fonts.find((f) => f.family.toLowerCase() === family.toLowerCase());
    if (!same && fonts.length >= MAX_COVER_FONTS) throw fontError(409, 'COVER_FONT_LIMIT', `Remove a font first: at most ${MAX_COVER_FONTS} can be uploaded`);
    const slug = slugOf(family);
    const taken = (id) => fonts.some((f) => f.id === id && f !== same);
    const id = same?.id || (taken(slug) ? `${slug}-${createHash('sha1').update(family).digest('hex').slice(0, 6)}` : slug);
    const font = { id, family, ext, width: 0, addedAt: new Date().toISOString() };
    await mkdir(PATHS.coverFonts, { recursive: true });
    await atomicWrite(fontFile(font), buffer);
    // The probe runs against what is on disk; a replaced font under the same name keeps its old registration until a restart on fontconfig platforms.
    registered.delete(fontFile(font));
    await registerCoverFonts([font]);
    const measured = await measureRegisteredFont(font);
    if (!measured) {
      await rm(fontFile(font), { force: true });
      if (deps.mirrorDir) await rm(join(deps.mirrorDir, `${font.id}.${font.ext}`), { force: true });
      throw fontError(422, 'COVER_FONT_UNUSABLE', `This machine's renderer could not set text in "${family}". Try the .ttf or .otf version of the font`);
    }
    font.width = measured;
    // A same-family upload in another format leaves the old file behind otherwise.
    if (same && same.ext !== ext) await rm(fontFile(same), { force: true });
    await atomicWrite(indexFile(), { fonts: [...fonts.filter((f) => f !== same), font] });
    console.log(`🔤 Cover font ${font.id} added (${family}, ${ext})`);
    return font;
  });
}

async function measureRegisteredFont(font) {
  const sharp = await deps.sharp();
  return measureRegistered(sharp, font.family);
}

/** Remove an uploaded font. Designs that name it fall back to the default typeface. */
export async function removeCoverFont(id) {
  return serialized(async () => {
    const fonts = await listCoverFonts();
    const font = fonts.find((f) => f.id === id);
    if (!font) throw fontError(404, 'NOT_FOUND', 'Font not found');
    await atomicWrite(indexFile(), { fonts: fonts.filter((f) => f !== font) });
    await rm(fontFile(font), { force: true });
    if (deps.mirrorDir) await rm(join(deps.mirrorDir, `${font.id}.${font.ext}`), { force: true });
    console.log(`🔤 Cover font ${font.id} removed`);
  });
}
