/**
 * Sprites — on-disk layout + path confinement.
 *
 * Binary sprite assets live under data/sprites/<recordId>/ (reference/, walk/,
 * runs/<run-id>/, runtime/vN/, atlas/ for props families). `spriteDir` gates every
 * record id (ids double as directory names) and `resolveSpriteAssetPath` is the
 * multi-segment confinement gate for request-influenced relative paths; inline
 * previews are served by express.static, which does its own traversal safety.
 */

import { join, resolve } from 'path';
import { readdir, stat } from 'fs/promises';
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

// Runtime-atlas layout: the mutable current-selection pointer and the append-only
// publish history, shared by atlas.js and publish.js so a rename can't half-land.
export const RUNTIME_POINTER_REL = 'runtime/current.json';
export const RUNTIME_PUBLICATIONS_REL = 'runtime/publications.json';

/**
 * The path prefix the source art pipeline anchors every embedded reference at.
 * A copied manifest names `art-source/sprites/<recordId>/…` for a file that sits at
 * the record root here, so this marker distinguishes "still carries source-pipeline
 * provenance" from "PortOS-owned and relative". It can sit at any index (absolute /
 * repo-prefixed variants), hence `includes`, not a prefix test.
 */
export const SOURCE_PIPELINE_ANCHOR = 'art-source/sprites/';
export const isSourcePipelinePath = (p) => typeof p === 'string' && p.includes(SOURCE_PIPELINE_ANCHOR);

// The i2v clip every animation run is derived from, inside its `generated/` dir.
// Shared: the importer copies it, postprocess reads it, the walk service re-derives from it.
export const SOURCE_CLIP_NAME = 'source-video.mp4';

// The record-relative home of one animation run, in the vendor-neutral layout every
// new generation writes (RUN_DIR_MATCH below still accepts the legacy `grok/` prefix on read).
export const runRelPath = (runId) => `runs/${runId}`;

// The per-run record inside that directory; shared by walk.js, animationTrackWorkflow.js
// and the local-render completion hook.
export const RUN_RECORD_NAME = 'animation-run.json';

/**
 * Normalize an asset-path field read out of an imported manifest to the
 * record-relative form `spriteAssetUrl`/`resolveSpriteAssetPath` expect. The source
 * pipeline embeds paths anchored at ITS repo root (`art-source/sprites/<recordId>/...`);
 * readers must strip that prefix at read time. Returns null for a path not inside this
 * record (e.g. a pipeline script path) or for missing/empty/traversal-shaped input. A
 * path with no repo-anchor segment is assumed record-relative and passed through, so
 * this is a no-op for PortOS's own runs.
 */
