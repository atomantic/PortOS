/**
 * Sprites — on-disk asset deletion (#2930 follow-up).
 *
 * As a character is iterated, its runtime/ tree accumulates old atlas versions
 * (`runtime/vN/<id>-animation-atlas-vN.png` + sidecar manifest) and its
 * reference/walk trees accumulate superseded candidate renders. This prunes
 * one asset at a time by the same record-relative `path` the listing and the
 * static route already use.
 *
 * Two things are refused: the record-state index files (the mutable atlas
 * pointer + the append-only publish history — deleting those corrupts the
 * bookkeeping that still points at surviving versions), and the atlas the
 * current pointer selects (deleting the live sheet would strand any published
 * app AND loop compileAtlas's missing-PNG self-heal). Everything else is fair
 * game. A runtime version is deleted as a unit (PNG + manifest together) — a
 * stray manifest whose PNG is gone re-seeds that self-heal path (atlas.js).
 *
 * Runs inside the record's walk write tail so a delete can never interleave
 * with an in-flight compile/approve that reads the same version tree.
 */

import { join, dirname, relative, sep } from 'path';
import { rm } from 'fs/promises';
import { readJSONFile } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import {
  spriteDir, resolveSpriteAssetPath, RUNTIME_POINTER_REL, RUNTIME_PUBLICATIONS_REL,
} from './paths.js';
import { withWalkWriteTail } from './walk.js';

// Record bookkeeping, not deletable assets: the mutable current-atlas pointer
// and the append-only publish history. The versioned PNGs/manifests they name
// ARE deletable (that's the whole feature); these indices are not.
const PROTECTED_STATE = new Set([RUNTIME_POINTER_REL, RUNTIME_PUBLICATIONS_REL]);

// A record-relative path inside a runtime atlas version dir → its `runtime/vN`
// prefix, so any file in the version deletes the whole version as one unit.
const RUNTIME_VERSION_MATCH = /^(runtime\/v\d+)(?:\/|$)/;

/** Delete one on-disk asset by its record-relative path. */
export function deleteSpriteAsset(recordId, relPath) {
  return withWalkWriteTail(recordId, () => deleteSpriteAssetImpl(recordId, relPath));
}

async function deleteSpriteAssetImpl(recordId, relPath) {
  const dir = spriteDir(recordId);
  // Confinement first: resolves under the record dir, throws on traversal /
  // absolute paths (paths.js contract). resolveSpriteAssetPath permits the
  // record root itself, so refuse that explicitly — never rm -rf the record.
  const abs = resolveSpriteAssetPath(recordId, relPath);
  if (abs === dir) {
    throw new ServerError('Refusing to delete the record directory', { status: 400, code: 'INVALID_ASSET_PATH' });
  }
  // Derive the record-relative form from the CONFINED absolute path, not by
  // munging the raw input — so the protected-file / live-atlas guards below
  // compare the exact canonical path that will actually be removed. A raw
  // `./runtime/current.json` or `runtime//current.json` resolves to the
  // protected file but wouldn't string-match the guard list otherwise.
  const normalized = relative(dir, abs).split(sep).join('/');

  if (PROTECTED_STATE.has(normalized)) {
    throw new ServerError(
      'That file is record state (the atlas pointer / publish history), not a deletable asset.',
      { status: 409, code: 'PROTECTED_STATE_FILE' },
    );
  }

  const versionMatch = normalized.match(RUNTIME_VERSION_MATCH);
  const current = await readJSONFile(join(dir, RUNTIME_POINTER_REL), null);
  if (current) {
    const currentVersionDir = current.atlasPath ? dirname(current.atlasPath) : null;
    const targetsCurrentVersion = Boolean(versionMatch) && versionMatch[1] === currentVersionDir;
    if (targetsCurrentVersion || normalized === current.atlasPath || normalized === current.manifestPath) {
      throw new ServerError(
        'This is the current runtime atlas — compile or publish a newer version before deleting it.',
        { status: 409, code: 'ATLAS_IN_USE' },
      );
    }
  }

  // A runtime version deletes as a unit (PNG + sidecar manifest); every other
  // asset deletes as the single file requested. `force` swallows ENOENT so a
  // double-click / already-gone file is a no-op success, not a 500.
  const removed = versionMatch ? versionMatch[1] : normalized;
  const removeAbs = versionMatch ? join(dir, versionMatch[1]) : abs;
  await rm(removeAbs, { recursive: true, force: true });
  console.log(`🗑️ sprite asset deleted for ${recordId} → ${removed}`);
  return { deleted: true, removed };
}
