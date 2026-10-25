import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

const ROOTS = ['node_modules', 'server/node_modules', 'client/node_modules', 'autofixer/node_modules'];
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const unavailable = error => {
  if (error.archiveLimit || error.message === 'retirement-archive-cancelled') throw error;
  return null;
};
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const safePath = value => typeof value === 'string' && value.length > 0 && !value.startsWith('/')
  && !value.includes('\\') && !value.includes('\0') && value.split('/').every(part => part && part !== '.' && part !== '..');

const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW || 0);
async function regularBytes(path, limit, work) {
  const before = await lstat(path);
  if (!before.isFile() || before.size > limit || await realpath(path) !== resolve(path)) throw new Error('npm-proof-file-invalid');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of createReadStream(path, { flags: READ_FLAGS })) {
    work?.check();
    bytes += chunk.length;
    if (bytes > before.size || bytes > limit) throw new Error('npm-proof-file-changed');
    chunks.push(chunk);
  }
  if (bytes !== before.size || !same(before, await lstat(path))) throw new Error('npm-proof-file-changed');
  return Buffer.concat(chunks, bytes);
}

/** Read only plain regular npm tar members. Never extract paths or follow links.
 * Unsupported tar extensions intentionally refuse recognition instead of guessing.
 */
function npmTarballFiles(compressed, integrity, work) {
  if (compressed.length > MAX_CACHE_BYTES || typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) throw new Error('npm-tarball-integrity-invalid');
  const digest = Buffer.from(integrity.slice(7), 'base64');
  if (digest.length !== 64 || createHash('sha512').update(compressed).digest('base64') !== integrity.slice(7)) throw new Error('npm-tarball-integrity-invalid');
  const bytes = gunzipSync(compressed, { maxOutputLength: MAX_CACHE_BYTES });
  const files = new Map();
  let offset = 0;
  const octal = field => {
    const value = field.toString('ascii').replace(/\0.*$/, '').trim();
    if (!/^[0-7]+$/.test(value)) throw new Error('npm-tar-header-invalid');
    return parseInt(value, 8);
  };
  const text = field => field.toString('utf8').replace(/\0.*$/, '');
  while (offset + 512 <= bytes.length) {
    work?.check();
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (!bytes.subarray(offset).every(byte => byte === 0)) throw new Error('npm-tar-trailing-content');
      return files;
    }
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== octal(header.subarray(148, 156))) throw new Error('npm-tar-checksum-invalid');
    const prefix = text(header.subarray(345, 500));
    const name = [prefix, text(header.subarray(0, 100))].filter(Boolean).join('/').replace(/\/$/, '');
    if (!safePath(name) || !name.startsWith('package/')) throw new Error('npm-tar-path-invalid');
    const size = octal(header.subarray(124, 136));
    const type = header[156];
    offset += 512;
    if (size > MAX_CACHE_BYTES || offset + size > bytes.length || ![0, 48, 53].includes(type)) throw new Error('npm-tar-member-invalid');
    if (type === 53) {
      if (size !== 0) throw new Error('npm-tar-directory-invalid');
    } else {
      const path = name.slice(8);
      if (files.has(path)) throw new Error('npm-tar-duplicate-member');
      const proof = { bytes: size, sha256: hash(bytes.subarray(offset, offset + size)) };
      work?.add({ path, ...proof });
      files.set(path, proof);
    }
    offset += Math.ceil(size / 512) * 512;
  }
  throw new Error('npm-tar-end-missing');
}

async function fileHash(path, work) {
  const before = await lstat(path);
  if (!before.isFile() || await realpath(path) !== resolve(path)) throw new Error('npm-file-unverified');
  const digest = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path, { flags: READ_FLAGS })) {
    work.check();
    bytes += chunk.length;
    if (bytes > before.size) throw new Error('npm-file-changed');
    digest.update(chunk);
  }
  if (bytes !== before.size || !same(before, await lstat(path))) throw new Error('npm-file-changed');
  return { bytes, sha256: digest.digest('hex') };
}

async function packageMatches(root, files, work) {
  let seen = 0;
  const pending = [{ path: root, prefix: '' }];
  while (pending.length) {
    work.check();
    const { path, prefix } = pending.pop();
    if (!(await lstat(path)).isDirectory() || await realpath(path) !== resolve(path)) return false;
    const directory = await opendir(path);
    for await (const entry of directory) {
      work.check();
      const rel = prefix + entry.name;
      if (entry.isDirectory()) pending.push({ path: join(path, entry.name), prefix: `${rel}/` });
      else {
        const expected = files.get(rel);
        if (!entry.isFile() || !expected || ++seen > files.size) return false;
        const actual = await fileHash(join(path, entry.name), work);
        if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) return false;
      }
    }
  }
  return seen === files.size;
}

