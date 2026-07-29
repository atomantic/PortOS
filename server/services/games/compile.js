/**
 * Deterministic Game asset-bundle compiler.
 *
 * The manifest references immutable sprite atlas versions and music-library
 * bytes by SHA-256. Recompiling identical inputs returns the current pointer
 * without writing a new version.
 */

import { join } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { atomicWrite, pathExists, sha256File, sha256Text } from '../../lib/fileUtils.js';
import { canonicalStringify } from '../../lib/objects.js';
import { getAppById } from '../apps.js';
import { GAME_HISTORY_LIMIT, sanitizeGame } from './records.js';
import { resolveGameAssets } from './integrity.js';
import { gameRecordDir, isValidGameId, queueGameWrite, readRaw, writeRaw } from './store.js';

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

    const resolved = await resolveGameAssets(game);
    if (resolved.issues.length > 0) {
      const first = resolved.issues[0];
      throw new ServerError(first.message, {
        status: 409,
        code: first.code,
        context: { issues: resolved.issues },
      });
    }
    const { sprites, music, inputSha256, schemaVersion, verifiedFileCount } = resolved;
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
      schemaVersion,
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
      schemaVersion,
      version,
      builtAt,
      manifestPath,
      manifestSha256: sha256Text(serialized),
      inputSha256,
      spriteCount: sprites.length,
      musicCount: music.length,
      verifiedFileCount,
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
