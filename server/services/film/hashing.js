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
import { lstat, readFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import { sha256File } from '../../lib/fileCore.js';
import { blenderRenderFrame } from '../../lib/musicVideoBlender.js';
import { staticImportSpecifiersFromSource } from '../../lib/staticImportGraph.js';
import { walkBlenderSources } from './sources.js';
import { blenderSrcDir } from './workspace.js';

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
export async function hashBlenderSources(owner) {
  const files = new Map();
  for (const entry of await walkBlenderSources(owner)) files.set(entry.path, await contentHash(entry));
  return { files, tree: sha([...files].map(([path, hash]) => `${path}\0${hash}`).join('\n')) };
}

/** The code module of a code shot, then each layer module, in declaration order. */
export function filmCodeEntries(shot) {
  const entries = [];
  if (shot?.renderer === 'code' && typeof shot.entry === 'string') entries.push(shot.entry);
  for (const layer of shot?.layers || []) if (typeof layer?.entry === 'string') entries.push(layer.entry);
  return entries;
}

/**
 * Resolve a static import specifier written in `fromPath` (a src/-relative file).
 * Bare packages stay bare (the host supplies `three`). A relative specifier that
 * leaves src/ is an escape and is not followed.
 */
function resolveCodeImport(fromPath, specifier) {
  if (typeof specifier !== 'string' || !specifier.startsWith('.')) return { bare: specifier || '' };
  const target = normalize(join(dirname(fromPath), specifier)).split(sep).join('/');
  if (!target || target === '..' || target.startsWith('../') || target.split('/').includes('..')) return { escape: true };
  return { path: target };
}

const codeModuleCandidates = (path) => (
  /\.(?:js|mjs)$/i.test(path) ? [path] : [path, `${path}.js`, `${path}.mjs`, `${path}/index.js`, `${path}/index.mjs`]
);

/**
 * Static-import closure of every code entry in `shots`: entry path → the entry
 * and the relative modules it reaches under src/, including a missing import
 * (creating that file stales the shot). Bare `three` is host-provided and is
 * not part of the closure. One file is read once per call.
 */
export async function codeModuleClosures(owner, shots) {
  const closures = new Map();
  const known = new Map();
  const src = blenderSrcDir(owner);
  const locate = async (rel) => {
    for (const candidate of codeModuleCandidates(rel)) {
      if (candidate.split('/').some((part) => !part || part === '.' || part === '..')) continue;
      const absolute = join(src, ...candidate.split('/'));
      const info = await lstat(absolute).catch(() => null);
      if (info?.isFile()) return { path: candidate, absolute };
    }
    return null;
  };
  const walk = async (entry) => {
    if (known.has(entry)) return known.get(entry);
    const paths = [];
    const seen = new Set();
    const visit = async (rel) => {
      if (seen.has(rel)) return;
      seen.add(rel);
      const found = await locate(rel);
      paths.push(found?.path || rel);
      if (!found) return;
      const source = await readFile(found.absolute, 'utf8').catch(() => null);
      if (source == null) return;
      for (const specifier of staticImportSpecifiersFromSource(source)) {
        const resolved = resolveCodeImport(found.path, specifier);
        if (resolved.path) await visit(resolved.path);
      }
    };
    await visit(entry);
    known.set(entry, paths);
    return paths;
  };
  for (const shot of shots || []) {
    for (const entry of filmCodeEntries(shot)) {
      if (!closures.has(entry)) closures.set(entry, await walk(entry));
    }
  }
  return closures;
}

/**
 * Hash of what one shot is built from. `shot.deps` names files or folders under
 * src/; without it the shot depends on every source file. A listed dependency
 * that does not exist still counts (as missing), so creating it stales the render.
 * A code entry and its static-import closure join the hash even when `deps`
 * omits them. `closures` is `codeModuleClosures`; without it, only the entry
 * path itself is added. A Blender shot with no code keeps the historical body
 * `{ files, missing, start, end }`, so existing renders stay current.
 */
export function blenderShotHash(shot, files, { closures } = {}) {
  const deps = Array.isArray(shot.deps) && shot.deps.length ? [...new Set(shot.deps)].sort() : null;
  const covered = (path) => !deps || deps.some((dep) => path === dep || path.startsWith(`${dep}/`));
  const extra = new Set();
  for (const entry of filmCodeEntries(shot)) {
    for (const path of closures?.get(entry) || [entry]) extra.add(path);
  }
  const used = [...files].filter(([path]) => covered(path) || extra.has(path)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const missing = (deps || []).filter((dep) => !used.some(([path]) => path === dep || path.startsWith(`${dep}/`)));
  for (const path of [...extra].sort()) {
    if (!files.has(path) && !missing.includes(path)) missing.push(path);
  }
  const body = { files: used, missing, start: shot.start, end: shot.end };
  if (shot.renderer === 'code' || shot.entry || shot.layers?.length) {
    body.renderer = shot.renderer === 'code' ? 'code' : 'blender';
    body.entry = shot.entry || null;
    body.space = shot.space || 'canvas';
    body.layers = (shot.layers || []).map((layer) => ({
      entry: layer.entry, place: layer.place || 'over', blend: layer.blend || 'normal',
    }));
  }
  return sha(JSON.stringify(body));
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
