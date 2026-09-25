import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { atomicWrite, PATHS } from './fileUtils.js';

const pending = new Map();

const optionalStat = async (path) => lstat(path).catch((error) => {
  if (error.code === 'ENOENT') return null;
  throw error;
});

/** Lazily build a small WebP for a gallery PNG. Returns false if its source is absent. */
export async function ensureImageThumbnail(filename) {
  if (typeof filename !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.webp$/i.test(filename)) return false;
  if (pending.has(filename)) return pending.get(filename);

  const work = (async () => {
    const source = join(PATHS.images, filename.replace(/\.webp$/i, '.png'));
    const target = join(PATHS.imageThumbnails, filename);
    const sourceStat = await optionalStat(source);
    if (!sourceStat?.isFile()) return false;
    const targetStat = await optionalStat(target);
    if (!targetStat?.isFile() || targetStat.mtimeMs < sourceStat.mtimeMs) {
      const bytes = await sharp(source).rotate()
        .resize({ width: 512, height: 512, fit: 'outside', withoutEnlargement: true })
        .webp({ quality: 78 }).toBuffer();
      await atomicWrite(target, bytes);
    }
    return true;
  })();
  pending.set(filename, work);
  try {
    return await work;
  } finally {
    pending.delete(filename);
  }
}
