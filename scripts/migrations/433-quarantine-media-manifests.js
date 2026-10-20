/** Quarantine persisted media that predates the ingest manifest guard (#12530).
 * No records are deleted and no output paths are seeded or migration-owned.
 */
import { lstat, open, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { detectMediaManifest, id3v2TagLength, MEDIA_MANIFEST_PROBE_BYTES } from '../../server/lib/mimeTypes.js';

const MEDIA_DIRS = ['music', 'uploads', 'videos', 'audio', 'images', 'image-refs'];

async function manifestFormat(path) {
  const handle = await open(path, 'r');
  const readWindow = async (position) => {
    const buffer = Buffer.alloc(MEDIA_MANIFEST_PROBE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    return buffer.subarray(0, bytesRead);
  };
  return (async () => {
    const head = await readWindow(0);
    const format = detectMediaManifest(head);
    if (format) return format;
    // A tag can end just before the leading window's edge, leaving too little
    // playlist text for detection. Always inspect a full post-tag window.
    const tagLength = id3v2TagLength(head);
    return tagLength > 0 ? detectMediaManifest(await readWindow(tagLength)) : null;
  })().finally(() => handle.close());
}

async function quarantineDirectory(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch((err) => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });
  let quarantined = 0;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    // Do not follow nested symlinks outside the media store.
    if (entry.isDirectory()) {
      quarantined += await quarantineDirectory(path);
    } else if (entry.isFile() && !entry.name.endsWith('.quarantined')) {
      const format = await manifestFormat(path);
      if (!format) continue;
      // A restored pre-433 snapshot puts the original beside an earlier
      // quarantine. Throwing would abort the runner and block every later
      // migration, so take the first free numbered name; never overwrite.
      let destination = `${path}.quarantined`;
      for (let n = 1; await lstat(destination).then(() => true, (err) => {
        if (err.code === 'ENOENT') return false;
        throw err;
      }); n++) destination = `${path}.${n}.quarantined`;
      await rename(path, destination);
      quarantined++;
      console.log(`📦 Quarantined ${format} media manifest`);
    }
  }
  return quarantined;
}

export default {
  async up({ rootDir }) {
    let quarantined = 0;
    for (const dir of MEDIA_DIRS) {
      quarantined += await quarantineDirectory(join(rootDir, 'data', dir));
    }
    return { quarantined };
  },
};