export function toRecordRelativeAssetPath(recordId, rawPath) {
  if (typeof rawPath !== 'string' || !rawPath) return null;
  const marker = `${SOURCE_PIPELINE_ANCHOR}${recordId}/`;
  const idx = rawPath.indexOf(marker);
    // Match importer.js's relToCharacterDir: strip a leading slash from an
    // already-relative path before validating.
  const rel = idx >= 0 ? rawPath.slice(idx + marker.length) : rawPath.replace(/^\/+/, '');
  if (idx < 0 && /^(art-pipeline|art-source|game)\//.test(rel)) return null;
  if (!rel || rel.split(/[\\/]/).some((seg) => seg === '..' || seg === '')) return null;
  return rel;
}

// The confinement check, shared by the throwing gate below and the non-throwing
// `safeResolveSpriteAssetPath` so the two never disagree on what counts as an escape.
const confineToRecordDir = (dir, relPath) => {
  const abs = resolve(dir, relPath);
  return abs === dir || isPathInsideDir(dir, abs) ? abs : null;
};

/**
 * Resolve a relative asset path inside a record's directory, refusing any path that
 * escapes it (`..`, absolute paths).
 */
export function resolveSpriteAssetPath(recordId, relPath) {
  const dir = spriteDir(recordId);
  if (typeof relPath !== 'string' || !relPath) {
    throw new ServerError('Missing asset path', { status: 400, code: 'INVALID_ASSET_PATH' });
  }
  const abs = confineToRecordDir(dir, relPath);
  if (!abs) {
    throw new ServerError(`Asset path escapes sprite directory: ${relPath}`, { status: 400, code: 'INVALID_ASSET_PATH' });
  }
  return abs;
}

/**
 * The two on-disk layouts that hold an animation run: PortOS's own generations write
 * `grok/<run-id>/`, while the source-pipeline importer preserves `runs/<run-id>/`.
 * Matches the run directory at the head of a record-relative path; walk.js's per-entry
 * run resolver and the raw-intermediate exclusion below both build on it, so the prefix
 * set is stated once.
 */
const RUN_DIR_PREFIXES = ['grok', 'runs'];
export const RUN_DIR_MATCH = new RegExp(`^(${RUN_DIR_PREFIXES.join('|')})/[^/]+`);
const RUN_DIR_SPLIT = new RegExp(`^(${RUN_DIR_PREFIXES.join('|')})(/.+)$`);

/**
 * The neutral run-layout spelling PortOS uses for imported source trees. Native render
 * jobs may keep their `grok/` location; imports always land under `runs/` so a later
 * re-import cannot recreate legacy path residue.
 */
export const CANONICAL_IMPORTED_RUN_DIR = 'runs';

/** Normalize a record-relative imported run path to its local `runs/` spelling. */
export function canonicalizeImportedRunPath(rel) {
  return typeof rel === 'string' && rel.startsWith('grok/')
    ? `${CANONICAL_IMPORTED_RUN_DIR}/${rel.slice('grok/'.length)}`
    : rel;
}

/**
 * Rewrite one embedded sprite-run path to its local imported spelling. Handles
 * record-relative `grok/<run-id>/…` and source-anchored `…/sprites/<id>/grok/<run-id>/…`
 * values, without touching free-text values that merely contain "grok".
 */
export function canonicalizeImportedRunPathValue(recordId, value) {
  if (typeof value !== 'string') return value;
  return canonicalizeImportedRunPath(
    value.split(`sprites/${recordId}/grok/`).join(`sprites/${recordId}/${CANONICAL_IMPORTED_RUN_DIR}/`),
  );
}

/** Recursively normalize embedded imported run paths while preserving all other values. */
export function deepCanonicalizeImportedRunPaths(recordId, value) {
  if (typeof value === 'string') return canonicalizeImportedRunPathValue(recordId, value);
  if (Array.isArray(value)) return value.map((entry) => deepCanonicalizeImportedRunPaths(recordId, entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, deepCanonicalizeImportedRunPaths(recordId, entry)]),
    );
  }
  return value;
}

/**
 * The same run path under the OTHER run-dir prefix, or null for a path not inside a run
 * directory. Source trees drift: a run's files can sit under `grok/<run-id>/` while
 * manifests naming them say `runs/<run-id>/`; both denote the same run (hence
 * `getWalkState` scans both via `RUN_SCAN_DIRS`). The importer resolves source reads
 * through this so a drifted tree still imports.
 */
export function altRunLayoutPath(rel) {
  const match = RUN_DIR_SPLIT.exec(rel || '');
  return match ? `${RUN_DIR_PREFIXES.find((p) => p !== match[1])}${match[2]}` : null;
}

/** The run directory at the head of a record-relative path, under either layout. */
export const runDirOfPath = (rel) => (typeof rel === 'string' ? RUN_DIR_MATCH.exec(rel)?.[0] || null : null);

/**
 * The spelling of `rel` that actually exists under `baseDir` — the declared one or its
 * run-layout twin — or null when neither does. The drift is a fact about the source
 * trees, not about clips, so every reader resolving a declared path against disk wants
 * this; it lives beside `altRunLayoutPath`. A path outside a run directory has no twin,
 * so this degrades to a plain existence check.
 */
export async function resolveDriftTolerantRel(baseDir, rel) {
  if (typeof rel !== 'string' || !rel) return null;
  if (await pathExists(join(baseDir, rel))) return rel;
  const alt = altRunLayoutPath(rel);
  return alt && (await pathExists(join(baseDir, alt))) ? alt : null;
}

/**
 * Raw ffmpeg-extracted frame intermediates inside an animation run (30–96 near-identical
 * PNGs per run) — where they live and what they are named.
 *
 * Stated beside the exclusion built from it because two readers disagree by design:
 * `listSpriteAssets` skips the directory (the frames would swamp the asset browser)
 * while the Loop Trimmer's source-frame endpoint is the sanctioned narrow window onto
 * it. Splitting the definitions would silently publish the PNGs into the browser while
 * the trimmer reads an empty tree.
 *
 * Narrower than the importer's EXCLUDED_RUN_SEGMENTS (which also skips frames/ and
 * review/): the packaged phase frames and contrast review sheet exist FOR human review.
 */
