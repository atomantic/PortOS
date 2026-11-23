/**
 * 3D models copied from the library into a film's src/models/. A copy is a
 * snapshot: `<slug>.glb` (image-to-3D) or `<slug>.js` (a Three.js model's
 * factory module) beside `<slug>.json` recording where it came from and its
 * SHA-256. Deleting or re-rendering the source never changes the film; a newer
 * source only surfaces as `updateAvailable`, and the copy changes when the
 * operator asks (`updateFilmModel`). Containment is the shared source-tree
 * check, so a symlinked src/ or src/models/ is refused.
 */
import { copyFile, lstat, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { PATHS } from '../../lib/fileUtils.js';
import { atomicWrite, sha256File, sha256Text } from '../../lib/fileCore.js';
import { pathWithin } from '../../../lib/pathWithin.js';
import { assertInsideWithoutSymlinks, blenderRefusal, blenderWorkspaceDir, resolveBlenderSourceFile } from './workspace.js';
import { walkBlenderSources } from './sources.js';

export const FILM_MODEL_KINDS = Object.freeze(['image-to-3d', 'threejs']);
export const FILM_MODEL_SLUG = /^[a-z0-9][a-z0-9_-]{0,39}$/;
// A mesh GLB can be large; refuse past this rather than fill the workspace.
const MAX_MODEL_BYTES = 256 * 1024 * 1024;

const notFound = (message) => blenderRefusal(message, 'NOT_FOUND', 404);
const conflict = (message, code) => blenderRefusal(message, code, 409);

export const slugForName = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'model';

/** A served `/data/image-to-3d/...` URL as its file on disk, or null for any other value. */
function imageTo3dDiskPath(url) {
  const prefix = '/data/image-to-3d/';
  if (typeof url !== 'string' || !url.startsWith(prefix)) return null;
  try { return pathWithin(PATHS.imageTo3d, ...url.slice(prefix.length).split('/')); } catch { return null; }
}

/**
 * The library asset a copy is made from: `{ name, sourceAt, variant, ext, file | text }`.
 * The richest published asset wins unless `variant` names one (`animated` > `rigged` > `mesh`).
 */
async function resolveSource(kind, id, variant) {
  if (kind === 'threejs') {
    const { getModelSource } = await import('../threejsModels/index.js');
    const { getModel } = await import('../threejsModels/db.js');
    const record = await getModel(id);
    if (!record) throw notFound('That Three.js model is not in the library');
    const { source } = await getModelSource(id).catch((error) => {
      throw error.status === 409 ? conflict(error.message, 'MODEL_NOT_READY') : error;
    });
    return { name: record.name, sourceAt: record.updatedAt ?? null, variant: 'source', ext: 'js', text: source };
  }
  const { getModel } = await import('../imageTo3d/db.js');
  const record = await getModel(id);
  if (!record) throw notFound('That image-to-3D model is not in the library');
  const choices = {
    animated: record.retarget?.status === 'ready' ? imageTo3dDiskPath(record.retarget.assetPath) : null,
    rigged: record.rig?.status === 'ready' ? imageTo3dDiskPath(record.rig.assetPath) : null,
    mesh: null,
  };
  const wanted = variant || ['animated', 'rigged'].find((name) => choices[name]) || 'mesh';
  if (!['animated', 'rigged', 'mesh'].includes(wanted)) throw blenderRefusal('Unknown model variant', 'VALIDATION_ERROR');
  let file = choices[wanted];
  if (wanted === 'mesh') {
    const { getModelAsset } = await import('../imageTo3d/models.js');
    file = (await getModelAsset(id).catch((error) => {
      throw error.status === 409 ? conflict(error.message, 'MODEL_NOT_READY') : error;
    })).path;
  }
  if (!file) throw conflict(`This model has no ${wanted} asset`, 'MODEL_ASSET_MISSING');
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw conflict('The library asset for this model is missing on disk', 'MODEL_ASSET_MISSING');
  if (info.size > MAX_MODEL_BYTES) throw blenderRefusal('That model is too large to copy into a film', 'MUSIC_VIDEO_BLENDER_FILE_TOO_LARGE', 413);
  return { name: record.name, sourceAt: record.updatedAt ?? null, variant: wanted, ext: 'glb', file, bytes: info.size };
}

const sidecarPath = (slug) => `models/${slug}.json`;

async function exists(owner, path) {
  const { absolute } = await resolveBlenderSourceFile(owner, path);
  return Boolean(await lstat(absolute).catch(() => null));
}

/** Write the copy and its sidecar; the data file lands first so a sidecar never names a missing file. */
async function writeCopy(owner, slug, kind, id, source) {
  const dataPath = `models/${slug}.${source.ext}`;
  const { absolute } = await resolveBlenderSourceFile(owner, dataPath);
  const { absolute: sidecar } = await resolveBlenderSourceFile(owner, sidecarPath(slug));
  await mkdir(dirname(absolute), { recursive: true });
  // The directory now exists: re-run containment so a link planted there is refused.
  await assertInsideWithoutSymlinks(blenderWorkspaceDir(owner), absolute);
  let sha256;
  let bytes;
  if (source.file) {
    // A dot name is skipped by the source walk, so a half-written copy is never listed or hashed.
    const temp = join(dirname(absolute), `.${slug}.${randomBytes(4).toString('hex')}.tmp`);
    try {
      await copyFile(source.file, temp);
      sha256 = await sha256File(temp);
      bytes = (await stat(temp)).size;
      await rename(temp, absolute);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  } else {
    sha256 = sha256Text(source.text);
    bytes = Buffer.byteLength(source.text, 'utf8');
    await atomicWrite(absolute, source.text);
  }
  const record = {
    schema: 1, slug, kind, sourceId: id, variant: source.variant, name: source.name, file: dataPath,
    sourceAt: source.sourceAt, sha256, bytes, copiedAt: new Date().toISOString(),
  };
  await atomicWrite(sidecar, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/**
 * Copy library model `id` into the film. Without `slug` the name picks one and a
 * taken slug gets a numeric suffix; an explicit taken `slug` is a 409 unless
 * `replace` is true. Returns the copy's record and a `load` snippet.
 */
export async function addFilmModel(owner, { kind, id, variant, slug, replace = false }) {
  const source = await resolveSource(kind, id, variant);
  let chosen = slug;
  if (!chosen) {
    const base = slugForName(source.name);
    chosen = base;
    for (let n = 2; await exists(owner, sidecarPath(chosen)) || await exists(owner, `models/${chosen}.${source.ext}`); n += 1) {
      chosen = `${base.slice(0, 36)}-${n}`;
    }
  } else if (!replace && (await exists(owner, sidecarPath(chosen)) || await exists(owner, `models/${chosen}.${source.ext}`))) {
    throw conflict(`A model named "${chosen}" is already in this film. Choose another name or replace it.`, 'MUSIC_VIDEO_BLENDER_MODEL_EXISTS');
  }
  if (replace && slug) await removeStaleCopy(owner, chosen, source.ext);
  const record = await writeCopy(owner, chosen, kind, id, source);
  return { model: record, snippet: modelSnippet(record) };
}

// A replace that changes format (glb <-> js) must not leave the old data file beside the new sidecar.
async function removeStaleCopy(owner, slug, ext) {
  const other = ext === 'glb' ? 'js' : 'glb';
  const { absolute } = await resolveBlenderSourceFile(owner, `models/${slug}.${other}`);
  const info = await lstat(absolute).catch(() => null);
  if (info?.isFile()) await rm(absolute);
}

export const modelSnippet = (record) => (record.file.endsWith('.js')
  ? `import { build } from "./models/${record.slug}.js"; // Three.js factory, for "space": "three" code shots`
  : `from portos_film import models\nroot, actions = models.load(ctx, "${record.slug}", height=1.8)  # meters; sits on z = 0`);

async function readSidecar(absolute) {
  const raw = await readFile(absolute, 'utf8').catch(() => null);
  let value = null;
  try { value = raw ? JSON.parse(raw) : null; } catch { value = null; }
  const ok = value && typeof value === 'object' && FILM_MODEL_SLUG.test(value.slug || '')
    && FILM_MODEL_KINDS.includes(value.kind) && typeof value.sourceId === 'string' && typeof value.file === 'string';
  return ok ? value : null;
}

/** The film's copies, each with whether the library now holds a different asset: `{ models }`. */
export async function listFilmModels(owner) {
  const entries = (await walkBlenderSources(owner)).filter(({ path }) => /^models\/[^/]+\.json$/.test(path));
  const models = [];
  for (const entry of entries) {
    const record = await readSidecar(entry.absolute);
    if (!record || sidecarPath(record.slug) !== entry.path) continue;
    const current = await resolveSource(record.kind, record.sourceId, record.variant === 'source' ? undefined : record.variant).catch((error) => ({ error }));
    const sourceMissing = Boolean(current.error);
    let currentSha = null;
    if (!sourceMissing) currentSha = current.file ? await sha256File(current.file) : sha256Text(current.text);
    models.push({ ...record, sourceMissing, updateAvailable: !sourceMissing && currentSha !== record.sha256, snippet: modelSnippet(record) });
  }
  return { models };
}

/** Re-copy `slug` from its recorded source. A source that is gone is a 409, never a silent no-op. */
export async function updateFilmModel(owner, slug) {
  const { absolute } = await resolveBlenderSourceFile(owner, sidecarPath(slug));
  const record = await readSidecar(absolute);
  if (!record) throw notFound('That model copy is not in this film');
  const source = await resolveSource(record.kind, record.sourceId, record.variant === 'source' ? undefined : record.variant);
  const next = await writeCopy(owner, slug, record.kind, record.sourceId, source);
  return { model: next, snippet: modelSnippet(next) };
}
