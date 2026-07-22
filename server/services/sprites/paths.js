/**
 * Sprites — on-disk layout + path confinement (issue #2895, phase 1).
 *
 * Binary sprite assets live under data/sprites/<recordId>/ mirroring the
 * source pipeline's per-character tree (reference/, walk/, runs/<run-id>/,
 * runtime/vN/, atlas/ for props families). `spriteDir` gates every record id
 * (ids double as directory names) and `resolveSpriteAssetPath` is the
 * multi-segment confinement gate for request-influenced relative paths — in
 * phase 1 inline previews are served by express.static (which does its own
 * traversal safety), so the resolver is the forward hook the phase-2+
 * generation/publish paths route file access through.
 */

import { join, resolve } from 'path';
import { readdir, stat } from 'fs/promises';
import { PATHS, isPathInsideDir } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { isValidSpriteId } from './recordsLogic.js';

/** Asset directory for one sprite record. Throws on a non-slug id. */
export function spriteDir(recordId) {
  if (!isValidSpriteId(recordId)) {
    throw new ServerError(`Invalid sprite id: ${recordId}`, { status: 400, code: 'INVALID_SPRITE_ID' });
  }
  return join(PATHS.sprites, recordId);
}

/**
 * Resolve a relative asset path inside a record's directory, refusing any
 * path that escapes it (`..`, absolute paths).
 */
export function resolveSpriteAssetPath(recordId, relPath) {
  const dir = spriteDir(recordId);
  if (typeof relPath !== 'string' || !relPath) {
    throw new ServerError('Missing asset path', { status: 400, code: 'INVALID_ASSET_PATH' });
  }
  const abs = resolve(dir, relPath);
  if (abs !== dir && !isPathInsideDir(dir, abs)) {
    throw new ServerError(`Asset path escapes sprite directory: ${relPath}`, { status: 400, code: 'INVALID_ASSET_PATH' });
  }
  return abs;
}

/**
 * Recursively list a record's on-disk assets as `[{ path, size, mtime }]`
 * with `path` relative (posix separators) to the record dir. Dotfiles are
 * skipped; per-directory stats and subdirectory descents run in parallel.
 * A record with no directory yet returns [].
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
    await Promise.all(entries.map(async (entry) => {
      if (entry.name.startsWith('.')) return;
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(join(current, entry.name), rel);
      } else if (entry.isFile()) {
        const s = await stat(join(current, entry.name));
        out.push({ path: rel, size: s.size, mtime: s.mtimeMs });
      }
    }));
  }
  await walk(dir, '');
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}
