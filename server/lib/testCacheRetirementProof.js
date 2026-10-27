import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { WORKSPACE_TEST_CACHE_ROOTS } from './workspaceTestCacheRoots.js';

export const VITEST_CACHE_TAG = 'Signature: 8a477f597d28d172789f06886806bc55\n# This file is a cache directory tag created by Vitest.';
export const VITEST_MODULE_CACHE_ROOTS = Object.values(WORKSPACE_TEST_CACHE_ROOTS).map(cache => `${cache.workspace}/${cache.cacheDir}/modules`);
export const moduleCacheName = name => /^(?:[a-f0-9]{40}|[a-f0-9]{64}|CACHEDIR\.TAG|_metadata\.json)$/.test(name);
export const moduleCacheMetadata = metadata => metadata !== null && typeof metadata === 'object'
  && !Array.isArray(metadata) && Object.keys(metadata).length === 1
  && typeof metadata.lockfileHash === 'string' && [8, 40, 64].includes(metadata.lockfileHash.length)
  && !/[^a-f0-9]/.test(metadata.lockfileHash);
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
const sameFile = (a, b) => sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.mode === b.mode;
const changed = () => new Error('retirement-test-cache-changed');

async function directoryFence(checkout, root, work) {
  const directories = [];
  let path = checkout;
  for (const part of ['', ...root.split('/')]) {
    work.check();
    if (part) path = join(path, part);
    const info = await lstat(path, { bigint: true });
    if (!info.isDirectory() || info.ino === 0n) throw changed();
    directories.push({ path, info });
  }
  const check = async (settled = false) => {
    for (const entry of directories) {
      work.check();
      const current = await lstat(entry.path, { bigint: true });
      if (!current.isDirectory() || !sameIdentity(entry.info, current) || entry.info.ctimeNs !== current.ctimeNs
        || (settled && entry === directories.at(-1) && !sameFile(entry.info, current))) throw changed();
    }
  };
  return { check, identity: directories.map(({ info }) => [String(info.dev), String(info.ino), String(info.birthtimeNs), String(info.ctimeNs)]) };
}

// Open a fixed batch without reading payload. Checking the complete parent
// chain after every descriptor is open catches redirect-and-restore races before
// any read, while avoiding one full ancestor walk per file. Once checked, reads
// use anchored descriptors; parent ctime and descriptor stats fence settlement.
async function entryProofs(paths, fence, work, { limit = Infinity, capture = false } = {}) {
  await fence();
  const opened = await Promise.allSettled(paths.map(async path => {
    work.check();
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw changed();
    if (Number(before.size) > limit) return null;
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    try {
      if (!sameFile(before, await handle.stat({ bigint: true }))) throw changed();
      return { handle, before };
    } catch (error) { await handle.close(); throw error; }
  }));
  const handles = opened.filter(result => result.status === 'fulfilled' && result.value).map(result => result.value.handle);
  try {
    const failure = opened.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    await fence();
    const results = await Promise.allSettled(opened.map(async result => {
      if (!result.value) return null;
      const { handle, before } = result.value;
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Number(before.size)));
      const chunks = [];
      let bytes = 0;
      const started = performance.now();
      while (bytes < Number(before.size)) {
        work.check();
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, Number(before.size) - bytes), null);
        if (!bytesRead) throw changed();
        bytes += bytesRead;
        work.cacheRead(bytesRead);
        hash.update(buffer.subarray(0, bytesRead));
        if (capture) chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      }
      work.cacheHashTime(performance.now() - started);
      if (!sameFile(before, await handle.stat({ bigint: true }))) throw changed();
      return { type: 'file', bytes, sha256: hash.digest('hex'), ...(capture && { data: Buffer.concat(chunks) }) };
    }));
    const readFailure = results.find(result => result.status === 'rejected');
    if (readFailure) throw readFailure.reason;
    await fence();
    return results.map(result => result.value);
  } finally { await Promise.all(handles.map(handle => handle.close())); }
}

/** Transaction-local proof only. Historical archives never use this format.
 * Git enumeration and directory-name accounting remain bounded independently;
 * a fixed batch bounds live file proofs, descriptors and read buffers.
 */
export async function compactModuleCacheProof(checkout, root, ignored, work) {
  if (!ignored.has(`${root}/CACHEDIR.TAG`) || !ignored.has(`${root}/_metadata.json`)) return null;
  work.cacheAttempt();
  const directories = await directoryFence(checkout, root, work);
  const fence = directories.check;
  const [tag] = await entryProofs([join(checkout, root, 'CACHEDIR.TAG')], fence, work, { limit: 2048, capture: true });
  const [metadata] = await entryProofs([join(checkout, root, '_metadata.json')], fence, work, { limit: 4096, capture: true });
  let value;
  try { value = metadata && JSON.parse(metadata.data.toString('utf8')); } catch { return null; }
  if (!tag?.data.toString('utf8').startsWith(VITEST_CACHE_TAG) || !moduleCacheMetadata(value)) return null;
  const names = [];
  const directory = await opendir(join(checkout, root));
  for await (const entry of directory) {
    work.check();
    // A link/type change inside a recognized producer root is never cache.
    if (!entry.isFile()) throw changed();
    if (!moduleCacheName(entry.name) || !ignored.has(`${root}/${entry.name}`)) return null;
    work.add(entry.name, 'directory');
    names.push(entry.name);
  }
  names.sort();
  const aggregate = createHash('sha256').update(JSON.stringify(['vitest-module-cache', 1, root, directories.identity, names.length])).update('\0');
  let bytes = 0;
  for (let offset = 0; offset < names.length; offset += 16) {
    work.check();
    const batch = names.slice(offset, offset + 16);
    const modules = batch.filter(name => name !== 'CACHEDIR.TAG' && name !== '_metadata.json');
    const entries = await entryProofs(modules.map(name => join(checkout, root, name)), fence, work);
    let moduleIndex = 0;
    const results = batch.map(name => name === 'CACHEDIR.TAG' ? tag : name === '_metadata.json' ? metadata : entries[moduleIndex++]);
    let proofBytes = 0;
    for (const [index, entry] of results.entries()) {
      const proof = JSON.stringify({ path: batch[index], type: entry.type, bytes: entry.bytes, sha256: entry.sha256 });
      proofBytes += Buffer.byteLength(proof);
      aggregate.update(proof).update('\0');
      bytes += entry.bytes;
      if (!Number.isSafeInteger(bytes)) throw changed();
      work.cacheEntry(entry.bytes);
    }
    work.cacheProofPeak(proofBytes);
  }
  const [finalTag] = await entryProofs([join(checkout, root, 'CACHEDIR.TAG')], fence, work, { limit: 2048 });
  const [finalMetadata] = await entryProofs([join(checkout, root, '_metadata.json')], fence, work, { limit: 4096 });
  if (finalTag?.sha256 !== tag.sha256 || finalMetadata?.sha256 !== metadata.sha256) throw changed();
  await fence(true);
  // Directory timestamps detect added/removed entries during enumeration/read;
  // the final retirement snapshot independently re-enumerates and rehashes.
  const proof = { version: 1, producer: 'vitest-modules', root, entries: names.length, bytes, sha256: aggregate.digest('hex') };
  work.add(proof);
  return proof;
}