export const rawFramesRelOf = (runDirRel) => `${runDirRel}/generated/raw`;
export const RAW_FRAME_NAME = /^source-(\d{4})\.png$/;
const RUN_RAW_INTERMEDIATE = new RegExp(`${RUN_DIR_MATCH.source}${rawFramesRelOf('')}/`);

// Extensions sharp can parse a header for. Anything else (JSON manifests,
// videos, text) skips the metadata probe entirely.
const IMAGE_METADATA_EXT = /\.(png|gif|webp|jpe?g|avif|tiff?)$/i;

// Matches the cap the other sharp call sites use so a decompression-bomb PNG can't wedge a listing.
const MAX_PIXELS = 268402689;

// The detail route re-lists the whole tree on every GET and the client polls while a
// walk run is packaging, so cache probes. Keyed on path+mtime+size, so a regenerated
// file invalidates itself. Bounded: a long-lived server sees every file of every record.
const metadataCache = createBoundedStateMap({ maxSize: 5000, ttlMs: 60 * 60 * 1000 });

/**
 * Header-only image metadata for the asset inspector. Three distinct results, never
 * collapsed ("not applicable" must not read as "failed"):
 *   - `{}`                    not an image; nothing was attempted
 *   - `{ imageError: true }`  an image sharp could not read (truncated/corrupt)
 *   - `{ width, height, format, frameCount }`  probed successfully
 *
 * Failures degrade the row rather than throwing, so one bad PNG can't 500 the record
 * detail. sharp reads only the header (no decode), so this stays cheap.
 */
async function readImageMetadata(absPath, stats) {
  if (!IMAGE_METADATA_EXT.test(absPath)) return {};
  const cacheKey = [absPath, stats.mtimeMs, stats.size].join(":");
  const cached = metadataCache.get(cacheKey);
  if (cached) return cached;
  let result;
  try {
    const { default: sharp } = await import('sharp');
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
 * `[{ path, size, mtime, width?, height?, format?, frameCount?, imageError? }]` with
 * `path` relative (posix separators) to the record dir. Dotfiles and raw run
 * intermediates are skipped. A record with no directory yet returns []. See
 * `readImageMetadata` for the image fields.
 *
 * Options:
 *  - `subdir` — descend only this record-relative directory (paths stay record-relative)
 *  - `metadata` — false skips the sharp header probe for callers needing only bytes/sizes
 */
export async function listSpriteAssets(recordId, { subdir = '', metadata = true } = {}) {
    // `subdir` goes through the confinement gate, not a bare join, so a future
    // request-influenced value cannot escape.
  const dir = subdir ? resolveSpriteAssetPath(recordId, subdir) : spriteDir(recordId);
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
        const meta = metadata ? await readImageMetadata(abs, s) : null;
        out.push({ path: rel, size: s.size, mtime: s.mtimeMs, ...meta });
      }
    }));
  }
  await walk(dir, subdir);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/**
 * The runtime-ready files a record contributes to a game asset bundle: everything under
 * `atlas/` with a loadable extension. Lives here because this module owns the on-disk
 * layout (props families land in `atlas/` via `importer.js` `importPropsFamily`).
 *
 * The extension filter is narrower than what the importer copies (it also brings `.md`
 * docs) and wider than what PortOS emits, so a hand-placed sheet in another image
 * format still bundles.
 */
export const IMPORTED_ATLAS_DIR = 'atlas';
const RUNTIME_ASSET_EXT = /\.(?:png|gif|webp|jpe?g|json)$/i;

export async function listRuntimeAtlasAssets(recordId) {
  const assets = await listSpriteAssets(recordId, { subdir: IMPORTED_ATLAS_DIR, metadata: false });
  return assets.filter((asset) => RUNTIME_ASSET_EXT.test(asset.path));
}

/**
 * `resolveSpriteAssetPath` for callers that want a bad path to be a data row rather than
 * a 400 — sweeps report a broken pointer as a blocked asset. Returns null for a non-slug
 * id, an empty path, or anything that escapes the record dir.
 */
export function safeResolveSpriteAssetPath(recordId, relPath) {
  if (!isValidSpriteId(recordId) || typeof relPath !== 'string' || !relPath) return null;
  return confineToRecordDir(join(PATHS.sprites, recordId), relPath);
}
