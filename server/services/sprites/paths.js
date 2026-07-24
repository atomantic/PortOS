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
import sharp from 'sharp';
import { PATHS, isPathInsideDir, pathExists } from '../../lib/fileUtils.js';
import { createBoundedStateMap } from '../../lib/boundedStateMap.js';
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
 * The path prefix the source art pipeline anchors every embedded reference at.
 * A copied manifest names `art-source/sprites/<recordId>/…` for a file that, on
 * this side, sits at the record root — so this marker is what distinguishes
 * "still carries source-pipeline provenance" from "PortOS-owned and relative".
 * It can sit at any index (absolute / repo-prefixed variants), matching the
 * importer's own recognition — hence `includes`, not a prefix test.
 */
export const SOURCE_PIPELINE_ANCHOR = 'art-source/sprites/';
export const isSourcePipelinePath = (p) => typeof p === 'string' && p.includes(SOURCE_PIPELINE_ANCHOR);

// The i2v clip every animation run is derived from, inside its `generated/` dir.
// Named here rather than in each consumer: the importer copies it, the
// postprocess reads it, and the walk service re-derives from it.
export const SOURCE_CLIP_NAME = 'source-video.mp4';

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
  const marker = `${SOURCE_PIPELINE_ANCHOR}${recordId}/`;
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
const RUN_DIR_PREFIXES = ['grok', 'runs'];
export const RUN_DIR_MATCH = new RegExp(`^(${RUN_DIR_PREFIXES.join('|')})/[^/]+`);
const RUN_DIR_SPLIT = new RegExp(`^(${RUN_DIR_PREFIXES.join('|')})(/.+)$`);

/**
 * The same run path under the OTHER run-dir prefix (the pair has exactly two
 * members), or null for a path that isn't inside a run directory. Source trees
 * drift — a run's files can sit under `grok/<run-id>/` while the manifests
 * naming them say `runs/<run-id>/` — and both spellings denote the same run,
 * which is why `getWalkState` scans both (walk.js `RUN_SCAN_DIRS`). The
 * importer resolves source reads through this so a drifted tree still imports.
 */
export function altRunLayoutPath(rel) {
  const match = RUN_DIR_SPLIT.exec(rel || '');
  return match ? `${RUN_DIR_PREFIXES.find((p) => p !== match[1])}${match[2]}` : null;
}

/** The run directory at the head of a record-relative path, under either layout. */
export const runDirOfPath = (rel) => (typeof rel === 'string' ? RUN_DIR_MATCH.exec(rel)?.[0] || null : null);

/**
 * The spelling of `rel` that actually exists under `baseDir` — the declared one
 * or its run-layout twin — or null when neither does.
 *
 * The drift this absorbs is one fact about the source trees, not one fact about
 * clips: a manifest can name `runs/<id>/…` for a file stored under `grok/<id>/…`
 * and both spellings denote the same artifact. Every reader that resolves a
 * declared path against disk wants this, which is why it lives beside
 * `altRunLayoutPath` rather than inside any one consumer (the importer resolves
 * its source reads through it; the walk service resolves run clips through it).
 * A path outside a run directory has no twin, so this degrades to a plain
 * existence check.
 */
export async function resolveDriftTolerantRel(baseDir, rel) {
  if (typeof rel !== 'string' || !rel) return null;
  if (await pathExists(join(baseDir, rel))) return rel;
  const alt = altRunLayoutPath(rel);
  return alt && (await pathExists(join(baseDir, alt))) ? alt : null;
}

/**
 * Raw ffmpeg-extracted frame intermediates inside an animation run (30–96
 * near-identical PNGs per run) — where they live and what they are named.
 *
 * Stated here, beside the exclusion built from it, because two readers disagree
 * about them by design: `listSpriteAssets` skips the directory (the frames would
 * swamp the asset browser) while the Loop Trimmer's source-frame endpoint (#2980)
 * is the sanctioned narrow window onto it. Split those definitions and moving the
 * directory — or widening the counter past four digits — silently publishes ~73
 * PNGs into the browser while the trimmer reads an empty tree.
 *
 * The exclusion is narrower than the importer's EXCLUDED_RUN_SEGMENTS (which also
 * skips frames/ and review/ to minimize cross-machine copies): the packaged phase
 * frames and the contrast review sheet exist FOR human review, so the local
 * browser keeps them.
 */
