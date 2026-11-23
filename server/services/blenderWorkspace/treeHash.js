/**
 * Content hashes of a Blender workspace's source tree, so an output made from
 * other source reads as stale. An unchanged file (same size and mtime) is
 * hashed once per process, so reading state does not re-read every asset.
 */
import { createHash } from 'node:crypto';
import { sha256File } from '../../lib/fileCore.js';

const sha = (value) => createHash('sha256').update(value).digest('hex');

// absolute path → { bytes, mtimeMs, hash }
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
 * `entries` is a `walkSourceTree` listing: `files` maps each source path to its
 * content hash (in path order) and `tree` is one hash over all of them.
 */
export async function hashSourceEntries(entries) {
  const files = new Map();
  for (const entry of entries) files.set(entry.path, await contentHash(entry));
  return { files, tree: sha([...files].map(([path, hash]) => `${path}\0${hash}`).join('\n')) };
}
