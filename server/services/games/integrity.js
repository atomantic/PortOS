/**
 * Game bundle preflight and integrity verification.
 *
 * Resolves every bound asset to immutable, hash-pinned bytes. Native sprite
 * records use their current runtime-atlas pointer; imported prop/object
 * records use the runtime files already imported under atlas/. Character
 * references without a compiled atlas remain explicit blockers rather than
 * disappearing from a supposedly complete bundle.
 */

import { join } from 'path';
import {
  PATHS,
  readJSONFile,
  sha256File,
  sha256Text,
} from '../../lib/fileUtils.js';
import { canonicalStringify } from '../../lib/objects.js';
import { getAppById } from '../apps.js';
import { isSafeMusicFilename, statMusicTrack } from '../pipeline/musicLibrary.js';
import { getAtlasState } from '../sprites/atlas.js';
import {
  listRuntimeAtlasAssets,
  safeResolveSpriteAssetPath,
} from '../sprites/paths.js';
import { getRecord as getSpriteRecord } from '../sprites/records.js';
import { isValidSpriteId } from '../sprites/recordsLogic.js';
import { getTrack } from '../tracks/index.js';
import { getGame } from './records.js';
import { gameRecordDir } from './store.js';

export const BUNDLE_SCHEMA_VERSION = 2;

const issue = (assetType, assetId, name, code, message) => ({
  assetType,
  assetId,
  name,
  code,
  message,
});

/**
 * A resolver's failure result. Every blocked asset carries both an `issue` for
 * the blocker list and a matching `summary` row for the per-asset UI, built
 * from the same values here so the two can't drift — `shortMessage` is the
 * badge text when the full blocker sentence is too long for a row.
 */
const blocked = (assetType, identity, code, message, shortMessage = message) => ({
  problem: issue(assetType, identity.assetId, identity.name, code, message),
  summary: { ...identity, status: 'blocked', message: shortMessage },
});

// A null hash means "no verifiable bytes" — absent, or present but unreadable.
// The verdict is the same either way (it can never match a recorded hash), but
// the CAUSE is not: a permissions/descriptor failure on intact bytes reads to
// the user as corruption and sends them to recompile a perfectly good atlas.
// ENOENT is the expected case and stays quiet; anything else leaves a
// breadcrumb naming the real errno.
const hashIfPresent = (path) => sha256File(path).catch((err) => {
  if (err?.code !== 'ENOENT') {
    console.error(`❌ Unreadable game asset ${path}: ${err?.code || ''} ${err?.message || err}`);
  }
  return null;
});

async function resolveRuntimeAtlas(record, current) {
  const identity = { assetId: record.id, name: record.name, kind: record.kind };
  const required = [
    current?.atlasPath,
    current?.atlasSha256,
    current?.manifestPath,
    current?.manifestSha256,
  ];
  if (required.some((value) => typeof value !== 'string' || !value)) return null;

  const paths = [
    safeResolveSpriteAssetPath(record.id, current.atlasPath),
    safeResolveSpriteAssetPath(record.id, current.manifestPath),
  ];
  if (paths.some((path) => !path)) {
    return blocked(
      'sprite',
      identity,
      'SPRITE_ATLAS_INTEGRITY_FAILED',
      `The runtime atlas paths for "${record.name}" are invalid`,
      'Runtime atlas path invalid',
    );
  }

  const [atlasSha256, manifestSha256] = await Promise.all(paths.map(hashIfPresent));
  if (atlasSha256 !== current.atlasSha256 || manifestSha256 !== current.manifestSha256) {
    return blocked(
      'sprite',
      identity,
      'SPRITE_ATLAS_INTEGRITY_FAILED',
      `The runtime atlas for "${record.name}" is missing, unreadable, or does not match its recorded hash`,
      'Runtime atlas integrity failed',
    );
  }

  return {
    item: {
      spriteId: record.id,
      name: record.name,
      kind: record.kind,
      sourceType: 'runtime-atlas',
      atlasVersion: current.version,
      atlasPath: `sprites/${record.id}/${current.atlasPath}`,
      atlasSha256,
      manifestPath: `sprites/${record.id}/${current.manifestPath}`,
      manifestSha256,
      geometry: current.geometry,
    },
    summary: {
      ...identity,
      status: 'ready',
      sourceType: 'runtime-atlas',
      // The atlas sheet plus its manifest — the two files hashed above.
      fileCount: paths.length,
      message: `Runtime atlas v${current.version}`,
    },
  };
}