export const rawFramesRelOf = (runDirRel) => `${runDirRel}/generated/raw`;
export const RAW_FRAME_NAME = /^source-(\d{4})\.png$/;
const RUN_RAW_INTERMEDIATE = new RegExp(`${RUN_DIR_MATCH.source}${rawFramesRelOf('')}/`);

// Extensions sharp can parse a header for. Anything else (JSON manifests,
// videos, text) skips the metadata probe entirely.
const IMAGE_METADATA_EXT = /\.(png|gif|webp|jpe?g|avif|tiff?)$/i;

// Matches the cap the other sharp call sites use (imageWatermark.js,
// imageClean.js) so a hand-dropped decompression-bomb PNG can't wedge a
// listing.
const MAX_PIXELS = 268402689;

// The detail route re-lists the whole tree on every GET, and the client polls
// it every few seconds while a walk run is packaging — so without a cache each
// poll re-probes several hundred frames that haven't changed. Keyed on
// path+mtime+size (all already in hand from the `stat` on the same line), so a
// regenerated file invalidates itself. Bounded because a long-lived server
// accumulates one entry per file across every record ever browsed.
const metadataCache = createBoundedStateMap({ maxSize: 5000, ttlMs: 60 * 60 * 1000 });

/**
 * Header-only image metadata for the asset inspector.
 *
 * Three distinct results, deliberately NOT collapsed into one (the repo's
 * sentinel rule — "not applicable" must not read the same as "failed"):
 *   - `{}`                    not an image; nothing was attempted
 *   - `{ imageError: true }`  an image sharp could not read (truncated/corrupt)
 *   - `{ width, height, format, frameCount }`  probed successfully
 *
 * Either failure mode degrades the row rather than throwing, so one bad PNG
 * can't 500 the whole record detail. sharp reads only the header here (no
 * decode), so this stays cheap.
 */
async function readImageMetadata(absPath, stats) {
  if (!IMAGE_METADATA_EXT.test(absPath)) return {};
  const cacheKey = [absPath, stats.mtimeMs, stats.size].join(":");
  const cached = metadataCache.get(cacheKey);
  if (cached) return cached;
  let result;
  try {
    const meta = await sharp(absPath, { limitInputPixels: MAX_PIXELS }).metadata();
    result = {
      width: meta.width ?? null,
      height: meta.height ?? null,
      format: meta.format ?? null,
      // `pages` is only set for multi-page formats (animated GIF/WebP); a
      // still PNG has exactly one frame.
      frameCount: meta.pages ?? 1,
    };
  } catch {
    result = { imageError: true };
  }
  metadataCache.set(cacheKey, result);
  return result;
}

// Test seam — the cache is keyed on mtime+size, so a fixture rewritten within
// the same millisecond at the same length would otherwise read stale.
export function __resetSpriteMetadataCache() {
  metadataCache.clear();
}

/**
 * Recursively list a record's on-disk assets as
 * `[{ path, size, mtime, width?, height?, format?, frameCount?, imageError? }]`
 * with `path` relative (posix separators) to the record dir. Dotfiles and raw
 * run intermediates are skipped; per-directory stats and subdirectory descents
 * run in parallel. A record with no directory yet returns []. A non-image
 * carries no image fields at all; an image sharp can't read carries
 * `imageError: true` — see `readImageMetadata`.
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
        const abs = join(current, entry.name);
        const s = await stat(abs);
        const meta = await readImageMetadata(abs, s);
        out.push({ path: rel, size: s.size, mtime: s.mtimeMs, ...meta });
      }
    }));
  }
  await walk(dir, '');
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}