function npmRegistryArtifact(entry) {
  try {
    const url = new URL(entry.resolved);
    return url.protocol === 'https:' && url.hostname === 'registry.npmjs.org'
      && !url.username && !url.password && !url.search && !url.hash && url.pathname.endsWith('.tgz');
  } catch { return false; }
}

function hiddenLockMatches(hidden, locked) {
  return record(hidden) && record(hidden.packages) && hidden.lockfileVersion === 3 && hidden.requires === true
    && hidden.name === locked.name && hidden.version === locked.version
    && Object.keys(hidden).every(key => ['name', 'version', 'lockfileVersion', 'requires', 'packages'].includes(key))
    && Object.entries(hidden.packages).every(([path, entry]) => record(entry) && record(locked.packages?.[path])
      && Object.entries(entry).every(([key, value]) => key === 'hasInstallScript' && typeof value === 'boolean'
        || JSON.stringify(value) === JSON.stringify(locked.packages[path][key])));
}

/** Only duplicates of the protected primary install or exact lock-pinned cached
 * package bytes are disposable. A lockfile alone never proves local file bytes.
 * All observations are transaction-local; no persistent approval marker exists.
 */
export function createNpmRetirementVerifier(checkout, primary, work, { cacheRoot = process.env.npm_config_cache || join(homedir(), '.npm') } = {}) {
  const workspaces = new Map();
  const packages = new Map();
  const workspace = root => {
    if (!workspaces.has(root)) workspaces.set(root, (async () => {
      if (!primary) return null;
      const [checkoutRoot, primaryRoot] = await Promise.all([realpath(checkout), realpath(primary)]);
      if (checkoutRoot === primaryRoot) return null;
      const prefix = root === 'node_modules' ? '' : dirname(root);
      for (const name of ['package.json', 'package-lock.json']) {
        const [a, b] = await Promise.all([regularBytes(join(checkoutRoot, prefix, name), MAX_CACHE_BYTES, work), regularBytes(join(primaryRoot, prefix, name), MAX_CACHE_BYTES, work)]);
        if (!a.equals(b)) return null;
      }
      const locked = JSON.parse((await regularBytes(join(checkoutRoot, prefix, 'package-lock.json'), MAX_CACHE_BYTES, work)).toString('utf8'));
      const hiddenBytes = await regularBytes(join(checkoutRoot, root, '.package-lock.json'), MAX_CACHE_BYTES, work);
      const hidden = JSON.parse(hiddenBytes.toString('utf8'));
      return hiddenLockMatches(hidden, locked) ? { locked, hidden, hiddenSha256: hash(hiddenBytes), prefix, checkoutRoot, primaryRoot } : null;
    })().catch(unavailable));
    return workspaces.get(root);
  };
  return async rel => {
    if (!safePath(rel)) return false;
    const root = ROOTS.find(value => rel.startsWith(`${value}/`));
    if (!root) return false;
    const proof = await workspace(root);
    if (!proof) return false;
    const actual = await fileHash(join(proof.checkoutRoot, rel), work);
    if (rel === `${root}/.package-lock.json`) return actual.sha256 === proof.hiddenSha256;
    const counterpart = await fileHash(join(proof.primaryRoot, rel), work).catch(() => null);
    if (counterpart?.bytes === actual.bytes && counterpart.sha256 === actual.sha256) return true;
    const local = proof.prefix ? rel.slice(proof.prefix.length + 1) : rel;
    const name = Object.keys(proof.hidden.packages).filter(path => local.startsWith(`${path}/`)).sort((a, b) => b.length - a.length)[0];
    const entry = proof.locked.packages?.[name];
    if (!entry?.integrity || !npmRegistryArtifact(entry) || entry.hasInstallScript || proof.hidden.packages[name].hasInstallScript) return false;
    const key = `${root}:${name}`;
    if (!packages.has(key)) packages.set(key, (async () => {
      const digest = Buffer.from(entry.integrity.replace(/^sha512-/, ''), 'base64');
      if (!entry.integrity.startsWith('sha512-') || digest.length !== 64) return null;
      const hex = digest.toString('hex');
      const files = npmTarballFiles(await regularBytes(join(await realpath(cacheRoot), '_cacache/content-v2/sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4)), MAX_CACHE_BYTES, work), entry.integrity, work);
      return await packageMatches(join(proof.checkoutRoot, proof.prefix, name), files, work) ? files : null;
    })().catch(unavailable));
    const expected = (await packages.get(key))?.get(local.slice(name.length + 1));
    return expected?.bytes === actual.bytes && expected.sha256 === actual.sha256;
  };
}