async function resolveImportedAssets(record) {
  const identity = { assetId: record.id, name: record.name, kind: record.kind };
  const runtimeAssets = await listRuntimeAtlasAssets(record.id);
  if (runtimeAssets.length === 0) return null;

  const assets = await Promise.all(runtimeAssets.map(async (asset) => ({
    path: `sprites/${record.id}/${asset.path}`,
    sha256: await hashIfPresent(safeResolveSpriteAssetPath(record.id, asset.path)),
    sizeBytes: asset.size,
  })));
  if (assets.some((asset) => !asset.sha256)) {
    return blocked(
      'sprite',
      identity,
      'SPRITE_ATLAS_INTEGRITY_FAILED',
      `An imported runtime asset for "${record.name}" is missing or unreadable`,
      'Imported asset integrity failed',
    );
  }

  return {
    item: {
      spriteId: record.id,
      name: record.name,
      kind: record.kind,
      sourceType: 'imported-assets',
      assets,
    },
    summary: {
      ...identity,
      status: 'ready',
      sourceType: 'imported-assets',
      fileCount: assets.length,
      message: `${assets.length} imported runtime ${assets.length === 1 ? 'file' : 'files'}`,
    },
  };
}

async function resolveSprite(binding) {
  // The atlas pointer is keyed on the same id as the record, so both reads can
  // start together — a missing record wastes one cheap pointer read rather than
  // serializing two round trips for every bound sprite on every preflight. The
  // id guard keeps a corrupt binding a SPRITE_MISSING row instead of a 400 out
  // of `spriteDir`.
  const [record, atlas] = await Promise.all([
    getSpriteRecord(binding.spriteId),
    isValidSpriteId(binding.spriteId) ? getAtlasState(binding.spriteId) : { current: null },
  ]);
  if (!record) {
    return blocked(
      'sprite',
      { assetId: binding.spriteId, name: binding.spriteId },
      'SPRITE_MISSING',
      `Bound sprite no longer exists: ${binding.spriteId}`,
    );
  }
  const identity = { assetId: record.id, name: record.name, kind: record.kind };

  const runtime = await resolveRuntimeAtlas(record, atlas.current);
  if (runtime) return runtime;

  const imported = await resolveImportedAssets(record);
  if (imported) return imported;

  return blocked(
    'sprite',
    identity,
    'SPRITE_ATLAS_REQUIRED',
    `Compile or import a runtime atlas for "${record.name}" before building the game bundle`,
    'Runtime atlas required',
  );
}

async function resolveMusic(binding) {
  const track = await getTrack(binding.trackId);
  if (!track) {
    return blocked(
      'music',
      { assetId: binding.trackId, bindingId: binding.id, name: binding.trackId },
      'TRACK_MISSING',
      `Bound music track no longer exists: ${binding.trackId}`,
    );
  }
  const identity = { assetId: track.id, bindingId: binding.id, name: track.title };

  // `statMusicTrack` THROWS a 400 on an unsupported filename, and `sanitizeTrack`
  // only trims the top-level `audioFilename` — so a legacy or peer-synced track
  // can reach here with one. Screen it first, or one bad track fails the whole
  // read-only preflight instead of naming itself (same reason the sprite path
  // guards on `isValidSpriteId`).
  if (!isSafeMusicFilename(track.audioFilename) || !(await statMusicTrack(track.audioFilename))) {
    return blocked(
      'music',
      identity,
      'TRACK_AUDIO_REQUIRED',
      `Render or upload audio for "${track.title}" before building the game bundle`,
      'Audio render required',
    );
  }

  const audioSha256 = await hashIfPresent(join(PATHS.music, track.audioFilename));
  if (!audioSha256) {
    return blocked(
      'music',
      identity,
      'TRACK_AUDIO_INTEGRITY_FAILED',
      `The rendered audio for "${track.title}" is missing or unreadable`,
      'Audio integrity failed',
    );
  }

  return {
    item: {
      bindingId: binding.id,
      trackId: track.id,
      title: track.title,
      audioPath: `music/${track.audioFilename}`,
      audioSha256,
    },
    summary: {
      ...identity,
      status: 'ready',
      fileCount: 1,
      message: 'Audio ready',
    },
  };
}

