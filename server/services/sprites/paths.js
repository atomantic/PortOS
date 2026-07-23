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

// Runtime-atlas layout (phase 4): the mutable current-selection pointer and
// the append-only publish history, shared by atlas.js and publish.js so a
// rename can't half-land.
export const RUNTIME_POINTER_REL = 'runtime/current.json';
export const RUNTIME_PUBLICATIONS_REL = 'runtime/publications.json';

/**
 * Normalize an asset-path field read out of an imported manifest to the
 * record-relative form `spriteAssetUrl`/`resolveSpriteAssetPath` expect. The
 * source pipeline embeds paths anchored at ITS repo root
 * (`art-source/sprites/<recordId>/...`) inside every manifest, and the
 * importer copies those manifests byte-for-byte — their hashes are pinned
 * and verified against the source, so importer.js never rewrites the copied
 * JSON content. Readers that treat an embedded path as record-relative (the
 * convention every PortOS-generated manifest already follows) must strip
 * that source-repo prefix at read time instead. Returns null for a path
 * that isn't inside this record (repo-anchored provenance, e.g. a pipeline
 * script path) or for missing/empty/traversal-shaped input. A path with no
 * repo-anchor segment is assumed already record-relative and passed through
 * unchanged — this is what makes the helper a no-op for PortOS's own runs.
 */
export function toRecordRelativeAssetPath(recordId, rawPath) {
  if (typeof rawPath !== 'string' || !rawPath) return null;
  const marker = `art-source/sprites/${recordId}/`;
  const idx = rawPath.indexOf(marker);
  // Match importer.js's relToCharacterDir: an already-relative path may still
  // carry a leading slash (an absolute-style source value) — strip it before
  // validating, same as the importer's twin function does.
  const rel = idx >= 0 ? rawPath.slice(idx + marker.length) : rawPath.replace(/^\/+/, '');
  if (idx < 0 && /^(art-pipeline|art-source|game)\//.test(rel)) return null;
  if (!rel || rel.split(/[\\/]/).some((seg) => seg === '..' || seg === '')) return null;
  return rel;
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
 * The two on-disk layouts that hold an animation run: PortOS's own
 * generations write `grok/<run-id>/`, while the source-pipeline importer
 * (#2895) preserves its own `runs/<run-id>/` tree. Matches the run directory
 * at the head of a record-relative path — `walk.js`'s per-entry run resolver
 * (#2928) dispatches on it, and the raw-intermediate exclusion below extends
 * it, so the prefix set is stated exactly once.
 */
export const RUN_DIR_MATCH = /^(grok|runs)\/[^/]+/;

// Raw ffmpeg-extracted frame intermediates inside an animation run (30–96
// near-identical PNGs per run, `grok|runs/<run>/generated/raw/`). Kept on
// disk for the postprocessor but omitted from the asset listing — they'd
// swamp the browser. Narrower than the importer's EXCLUDED_RUN_SEGMENTS
// (which also skips frames/ and review/ to minimize cross-machine copies):
// the packaged phase frames and the contrast review sheet exist FOR human
// review, so the local browser keeps them.
const RUN_RAW_INTERMEDIATE = new RegExp(`${RUN_DIR_MATCH.source}/generated/raw/`);

/**
 * Recursively list a record's on-disk assets as `[{ path, size, mtime }]`
 * with `path` relative (posix separators) to the record dir. Dotfiles and
 * raw run intermediates are skipped; per-directory stats and subdirectory
 * descents run in parallel. A record with no directory yet returns [].
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
        if (RUN_RAW_INTERMEDIATE.test(`${rel}/`)) return;
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
