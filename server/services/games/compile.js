/**
 * Deterministic Game asset-bundle compiler.
 *
 * The manifest references immutable sprite atlas versions and music-library
 * bytes by SHA-256. Recompiling identical inputs returns the current pointer
 * without writing a new version.
 */

import { createHash } from 'crypto';
import { join } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { atomicWrite, pathExists, PATHS, sha256File } from '../../lib/fileUtils.js';
import { canonicalStringify } from '../../lib/objects.js';
import { getAppById } from '../apps.js';
import { statMusicTrack } from '../pipeline/musicLibrary.js';
import { getAtlasState } from '../sprites/atlas.js';
import { getRecord as getSpriteRecord } from '../sprites/records.js';
import { getTrack } from '../tracks/index.js';
import { GAME_HISTORY_LIMIT, sanitizeGame } from './records.js';
import { gameRecordDir, isValidGameId, queueGameWrite, readRaw, writeRaw } from './store.js';

const sha256Text = (value) => createHash('sha256').update(value).digest('hex');

async function resolveSprite(binding) {
  const [record, atlas] = await Promise.all([
    getSpriteRecord(binding.spriteId),
    getAtlasState(binding.spriteId),
  ]);
  if (!record) {
    throw new ServerError(`Bound sprite no longer exists: ${binding.spriteId}`, {
      status: 409,
      code: 'SPRITE_MISSING',
    });
  }
  if (!atlas.current?.atlasPath || !atlas.current?.atlasSha256
    || !atlas.current?.manifestPath || !atlas.current?.manifestSha256) {
    throw new ServerError(`Compile an atlas for "${record.name}" before building the game bundle`, {
      status: 409,
      code: 'SPRITE_ATLAS_REQUIRED',
    });
  }
  return {
    spriteId: record.id,
    name: record.name,
    kind: record.kind,
    atlasVersion: atlas.current.version,
    atlasPath: `sprites/${record.id}/${atlas.current.atlasPath}`,
    atlasSha256: atlas.current.atlasSha256,
    manifestPath: `sprites/${record.id}/${atlas.current.manifestPath}`,
    manifestSha256: atlas.current.manifestSha256,
    geometry: atlas.current.geometry,
  };
}

async function resolveMusic(binding) {
  const track = await getTrack(binding.trackId);
  if (!track) {
    throw new ServerError(`Bound music track no longer exists: ${binding.trackId}`, {
      status: 409,
      code: 'TRACK_MISSING',
    });
  }
  if (!track.audioFilename || !(await statMusicTrack(track.audioFilename))) {
    throw new ServerError(`Render or upload audio for "${track.title}" before building the game bundle`, {
      status: 409,
      code: 'TRACK_AUDIO_REQUIRED',
    });
  }
  return {
    bindingId: binding.id,
    trackId: track.id,
    title: track.title,
    audioPath: `music/${track.audioFilename}`,
    audioSha256: await sha256File(join(PATHS.music, track.audioFilename)),
  };
}

const manifestPathFor = (version) => `manifests/game-assets-v${version}.json`;

export async function compileGameAssets(id) {
  if (!isValidGameId(id)) {
    throw new ServerError('Game not found', { status: 404, code: 'NOT_FOUND' });
  }
  let result;
  await queueGameWrite(id, async () => {
    const game = sanitizeGame(await readRaw(id));
    if (!game) throw new ServerError('Game not found', { status: 404, code: 'NOT_FOUND' });
    const app = await getAppById(game.appId);
    if (!app) throw new ServerError('The bound managed app no longer exists', { status: 409, code: 'APP_MISSING' });

    const [sprites, music] = await Promise.all([
      Promise.all([...game.spriteBindings]
        .sort((a, b) => a.spriteId.localeCompare(b.spriteId))
        .map(resolveSprite)),
      Promise.all([...game.musicBindings]
        .sort((a, b) => a.trackId.localeCompare(b.trackId) || a.id.localeCompare(b.id))
        .map(resolveMusic)),
    ]);
    const inputs = { schemaVersion: 1, gameId: game.id, appId: game.appId, sprites, music };
    const inputSha256 = sha256Text(canonicalStringify(inputs));
    const current = game.compiledManifest;
    const currentPath = current?.manifestPath
      ? join(gameRecordDir(id), current.manifestPath)
      : null;
    if (current?.inputSha256 === inputSha256
      && current.manifestSha256
      && currentPath
      && await pathExists(currentPath)
      && await sha256File(currentPath) === current.manifestSha256) {
      result = { ...current, created: false };
      return;
    }

    const version = Math.max(0, ...game.compileHistory.map((entry) =>
      Number.isInteger(entry.version) ? entry.version : 0)) + 1;
    const builtAt = new Date().toISOString();
    const manifest = {
      schemaVersion: 1,
      kind: 'portos-game-assets',
      game: { id: game.id, name: game.name, appId: game.appId },
      version,
      builtAt,
      sprites,
      music,
    };
    const serialized = `${canonicalStringify(manifest)}\n`;
    const manifestPath = manifestPathFor(version);
    await atomicWrite(join(gameRecordDir(id), manifestPath), serialized);
    const pointer = {
      schemaVersion: 1,
      version,
      builtAt,
      manifestPath,
      manifestSha256: sha256Text(serialized),
      inputSha256,
      spriteCount: sprites.length,
      musicCount: music.length,
    };
    const next = sanitizeGame({
      ...game,
      compiledManifest: pointer,
      compileHistory: [...game.compileHistory, pointer].slice(-GAME_HISTORY_LIMIT),
      updatedAt: builtAt,
    });
    await writeRaw(id, next);
    result = { ...pointer, created: true };
  });
  return result;
}