export async function resolveGameAssets(game) {
  const [spriteResults, musicResults] = await Promise.all([
    Promise.all([...game.spriteBindings]
      .sort((a, b) => a.spriteId.localeCompare(b.spriteId))
      .map(resolveSprite)),
    Promise.all([...game.musicBindings]
      .sort((a, b) => a.trackId.localeCompare(b.trackId) || a.id.localeCompare(b.id))
      .map(resolveMusic)),
  ]);
  const issues = [...spriteResults, ...musicResults]
    .map((result) => result.problem)
    .filter(Boolean);
  const sprites = spriteResults.map((result) => result.item).filter(Boolean);
  const music = musicResults.map((result) => result.item).filter(Boolean);
  const summaries = {
    sprites: spriteResults.map((result) => result.summary),
    music: musicResults.map((result) => result.summary),
  };
  const inputs = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    gameId: game.id,
    appId: game.appId,
    sprites,
    music,
  };
  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    sprites,
    music,
    issues,
    inputSha256: sha256Text(canonicalStringify(inputs)),
    summaries,
    // "How many files does this asset contribute" is answered once, by the
    // resolver that hashed them. The compiled manifest pointer and the
    // preflight both read this, so a new source type can't make the two
    // numbers disagree on screen.
    verifiedFileCount: [...summaries.sprites, ...summaries.music]
      .reduce((sum, asset) => sum + (asset.fileCount || 0), 0),
  };
}

async function inspectCurrentBundle(game, resolved) {
  const current = game.compiledManifest;
  if (!current) return { status: 'missing', message: 'No bundle has been built yet' };
  const corrupt = {
    status: 'corrupt',
    message: 'The current bundle manifest is missing or failed integrity verification',
  };
  if (!current.manifestPath) return corrupt;
  const path = join(gameRecordDir(game.id), current.manifestPath);
  const [actualSha256, manifest] = await Promise.all([
    hashIfPresent(path),
    readJSONFile(path, null, { logError: false }),
  ]);
  if (!actualSha256
    || actualSha256 !== current.manifestSha256
    || manifest?.kind !== 'portos-game-assets'
    || manifest?.game?.id !== game.id
    || manifest?.version !== current.version) {
    return corrupt;
  }
  if (current.inputSha256 !== resolved.inputSha256 || resolved.issues.length > 0) {
    return {
      status: 'stale',
      message: 'Bound assets changed after this bundle was built',
    };
  }
  return {
    status: 'current',
    message: 'Bundle manifest and every bound asset hash are verified',
  };
}

export async function getGameIntegrity(id) {
  const game = await getGame(id);
  if (!game) return null;
  // The app lookup is independent of the hashing sweep — don't make it wait.
  const [app, resolved] = await Promise.all([
    getAppById(game.appId),
    resolveGameAssets(game),
  ]);
  // Inspect the bundle against the ASSET issues only, BEFORE the app blocker is
  // appended: `inspectCurrentBundle` reads a non-empty issue list as evidence
  // the bound assets drifted, so a missing managed app would otherwise report a
  // byte-perfect bundle as `stale` — "Bound assets changed after this bundle was
  // built" — which is a false statement about the assets, and pairs an amber
  // "Needs rebuild" badge with a disabled Rebuild button.
  const bundle = await inspectCurrentBundle(game, resolved);
  if (!app) {
    resolved.issues.push(issue(
      'app',
      game.appId,
      game.name,
      'APP_MISSING',
      'The bound managed app no longer exists',
    ));
  }
  const readyToCompile = resolved.issues.length === 0 && Boolean(app);
  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    readyToCompile,
    canLaunch: readyToCompile && bundle.status === 'current',
    bundle,
    issues: resolved.issues,
    assets: resolved.summaries,
    counts: {
      spriteReady: resolved.sprites.length,
      spriteTotal: game.spriteBindings.length,
      musicReady: resolved.music.length,
      musicTotal: game.musicBindings.length,
      verifiedFiles: resolved.verifiedFileCount,
    },
  };
}
