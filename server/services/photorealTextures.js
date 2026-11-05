/**
 * Environments › Photoreal: CC0 photo textures from Poly Haven, downloaded only
 * when the user picks one. A look maps a material preset to an installed id
 * (`look.textures`); the render stages that texture's maps for Blender. Poly
 * Haven publishes every asset as CC0, so nothing here needs a license check.
 *
 * Files live machine-locally under data/photoreal-textures/<id>/ and are
 * re-downloadable, so a peer that lacks one renders that preset procedurally.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ServerError } from '../lib/errorHandler.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { ensureDir, PATHS, pathExists } from '../lib/fileUtils.js';
import { PHOTOREAL_TEXTURE_ID } from '../lib/photorealLook.js';

const API = 'https://api.polyhaven.com';
const DOWNLOAD_HOSTS = new Set(['dl.polyhaven.org']);
const TEXTURE_DIR = 'photoreal-textures';
const MAP_BYTES_MAX = 40 * 1024 * 1024;
const CATALOG_TTL_MS = 60 * 60 * 1000;
const RESULTS_MAX = 36;
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);
// Poly Haven asks API clients to name themselves.
const USER_AGENT = 'PortOS-photoreal-textures/1';

// The maps Blender reads, by the keys Poly Haven's files API may use for each.
export const TEXTURE_MAPS = Object.freeze({
  color: ['Diffuse', 'diffuse', 'Color'],
  roughness: ['Rough', 'rough', 'Roughness'],
  normal: ['nor_gl', 'Normal', 'normal'],
});

// Words that find a preset's textures in Poly Haven's names, tags and categories.
const PRESET_WORDS = {
  'wood-floor': ['wood', 'floor', 'plank', 'parquet', 'laminate'],
  'painted-wall': ['plaster', 'painted', 'paint', 'wall'],
  'painted-metal': ['metal', 'painted', 'steel'],
  carpet: ['carpet', 'rug', 'fabric'],
  tile: ['tile', 'tiles'],
  concrete: ['concrete', 'cement'],
  plastic: ['plastic'],
  vinyl: ['leather', 'vinyl'],
  fabric: ['fabric', 'cloth', 'textile'],
};

const deps = {
  fetch: (url, options, timeoutMs) => fetchWithTimeout(url, options, timeoutMs),
  root: () => join(PATHS.data, TEXTURE_DIR),
};
export const __setPhotorealTextureDepsForTests = (overrides) => {
  Object.assign(deps, overrides);
  catalog = null;
};

const refuse = (message, code, status = 400) => new ServerError(message, { status, code });
const textureDir = (id) => join(deps.root(), id);
const thumbnail = (id) => `https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?width=256&height=256`;

let catalog = null;

async function getJson(url) {
  const res = await deps.fetch(url, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } }, 20000)
    .catch((err) => { throw refuse(`Poly Haven could not be reached: ${err.message}`, 'PHOTOREAL_TEXTURES_OFFLINE', 502); });
  if (!res.ok) throw refuse(`Poly Haven answered ${res.status}.`, 'PHOTOREAL_TEXTURES_OFFLINE', 502);
  return res.json();
}

async function textureCatalog() {
  if (catalog && Date.now() - catalog.at < CATALOG_TTL_MS) return catalog.assets;
  const assets = await getJson(`${API}/assets?t=textures`);
  catalog = { at: Date.now(), assets: assets && typeof assets === 'object' ? assets : {} };
  return catalog.assets;
}

/** The installed textures, newest first. Disk reads only. */
export async function listInstalledTextures() {
  const names = await readdir(deps.root()).catch(() => []);
  const rows = await Promise.all(names.filter((name) => PHOTOREAL_TEXTURE_ID.test(name)).map(async (id) => {
    const meta = await readFile(join(textureDir(id), 'texture.json'), 'utf8').then(JSON.parse, () => null);
    return meta ? { id, name: meta.name, sizeM: meta.sizeM, thumbnail: thumbnail(id), installedAt: meta.installedAt } : null;
  }));
  return rows.filter(Boolean).sort((a, b) => (b.installedAt || '').localeCompare(a.installedAt || ''));
}

/** Poly Haven textures for a preset, best match first. Called when the user opens the picker. */
export async function searchTextures({ preset, query = '' }) {
  const words = PRESET_WORDS[preset];
  if (!words) throw refuse('That material has no photo textures.', 'PHOTOREAL_TEXTURE_PRESET');
  const needles = query.toLowerCase().split(/\s+/).filter(Boolean);
  const installed = new Set((await listInstalledTextures()).map((t) => t.id));
  const scored = Object.entries(await textureCatalog()).flatMap(([id, asset]) => {
    if (!PHOTOREAL_TEXTURE_ID.test(id)) return [];
    const text = [asset?.name, ...(asset?.tags || []), ...(asset?.categories || [])].join(' ').toLowerCase();
    if (needles.some((n) => !text.includes(n))) return [];
    const score = words.filter((w) => text.includes(w)).length + (text.includes(words[0]) ? 2 : 0);
    return needles.length || score >= 3 ? [{ id, name: asset?.name || id, score, downloads: asset?.download_count || 0 }] : [];
  });
  scored.sort((a, b) => b.score - a.score || b.downloads - a.downloads);
  return scored.slice(0, RESULTS_MAX).map(({ id, name }) => ({ id, name, thumbnail: thumbnail(id), installed: installed.has(id) }));
}

