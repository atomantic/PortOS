/**
 * Machine-local model deduplication. Scans only explicit model roots; never
 * publishes paths through federation or AI triage. Replacements require a
 * fresh full SHA-256 comparison, and preserve HF snapshot symlinks.
 */
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PATHS } from '../lib/paths.js';
import { sha256File } from '../lib/fileCore.js';
import { getHfCacheRoot } from '../lib/hfCache.js';
import { isPathInsideDir } from '../lib/pathSafety.js';
import { ServerError } from '../lib/errorHandler.js';

const MIN_BYTES = 10 * 1024 * 1024;
const WEIGHTS = new Set(['.safetensors', '.bin', '.pt', '.ckpt', '.gguf']);
const DRIVE_NAMES = ['mlx_models', 'checkpoints', 'loras', 'diffusers', 'models'];
const missing = (error) => {
  if (error.code === 'ENOENT') return null;
  throw error;
};
const invalid = (message) => new ServerError(message, { status: 400, code: 'VALIDATION_ERROR' });
const identity = (info) => `${info.dev}:${info.ino}`;
const unchanged = (a, b) => identity(a) === identity(b) && a.size === b.size
  && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

async function directories(root) {
  return (await fs.readdir(root, { withFileTypes: true }).catch(missing) || [])
    .filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
}

async function rootsForInstall() {
  const pinokio = resolve(process.env.PINOKIO_HOME || process.env.PINOKIO_PATH || join(homedir(), 'pinokio'));
  if (!(await fs.stat(pinokio).catch(missing))?.isDirectory()) return null;
  const peers = await directories(join(pinokio, 'drive', 'drives', 'peers'));
  const apps = await directories(join(pinokio, 'api'));
  const external = [
    ...DRIVE_NAMES.map((name) => join(pinokio, name)),
    ...peers.flatMap((peer) => DRIVE_NAMES.map((name) => join(peer, name))),
    ...apps.map((app) => join(app, 'models')),
    join(pinokio, 'cache', 'huggingface', 'hub'),
  ];
  // Named model mappings may point at drives outside Pinokio home.
  const manifest = await fs.readFile(join(pinokio, 'drive', 'drives.json'), 'utf8').catch(missing);
  const collectMappings = (value, key = '') => {
    if (typeof value === 'string' && DRIVE_NAMES.includes(key)) external.push(resolve(pinokio, value));
    else if (value && typeof value === 'object') {
      for (const [name, child] of Object.entries(value)) collectMappings(child, name);
    }
  };
  if (manifest) collectMappings(JSON.parse(manifest));
  const { getModelsDir } = await import('./lmStudioManager.js');
  const local = [getHfCacheRoot(), PATHS.loras, await getModelsDir()];
  const canonicalRoots = async (roots) => [...new Set((await Promise.all(
    roots.map((root) => fs.realpath(root).catch(missing)),
  )).filter(Boolean))];
  return { local: await canonicalRoots(local), external: await canonicalRoots(external) };
}

async function inventory(roots) {
  const files = [];
  const visited = new Set();
  let count = 0;
  const walk = async (path, depth) => {
    if (++count > 50000 || depth > 16) throw invalid('Model scan limit reached; narrow the model roots and retry.');
    const real = await fs.realpath(path).catch(missing);
    if (!real || !roots.some((root) => real === root || isPathInsideDir(root, real))) return;
    const info = await fs.stat(real).catch(missing);
    if (!info) return;
    if (info.isDirectory()) {
      if (visited.has(real)) return;
      visited.add(real);
      for (const entry of await fs.readdir(real)) await walk(join(path, entry), depth + 1);
    } else if (info.isFile() && info.size >= MIN_BYTES && WEIGHTS.has(extname(path).toLowerCase())) {
      files.push({ path, real, info, name: basename(path), model: basename(dirname(path)) });
    }
  };
  for (const root of roots) await walk(root, 0);
  return files;
}

