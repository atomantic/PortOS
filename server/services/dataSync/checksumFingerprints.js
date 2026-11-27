/** Reads file fingerprints and store mutation epochs used to invalidate snapshot caches. */

import { stat, readdir } from 'fs/promises';
import { join } from 'path';

// Combine mtime/size/inode of one regular file into a single fingerprint
// string. Inode is included so an atomic-write replace (which mints a new
// inode) is always detected even when mtime rounds equal.
const fingerprintEntry = (s) => s ? `${s.mtimeMs}:${s.size}:${s.ino}` : null;

// Walk a directory two levels deep — the layout produced by collectionStore
// (`{dir}/index.json` + `{dir}/<id>/index.json`) — and concatenate per-file
// fingerprints into one deterministic string. Sorted by name so the result
// is stable across readdir orderings. Used by the universe + mediaCollections
// checksum paths so per-record edits invalidate the cache without enumerating
// every record at module-load.
async function fingerprintDirTwoLevels(dirPath) {
  const top = await readdir(dirPath).catch(() => null);
  if (!top) return null;
  const sortedTop = [...top].sort();
  const segments = [];
  for (const name of sortedTop) {
    const childPath = join(dirPath, name);
    const cs = await stat(childPath).catch(() => null);
    if (!cs) continue;
    if (cs.isFile()) {
      segments.push(`${name}:${fingerprintEntry(cs)}`);
      continue;
    }
    if (!cs.isDirectory()) continue;
    const inner = await readdir(childPath).catch(() => []);
    for (const innerName of [...inner].sort()) {
      const innerPath = join(childPath, innerName);
      const is = await stat(innerPath).catch(() => null);
      if (is?.isFile()) segments.push(`${name}/${innerName}:${fingerprintEntry(is)}`);
    }
  }
  return segments.join('|') || 'empty';
}

export async function readFingerprintMap({ checksumPaths, checksumEpochs = {} }) {
  // Capture store epochs before awaiting file stats, alongside the file fingerprint read.
  const out = Object.fromEntries(Object.entries(checksumEpochs).map(([name, readEpoch]) => [name, readEpoch()]));
  await Promise.all(checksumPaths.map(async (p) => {
    const s = await stat(p).catch(() => null);
    if (!s) { out[p] = null; return; }
    if (s.isDirectory()) {
      out[p] = await fingerprintDirTwoLevels(p);
      return;
    }
    out[p] = fingerprintEntry(s);
  }));
  return out;
}

export function fingerprintsEqual(a, b) {
  for (const p in a) if (a[p] !== b[p]) return false;
  for (const p in b) if (a[p] !== b[p]) return false;
  return true;
}
