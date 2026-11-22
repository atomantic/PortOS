/**
 * Machine-local model deduplication. Scans only explicit model roots; never
 * publishes paths through federation or AI triage. Replacements require a
 * fresh full SHA-256 comparison, and preserve HF snapshot symlinks.
 *
 * Two separate repairs:
 * - Pinokio copies of a local weight are hardlinked (same inode).
 * - Identical Hugging Face hub blobs (models--* / blobs / 64-hex name) are replaced
 *   with copy-on-write clones. Hardlinks are refused there: deleting or
 *   rewriting one repo must not free or change another repo's blob. Where
 *   clones are unavailable the scan reports the pair and zero savings.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { spawn } from '../lib/childProcess.js';
import { parseFilesystemStats, sha256File } from '../lib/fileCore.js';
import { ServerError } from '../lib/errorHandler.js';
import { getHfCacheRoot } from '../lib/hfCache.js';
import { isPathInsideDir } from '../lib/pathSafety.js';
import { PATHS } from '../lib/paths.js';

const MIN_BYTES = 10 * 1024 * 1024;
// Hub blobs below this are tokenizer/config noise, not the duplicated weights.
export const HUB_MIN_BYTES = 50 * 1024 * 1024;
const BLOB_NAME = /^[0-9a-f]{64}$/;
const WEIGHTS = new Set(['.safetensors', '.bin', '.pt', '.ckpt', '.gguf']);
const DRIVE_NAMES = ['mlx_models', 'checkpoints', 'loras', 'diffusers', 'models'];
const APPARENT_SIZE_NOTE = 'Finder and du count each clone at its full size. Physical bytes reclaimed are the free-space change measured while clones are applied.';
const CLONES_UNAVAILABLE = 'Copy-on-write clones are unavailable on this filesystem.';
// Node's COPYFILE_FICLONE_FORCE returns ENOSYS on macOS (copyfile(2) is not
// wired to clonefile). `cp -c` is clonefile(2) and fails instead of falling
// back to a full copy. Linux uses a reflink that likewise fails closed.
const EXTENT_HELPER_VERSION = 'v1';
// ATTR_CMNEXT_* live in forkattr and are ignored unless FSOPT_ATTR_CMN_EXTENDED
// is set. private size is the bytes freed by unlinking that one name; clone id
// groups files that already share extents. A wrong field (commonattr) returns
// a constant and cannot tell a clone from an independent copy.
const EXTENT_HELPER_SOURCE = `#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>
#include <sys/attr.h>
int main(int argc, char **argv) {
  for (int i = 1; i < argc; i++) {
    struct attrlist attr;
    memset(&attr, 0, sizeof(attr));
    attr.bitmapcount = ATTR_BIT_MAP_COUNT;
    attr.forkattr = ATTR_CMNEXT_PRIVATESIZE | ATTR_CMNEXT_CLONEID | ATTR_CMNEXT_CLONE_REFCNT;
    struct __attribute__((packed)) {
      uint32_t length;
      int64_t privatesize;
      uint64_t cloneid;
      uint32_t refcnt;
    } buf;
    memset(&buf, 0, sizeof(buf));
    if (getattrlist(argv[i], &attr, &buf, sizeof(buf), FSOPT_ATTR_CMN_EXTENDED) != 0 || buf.length < 24) {
      printf("na\\n");
      continue;
    }
    printf("%lld %llu %u\\n", (long long)buf.privatesize, (unsigned long long)buf.cloneid, buf.refcnt);
  }
  return 0;
}
`;
const missing = (error) => {
  if (error.code === 'ENOENT') return null;
  throw error;
};
const invalid = (message) => new ServerError(message, { status: 400, code: 'VALIDATION_ERROR' });
// File identifiers can exceed Number's exact integer range on Windows.
// Keep stats exact internally; convert only user-facing sizes to numbers.
const identity = (info) => `${info.dev}:${info.ino}`;
const unchanged = (a, b) => identity(a) === identity(b) && a.size === b.size
  && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

function emptyHub(cloneSupported = false) {
  return {
    cloneSupported,
    apparentSizeNote: APPARENT_SIZE_NOTE,
    groups: [],
    totalReclaimableBytes: 0,
  };
}

function runCommand(command, args, { input, capture } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: [input ? 'pipe' : 'ignore', capture ? 'pipe' : 'ignore', 'ignore'],
    });
    const chunks = [];
    if (capture) child.stdout.on('data', (chunk) => chunks.push(chunk));
    const timer = setTimeout(() => child.kill(), 120000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(capture ? Buffer.concat(chunks).toString('utf8') : '');
      else reject(new Error(`${command} failed`));
    });
    if (input) child.stdin.end(input);
  });
}

function cloneArgs(source, destination) {
  if (process.platform === 'darwin') return ['-c', source, destination];
  if (process.platform === 'linux') return ['--reflink=always', source, destination];
  return null;
}

async function cloneFile(source, destination) {
  const args = cloneArgs(source, destination);
  if (!args) throw invalid(CLONES_UNAVAILABLE);
  try {
    await runCommand('cp', args);
  } catch {
    throw invalid(CLONES_UNAVAILABLE);
  }
}

let extentHelperPromise;
function extentHelperPath() {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  extentHelperPromise ??= (async () => {
    const binary = join(tmpdir(), `portos-apfs-extent-${EXTENT_HELPER_VERSION}`);
    if (await fs.access(binary).then(() => true, () => false)) return binary;
    try {
      await runCommand('cc', ['-O2', '-x', 'c', '-o', binary, '-'], { input: EXTENT_HELPER_SOURCE });
      return binary;
    } catch {
      return null;
    }
  })();
  return extentHelperPromise;
}

// Map of path -> { privateBytes, cloneId } or null when this platform cannot
// see APFS clone families. privateBytes is the space unlinking that name frees.
async function readExtents(paths) {
  const binary = await extentHelperPath();
  if (!binary || !paths.length) return null;
  const extents = new Map();
  for (let offset = 0; offset < paths.length; offset += 64) {
    const batch = paths.slice(offset, offset + 64);
    let text;
    try {
      text = await runCommand(binary, batch, { capture: true });
    } catch {
      return null;
    }
    const lines = text.trim().split('\n');
    batch.forEach((path, index) => {
      const line = lines[index];
      if (!line || line === 'na') return;
      const [priv, cloneId] = line.split(' ');
      const privateBytes = Number(priv);
      if (!cloneId || !Number.isSafeInteger(privateBytes) || privateBytes < 0) return;
      extents.set(path, { privateBytes, cloneId });
    });
  }
  return extents;
}

async function probeClone(root) {
  const args = cloneArgs(join(root, 'probe-source'), join(root, 'probe-dest'));
  if (!args) return false;
  const token = randomUUID();
  const source = join(root, `.portos-clone-probe-${token}`);
  const destination = join(root, `.portos-clone-probe-${token}-copy`);
  try {
    await fs.writeFile(source, Buffer.alloc(4096, 1));
    await runCommand('cp', cloneArgs(source, destination));
    return true;
  } catch {
    return false;
  } finally {
    await fs.unlink(source).catch(() => {});
    await fs.unlink(destination).catch(() => {});
  }
}

async function freeBytes(path) {
  const stats = await fs.statfs(path).catch(() => null);
  return parseFilesystemStats(stats)?.freeBytes ?? null;
}

function blobLocation(path) {
  const blobsDir = dirname(path);
  if (basename(blobsDir) !== 'blobs') return null;
  const repo = basename(dirname(blobsDir));
  if (!repo.startsWith('models--')) return null;
  if (!BLOB_NAME.test(basename(path))) return null;
  return { repo, repoDir: dirname(blobsDir), blobsDir };
}

async function repoHasIncomplete(repoDir) {
  const names = await fs.readdir(join(repoDir, 'blobs')).catch(missing);
  return Boolean(names?.some((name) => name.endsWith('.incomplete')));
}

function buildHubGroup(files, cloneSupported) {
  const sorted = [...files].sort((left, right) => left.repo.localeCompare(right.repo) || left.path.localeCompare(right.path));
  const families = new Map();
  for (const file of sorted) {
    const key = file.extent?.cloneId ?? `solo:${file.path}`;
    const list = families.get(key) || [];
    list.push(file);
    families.set(key, list);
  }
  let canonical = families.values().next().value;
  for (const list of families.values()) {
    const betterCount = list.length > canonical.length;
    const sameCountEarlier = list.length === canonical.length && list[0].repo < canonical[0].repo;
    if (betterCount || sameCountEarlier) canonical = list;
  }
  const source = canonical[0];
  const keep = new Set(canonical.map((file) => file.path));
  const replacements = [];
  for (const file of sorted) {
    if (keep.has(file.path) || identity(file.info) === identity(source.info)) continue;
    if (file.info.nlink > 1n && file.extent?.privateBytes == null) continue;
    const reclaimableBytes = file.extent?.privateBytes ?? file.sizeBytes;
    if (!cloneSupported || reclaimableBytes <= 0) continue;
    replacements.push({ repo: file.repo, path: file.path, reclaimableBytes });
  }
  const repos = [...new Set(sorted.map((file) => file.repo))].sort();
  const reclaimableBytes = replacements.reduce((sum, item) => sum + item.reclaimableBytes, 0);
  if (cloneSupported && replacements.length === 0) return null;
  return {
    blobName: source.blobName,
    sizeBytes: source.sizeBytes,
    repos,
    logicalDuplicateBytes: (sorted.length - 1) * source.sizeBytes,
    reclaimableBytes: cloneSupported ? reclaimableBytes : 0,
    canClone: cloneSupported && replacements.length > 0,
    reason: cloneSupported ? null : 'clones-unavailable',
    sourcePath: source.path,
    replacements: cloneSupported ? replacements : [],
  };
}

async function scanHubDuplicates({ hubRoot, minBytes = HUB_MIN_BYTES } = {}) {
  const root = hubRoot || getHfCacheRoot();
  const realRoot = await fs.realpath(root).catch(missing);
  if (!realRoot) return emptyHub();
  const entries = await fs.readdir(realRoot, { withFileTypes: true }).catch(missing) || [];
  const files = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('models--')) continue;
    const repoDir = join(realRoot, entry.name);
    const realRepo = await fs.realpath(repoDir).catch(missing);
    if (!realRepo || !isPathInsideDir(realRoot, realRepo)) continue;
    if (await repoHasIncomplete(realRepo)) continue;
    const blobsDir = join(realRepo, 'blobs');
    const names = await fs.readdir(blobsDir).catch(missing) || [];
    for (const name of names) {
      if (!BLOB_NAME.test(name)) continue;
      const path = join(blobsDir, name);
      const listed = await fs.lstat(path).catch(missing);
      if (!listed?.isFile()) continue;
      if (listed.size < minBytes) continue;
      if (files.length > 20000) throw invalid('Hub blob scan limit reached.');
      const info = await fs.stat(path, { bigint: true });
      files.push({
        path, repo: entry.name, blobName: name, sizeBytes: Number(info.size), info, extent: null,
      });
    }
  }
  const byName = new Map();
  for (const file of files) {
    const key = `${file.blobName}:${file.sizeBytes}`;
    const list = byName.get(key) || [];
    list.push(file);
    byName.set(key, list);
  }
  const duplicateSets = [...byName.values()].filter((list) => list.length > 1);
  if (!duplicateSets.length) return emptyHub();
  const cloneSupported = await probeClone(realRoot);
  const hashes = new Map();
  const hashOf = (file) => {
    const key = identity(file.info);
    if (!hashes.has(key)) hashes.set(key, sha256File(file.path));
    return hashes.get(key);
  };
  const verified = new Map();
  for (const set of duplicateSets) {
    for (const file of set) {
      const hash = await hashOf(file);
      const key = `${file.blobName}:${hash}`;
      const list = verified.get(key) || [];
      list.push(file);
      verified.set(key, list);
    }
  }
  const groupsIn = [...verified.values()].filter((list) => list.length > 1);
  if (cloneSupported) {
    const extents = await readExtents(groupsIn.flatMap((list) => list.map((file) => file.path)));
    if (extents) {
      for (const list of groupsIn) {
        for (const file of list) file.extent = extents.get(file.path) || null;
      }
    }
  }
  const groups = groupsIn.map((list) => buildHubGroup(list, cloneSupported)).filter(Boolean)
    .sort((left, right) => left.blobName.localeCompare(right.blobName));
  return {
    cloneSupported,
    apparentSizeNote: APPARENT_SIZE_NOTE,
    groups,
    totalReclaimableBytes: groups.reduce((sum, group) => sum + (group.canClone ? group.reclaimableBytes : 0), 0),
  };
}

async function directories(root) {
  return (await fs.readdir(root, { withFileTypes: true }).catch(missing) || [])
    .filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
}

async function rootsForInstall() {
  const pinokio = resolve(process.env.PINOKIO_HOME || process.env.PINOKIO_PATH || join(homedir(), 'pinokio'));
  if (!(await fs.stat(pinokio, { bigint: true }).catch(missing))?.isDirectory()) return null;
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
    const info = await fs.stat(real, { bigint: true }).catch(missing);
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

export async function scanModelDuplicates({ roots, hubRoot, minHubBytes } = {}) {
  let hub;
  try {
    hub = await scanHubDuplicates({ hubRoot, minBytes: minHubBytes });
  } catch (error) {
    console.error(`❌ Hub blob duplicate scan failed (${error.code || error.name || 'error'})`);
    hub = {
      ...emptyHub(),
      error: error?.code === 'VALIDATION_ERROR' ? error.message : 'Hugging Face blob scan failed',
    };
  }
  if (roots === undefined) roots = await rootsForInstall();
  if (!roots) return { pinokioDetected: false, items: [], totalReclaimableBytes: 0, hub };
  const local = await inventory(roots.local);
  const external = await inventory(roots.external);
  const candidates = new Map();
  for (const file of local) {
    const key = `${file.name}:${file.info.size}`;
    if (!candidates.has(key)) candidates.set(key, []);
    candidates.get(key).push(file);
  }
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
    for (const source of candidates.get(`${target.name}:${target.info.size}`) || []) {
      const alreadyLinked = identity(source.info) === identity(target.info);
      if (!alreadyLinked && await hash(source) !== await hash(target)) continue;
      // A target with other hardlink names cannot release blocks by replacing
      // this single name. Leave those aliases untouched and report zero savings.
      const reclaimableBytes = alreadyLinked || target.info.nlink > 1n ? 0 : Number(target.info.blocks) * 512;
      items.push({
        sourcePath: source.path, targetPath: target.path, model: target.model,
        sizeBytes: Number(target.info.size), reclaimableBytes, alreadyLinked,
        canLink: !alreadyLinked && target.info.nlink === 1n && source.info.dev === target.info.dev
          && source.info.mode === target.info.mode && source.info.uid === target.info.uid && source.info.gid === target.info.gid,
      });
      seen.add(target.real);
      break;
    }
  }
  return {
    pinokioDetected: true,
    items,
    totalReclaimableBytes: items.reduce((sum, item) => sum + (item.canLink ? item.reclaimableBytes : 0), 0),
    hub,
  };
}

async function validatedFile(path, roots) {
  if (!WEIGHTS.has(extname(path).toLowerCase()) || !roots.some((root) => isPathInsideDir(root, resolve(path)))) {
    throw invalid('File is outside the allowed model roots.');
  }
  const real = await fs.realpath(path).catch(missing);
  if (!real || !roots.some((root) => isPathInsideDir(root, real))) throw invalid('Unsafe or missing model link.');
  const info = await fs.stat(real, { bigint: true });
  if (!info.isFile() || info.size < MIN_BYTES) throw invalid('Expected a model weight file of at least 10 MB.');
  return { path, real, info };
}

async function validatedBlob(path, hubRoot, minBytes) {
  const resolved = resolve(path);
  if (!isPathInsideDir(hubRoot, resolved)) throw invalid('File is outside the Hugging Face hub cache.');
  const listed = await fs.lstat(resolved).catch(missing);
  if (!listed) throw invalid('Unsafe or missing hub blob.');
  if (listed.isSymbolicLink()) throw invalid('Refusing to change a snapshot link.');
  if (!listed.isFile()) throw invalid('Expected a hub blob file.');
  const location = blobLocation(resolved);
  if (!location) throw invalid('Expected a hub blob file.');
  const real = await fs.realpath(resolved).catch(missing);
  const realRepo = await fs.realpath(location.repoDir).catch(missing);
  if (!real || !realRepo || !isPathInsideDir(hubRoot, real) || !isPathInsideDir(realRepo, real)) {
    throw invalid('Unsafe or missing hub blob.');
  }
  if (await repoHasIncomplete(realRepo)) throw invalid('A download is in progress in this repo; no files were replaced.');
  const info = await fs.stat(real, { bigint: true });
  if (!info.isFile() || info.size < BigInt(minBytes)) throw invalid('Expected a hub blob of at least 50 MB.');
  return { path: resolved, real, info, repo: location.repo, repoDir: realRepo };
}

let rectifying = false;
export async function rectifyModelDuplicates(pairs, options = {}) {
  if (rectifying) throw new ServerError('Model linking is already running.', { status: 409 });
  rectifying = true;
  const run = options.mode === 'clone'
    ? performHubClone(pairs, options)
    : performRectification(pairs, options.roots);
  return run.finally(() => { rectifying = false; });
}

async function performHubClone(pairs, { hubRoot, minBytes = HUB_MIN_BYTES } = {}) {
  const root = await fs.realpath(hubRoot || getHfCacheRoot()).catch(missing);
  if (!root) throw invalid('Hugging Face hub cache is not available.');
  const prepared = [];
  const targets = new Set();
  for (const pair of pairs || []) {
    const source = await validatedBlob(pair.sourcePath, root, minBytes);
    const target = await validatedBlob(pair.targetPath, root, minBytes);
    if (targets.has(target.real)) continue;
    targets.add(target.real);
    if (identity(source.info) === identity(target.info)) continue;
    if (source.info.dev !== target.info.dev) throw invalid('Copy-on-write clones cannot span filesystems.');
    if (source.info.size !== target.info.size || await sha256File(source.real) !== await sha256File(target.real)) {
      throw invalid('Blob contents differ; no files were replaced.');
    }
    prepared.push({ source, target, requested: pair });
  }
  if (prepared.some(({ source }) => targets.has(source.real))) throw invalid('Overlapping source and target paths.');
  if (!prepared.length) {
    return { success: true, reclaimedBytes: 0, physicalReclaimedBytes: 0, apparentSizeNote: APPARENT_SIZE_NOTE, results: [] };
  }
  if (!(await probeClone(root))) throw invalid(CLONES_UNAVAILABLE);
  const before = await freeBytes(root);
  const results = [];
  for (const { source, target, requested } of prepared) {
    const sourceNow = await fs.stat(source.real, { bigint: true });
    const targetNow = await fs.stat(target.real, { bigint: true });
    if (!unchanged(source.info, sourceNow) || !unchanged(target.info, targetNow)) {
      throw invalid('Blob changed since verification; rescan before cloning.');
    }
    if (await repoHasIncomplete(source.repoDir) || await repoHasIncomplete(target.repoDir)) {
      throw invalid('A download is in progress in this repo; no files were replaced.');
    }
    const temporary = join(dirname(target.real), `.portos-clone-${randomUUID()}`);
    try {
      await cloneFile(source.real, temporary);
      await fs.rename(temporary, target.real);
    } catch (error) {
      await fs.unlink(temporary).catch(() => {});
      throw error;
    }
    const extents = await readExtents([source.real, target.real]);
    const sharedStorage = extents
      ? extents.get(source.real)?.cloneId != null && extents.get(source.real).cloneId === extents.get(target.real)?.cloneId
      : null;
    if (sharedStorage === false) {
      console.warn('⚠️ Hub blob clone did not share storage; the duplicate was replaced but may still use its own blocks');
    }
    results.push({
      sourcePath: requested.sourcePath,
      targetPath: requested.targetPath,
      reclaimedBytes: Number(target.info.size),
      sharedStorage,
    });
  }
  const after = await freeBytes(root);
  const physicalReclaimedBytes = before != null && after != null && after >= before ? after - before : null;
  if (results.length) {
    console.log(`♻️ Cloned ${results.length} duplicate Hugging Face blobs; physical free space delta ${physicalReclaimedBytes ?? 'unmeasured'} bytes`);
  }
  return {
    success: true,
    reclaimedBytes: results.reduce((sum, result) => sum + result.reclaimedBytes, 0),
    physicalReclaimedBytes,
    apparentSizeNote: APPARENT_SIZE_NOTE,
    results,
  };
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
    if (target.info.nlink !== 1n) throw invalid('Target has additional hardlinks; no space can be reclaimed safely.');
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
    const sourceNow = await fs.stat(source.real, { bigint: true });
    const targetNow = await fs.stat(target.real, { bigint: true });
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
    sourceStates.set(source.real, await fs.stat(source.real, { bigint: true }));
    results.push({ ...pairs.find((pair) => pair.targetPath === target.path), reclaimedBytes: Number(target.info.blocks) * 512 });
  }
  return { success: true, reclaimedBytes: results.reduce((sum, result) => sum + result.reclaimedBytes, 0), results };
}