export async function scanModelDuplicates({ roots } = {}) {
  roots ??= await rootsForInstall();
  if (!roots) return { pinokioDetected: false, items: [], totalReclaimableBytes: 0 };
  const local = await inventory(roots.local);
  const external = await inventory(roots.external);
  const hashes = new Map();
  const hash = (file) => {
    const key = identity(file.info);
    if (!hashes.has(key)) hashes.set(key, sha256File(file.real));
    return hashes.get(key);
  };
  const items = [];
  const seen = new Set();
  for (const target of external) {
    if (seen.has(target.real)) continue;
    for (const source of local) {
      if (source.info.size !== target.info.size || source.name !== target.name) continue;
      const alreadyLinked = identity(source.info) === identity(target.info);
      if (!alreadyLinked && await hash(source) !== await hash(target)) continue;
      // A target with other hardlink names cannot release blocks by replacing
      // this single name. Leave those aliases untouched and report zero savings.
      const reclaimableBytes = alreadyLinked || target.info.nlink > 1 ? 0 : target.info.blocks * 512;
      items.push({
        sourcePath: source.path, targetPath: target.path, model: target.model,
        sizeBytes: target.info.size, reclaimableBytes, alreadyLinked,
        canLink: !alreadyLinked && target.info.nlink === 1 && source.info.dev === target.info.dev
          && source.info.mode === target.info.mode && source.info.uid === target.info.uid && source.info.gid === target.info.gid,
      });
      seen.add(target.real);
      break;
    }
  }
  return { pinokioDetected: true, items, totalReclaimableBytes: items.reduce((sum, item) => sum + (item.canLink ? item.reclaimableBytes : 0), 0) };
}

async function validatedFile(path, roots) {
  if (!WEIGHTS.has(extname(path).toLowerCase()) || !roots.some((root) => isPathInsideDir(root, resolve(path)))) {
    throw invalid('File is outside the allowed model roots.');
  }
  const real = await fs.realpath(path).catch(missing);
  if (!real || !roots.some((root) => isPathInsideDir(root, real))) throw invalid('Unsafe or missing model link.');
  const info = await fs.stat(real);
  if (!info.isFile() || info.size < MIN_BYTES) throw invalid('Expected a model weight file of at least 10 MB.');
  return { path, real, info };
}

let rectifying = false;
export async function rectifyModelDuplicates(pairs, { roots } = {}) {
  if (rectifying) throw new ServerError('Model linking is already running.', { status: 409 });
  rectifying = true;
  return performRectification(pairs, roots).finally(() => { rectifying = false; });
}

async function performRectification(pairs, roots) {
  roots ??= await rootsForInstall();
  if (!roots) throw invalid('Pinokio is not installed.');
  const results = [];
  // Validate the entire batch before making its first replacement.
  const prepared = [];
  const targets = new Set();
  for (const pair of pairs) {
    const source = await validatedFile(pair.sourcePath, roots.local);
    const target = await validatedFile(pair.targetPath, roots.external);
    if (targets.has(target.real)) continue;
    targets.add(target.real);
    if (identity(source.info) === identity(target.info)) continue;
    if (target.info.nlink !== 1) throw invalid('Target has additional hardlinks; no space can be reclaimed safely.');
    if (source.info.mode !== target.info.mode || source.info.uid !== target.info.uid || source.info.gid !== target.info.gid) {
      throw invalid('File permissions or ownership differ; linking would change application access.');
    }
    if (source.info.dev !== target.info.dev) throw invalid('Hardlinks cannot span filesystems.');
    if (source.info.size !== target.info.size || await sha256File(source.real) !== await sha256File(target.real)) {
      throw invalid('Model contents differ; no files were linked.');
    }
    prepared.push({ source, target });
  }
  // No batch may replace a canonical source used by another pair.
  if (prepared.some(({ source }) => targets.has(source.real))) throw invalid('Overlapping source and target paths.');
  const sourceStates = new Map();
  for (const { source, target } of prepared) {
    const sourceNow = await fs.stat(source.real);
    const targetNow = await fs.stat(target.real);
    if (!unchanged(sourceStates.get(source.real) || source.info, sourceNow) || !unchanged(target.info, targetNow)
      || await fs.realpath(source.path) !== source.real || await fs.realpath(target.path) !== target.real) {
      throw invalid('Model changed since verification; rescan before linking.');
    }
    const temporary = join(dirname(target.real), `.portos-link-${randomUUID()}`);
    await fs.link(source.real, temporary);
    await fs.rename(temporary, target.real).catch(async (error) => {
      await fs.unlink(temporary);
      throw error;
    });
    sourceStates.set(source.real, await fs.stat(source.real));
    results.push({ ...pairs.find((pair) => pair.targetPath === target.path), reclaimedBytes: target.info.blocks * 512 });
  }
  return { success: true, reclaimedBytes: results.reduce((sum, result) => sum + result.reclaimedBytes, 0), results };
}
