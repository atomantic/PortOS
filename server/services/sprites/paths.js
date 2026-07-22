/**
 * Sprites — on-disk layout + path confinement (issue #2895, phase 1).
 *
 * Binary sprite assets live under data/sprites/<recordId>/ mirroring the
 * source pipeline's per-character tree (reference/, walk/, runs/<run-id>/,
 * runtime/vN/, atlas/ for props families). Every request-influenced path MUST
 * resolve through `resolveSpriteAssetPath` — the confinement gate that keeps a
 * crafted record id or relative path from escaping the sprites root (the port
 * of the source pipeline's pathsec gate). `safeUnder` in lib/ffmpeg.js is
 * single-segment-only, so this module carries the multi-segment equivalent.
 */

import { join, resolve, sep } from 'path';
import { readdir, stat } from 'fs/promises';
import { PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { isValidSpriteId } from './recordsLogic.js';

export function spritesRoot() {
  return PATHS.sprites;
}

/** Asset directory for one sprite record. Throws on a non-slug id. */
export function spriteDir(recordId) {
  if (!isValidSpriteId(recordId)) {
    throw new ServerError(`Invalid sprite id: ${recordId}`, { status: 400, code: 'INVALID_SPRITE_ID' });
  }
  return join(PATHS.sprites, recordId);
}

/**
 * Resolve a relative asset path inside a record's directory, refusing any
 * path that escapes it (`..`, absolute paths, symlink-free lexical check).
 */
export function resolveSpriteAssetPath(recordId, relPath) {
  const dir = spriteDir(recordId);
  if (typeof relPath !== 'string' || !relPath) {
    throw new ServerError('Missing asset path', { status: 400, code: 'INVALID_ASSET_PATH' });
  }
  const abs = resolve(dir, relPath);
  if (abs !== dir && !abs.startsWith(dir + sep)) {
    throw new ServerError(`Asset path escapes sprite directory: ${relPath}`, { status: 400, code: 'INVALID_ASSET_PATH' });
  }
  return abs;
}

/**
 * Recursively list a record's on-disk assets as
 * `[{ path, size, mtime }]` with `path` relative (posix separators) to the
 * record dir. Dotfiles are skipped. A record with no directory yet returns [].
 */
export async function listSpriteAssets(recordId) {
  const dir = spriteDir(recordId);
  const out = [];
  async function walk(current, relPrefix) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return; // dir absent → no assets
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(join(current, entry.name), rel);
      } else if (entry.isFile()) {
        const s = await stat(join(current, entry.name));
        out.push({ path: rel, size: s.size, mtime: s.mtimeMs });
      }
    }
  }
  await walk(dir, '');
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}
