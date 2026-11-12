/**
 * What a Blender film render was made from, so a render made from other source
 * or settings reads as stale. Staleness is computed when it is read and never
 * stored: the hashes on a render are compared with the workspace as it is now.
 *
 *   shot hash     = the shot's dependency files (path + content) plus its start and end
 *   settings hash = engine, pixel size, frame rate, scale and samples of one quality
 *   song hash     = the song context staged into the job
 *   options hash  = the film options the render was built with (`ctx.options`)
 */
import { createHash } from 'node:crypto';
import { sha256File } from '../../../lib/fileCore.js';
import { blenderRenderFrame } from '../../../lib/musicVideoBlender.js';
import { walkBlenderSources } from './sources.js';

const sha = (value) => createHash('sha256').update(value).digest('hex');

// absolute path → { bytes, mtimeMs, hash }: an unchanged file is hashed once per
// process, so reading state does not re-read every asset.
const contentHashes = new Map();
const CONTENT_HASH_LIMIT = 20000;

async function contentHash({ absolute, bytes, mtimeMs }) {
  const known = contentHashes.get(absolute);
  if (known && known.bytes === bytes && known.mtimeMs === mtimeMs) return known.hash;
  const hash = await sha256File(absolute);
  if (contentHashes.size >= CONTENT_HASH_LIMIT) contentHashes.clear();
  contentHashes.set(absolute, { bytes, mtimeMs, hash });
  return hash;
}

/**
 * The film source as it is now: `files` maps each source path to its content
 * hash (in path order) and `tree` is one hash over all of them.
 */
export async function hashBlenderSources(projectId) {
  const files = new Map();
  for (const entry of await walkBlenderSources(projectId)) files.set(entry.path, await contentHash(entry));
  return { files, tree: sha([...files].map(([path, hash]) => `${path}\0${hash}`).join('\n')) };
}

/**
 * Hash of what one shot is built from. `shot.deps` names files or folders under
 * src/; without it the shot depends on every source file. A listed dependency
 * that does not exist still counts (as missing), so creating it stales the render.
 */
export function blenderShotHash(shot, files) {
  const deps = Array.isArray(shot.deps) && shot.deps.length ? [...new Set(shot.deps)].sort() : null;
  const covered = (path) => !deps || deps.some((dep) => path === dep || path.startsWith(`${dep}/`));
  const used = [...files].filter(([path]) => covered(path)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const missing = (deps || []).filter((dep) => !used.some(([path]) => path === dep || path.startsWith(`${dep}/`)));
  return sha(JSON.stringify({ files: used, missing, start: shot.start, end: shot.end }));
}

/** Hash of the settings one quality renders with. */
export function blenderSettingsHash(settings, quality) {
  const { width, height, scale, samples } = blenderRenderFrame(settings, quality);
  return sha(JSON.stringify([settings.engine, width, height, settings.fps, scale, samples]));
}

/**
 * Hash of the film options a render is built with (`ctx.options`), in key
 * order. A film that declares none hashes like a render made before options existed.
 */
export function blenderOptionsHash(options) {
  return sha(JSON.stringify(Object.entries(options || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}

export const BLENDER_NO_OPTIONS_HASH = blenderOptionsHash({});

/** Hash of a manifest's shot list: what the last sync produced. */
export const blenderManifestHash = (shots) => sha(JSON.stringify(shots));

/** Older renders have no import record and retain their declared-dependency contract. */
export function blenderImportsChanged(imports, files) {
  return imports != null && Object.entries(imports).some(([path, hash]) => files.get(path) !== hash);
}

/** Missing-at-start imports stay stale even if created while Blender is running. */
export const blenderImportHashes = (paths, files) => Object.fromEntries(paths.map((path) => [path, files.get(path) ?? null]));

/** The canonical song projection built by song.js, exactly as staged for the driver. */
export const blenderSongHash = (song) => sha(JSON.stringify(song));