function pickMap(files, keys) {
  for (const key of keys) {
    const jpg = files?.[key]?.['2k']?.jpg;
    if (typeof jpg?.url === 'string') return { url: jpg.url, md5: typeof jpg.md5 === 'string' ? jpg.md5.toLowerCase() : null };
  }
  return null;
}

async function downloadMap({ url, md5 }) {
  let host;
  try { host = new URL(url).hostname; } catch { host = ''; }
  if (!DOWNLOAD_HOSTS.has(host)) throw refuse('Poly Haven pointed a texture at an unexpected host.', 'PHOTOREAL_TEXTURE_HOST', 502);
  const res = await deps.fetch(url, { headers: { 'User-Agent': USER_AGENT } }, 120000)
    .catch((err) => { throw refuse(`The texture download failed: ${err.message}`, 'PHOTOREAL_TEXTURES_OFFLINE', 502); });
  if (!res.ok) throw refuse(`The texture download answered ${res.status}.`, 'PHOTOREAL_TEXTURES_OFFLINE', 502);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAP_BYTES_MAX) throw refuse('A texture map is larger than expected.', 'PHOTOREAL_TEXTURE_TOO_LARGE', 502);
  if (!bytes.subarray(0, 3).equals(JPEG)) throw refuse('A texture map is not a JPEG.', 'PHOTOREAL_TEXTURE_INVALID', 502);
  if (md5 && createHash('md5').update(bytes).digest('hex') !== md5) throw refuse('A texture map did not match its published checksum.', 'PHOTOREAL_TEXTURE_INVALID', 502);
  return bytes;
}

const installing = new Map();

/** Download a texture's 2K maps once; repeat calls answer with the installed one. */
export function installTexture(id) {
  if (!PHOTOREAL_TEXTURE_ID.test(id)) return Promise.reject(refuse('Unknown texture.', 'PHOTOREAL_TEXTURE_ID'));
  if (!installing.has(id)) {
    installing.set(id, doInstall(id).finally(() => installing.delete(id)));
  }
  return installing.get(id);
}

async function doInstall(id) {
  const dir = textureDir(id);
  if (await pathExists(join(dir, 'texture.json'))) return (await listInstalledTextures()).find((t) => t.id === id);
  const [files, info] = await Promise.all([getJson(`${API}/files/${id}`), getJson(`${API}/info/${id}`)]);
  if (info?.type !== undefined && info.type !== 1) throw refuse('That Poly Haven asset is not a texture.', 'PHOTOREAL_TEXTURE_ID', 404);
  // Only the color map is required; an asset without roughness or normal still installs.
  const sources = Object.fromEntries(Object.entries(TEXTURE_MAPS).map(([map, keys]) => [map, pickMap(files, keys)]));
  if (!sources.color) throw refuse('That texture has no 2K color map.', 'PHOTOREAL_TEXTURE_INVALID', 404);
  const maps = await Promise.all(Object.entries(sources).filter(([, source]) => source).map(async ([map, source]) => [map, await downloadMap(source)]));
  // Real-world width in metres, so a plank is plank-sized; Poly Haven gives millimetres.
  const widthMm = Number(info?.dimensions?.[0]);
  const meta = {
    id, name: typeof info?.name === 'string' ? info.name.slice(0, 120) : id, license: 'CC0', source: `https://polyhaven.com/a/${id}`,
    sizeM: Number.isFinite(widthMm) && widthMm > 0 ? Math.min(50, widthMm / 1000) : 2,
    maps: maps.map(([map]) => map), installedAt: new Date().toISOString(),
  };
  const staging = `${dir}.partial`;
  await rm(staging, { recursive: true, force: true });
  await ensureDir(staging);
  for (const [map, bytes] of maps) await writeFile(join(staging, `${map}.jpg`), bytes);
  await writeFile(join(staging, 'texture.json'), JSON.stringify(meta));
  await rm(dir, { recursive: true, force: true });
  await rename(staging, dir);
  console.log(`🧱 Installed CC0 texture ${id} (${maps.length} maps) from Poly Haven`);
  return { id, name: meta.name, sizeM: meta.sizeM, thumbnail: thumbnail(id), installedAt: meta.installedAt };
}

/**
 * The worker files and Blender job entries for a look's textures. A texture not
 * installed here is left out, so that preset renders procedurally.
 */
export async function stagePhotorealTextures(textures = {}) {
  const files = [];
  const job = {};
  const missing = [];
  const staged = new Map();
  for (const [preset, id] of Object.entries(textures)) {
    if (!staged.has(id)) {
      const dir = textureDir(id);
      const meta = await readFile(join(dir, 'texture.json'), 'utf8').then(JSON.parse, () => null);
      const maps = {};
      for (const map of meta?.maps || []) {
        if (!(map in TEXTURE_MAPS)) continue;
        files.push({ path: `textures/${id}/${map}.jpg`, content: await readFile(join(dir, `${map}.jpg`)) });
        maps[map] = `textures/${id}/${map}.jpg`;
      }
      staged.set(id, maps.color ? { id, sizeM: meta.sizeM, maps } : null);
    }
    if (staged.get(id)) job[preset] = staged.get(id);
    else missing.push(id);
  }
  return { files, job, missing };
}
