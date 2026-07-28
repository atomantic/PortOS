/**
 * Game record lifecycle and asset bindings.
 */

import { randomUUID } from 'crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { getAppById } from '../apps.js';
import { getRecord as getSpriteRecord } from '../sprites/records.js';
import { getTrack } from '../tracks/index.js';
import {
  deleteRaw,
  isValidGameId,
  listRaw,
  queueGameWrite,
  readRaw,
  writeRaw,
} from './store.js';

const HISTORY_LIMIT = 50;

const objectArray = (value) =>
  (Array.isArray(value) ? value.filter((entry) => entry && typeof entry === 'object') : []);
const boundedHistory = (value) => objectArray(value).slice(-HISTORY_LIMIT);

export function sanitizeGame(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || typeof raw.appId !== 'string') return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return null;
  return {
    id: raw.id,
    schemaVersion: 1,
    appId: raw.appId,
    name,
    spriteBindings: objectArray(raw.spriteBindings).filter((binding) => typeof binding.spriteId === 'string'),
    musicBindings: objectArray(raw.musicBindings).filter((binding) =>
      typeof binding.id === 'string' && typeof binding.trackId === 'string'),
    compiledManifest: raw.compiledManifest && typeof raw.compiledManifest === 'object'
      ? raw.compiledManifest
      : null,
    compileHistory: boundedHistory(raw.compileHistory),
    feedbackHistory: boundedHistory(raw.feedbackHistory),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
  };
}

const requireGameRaw = async (id) => {
  if (!isValidGameId(id)) {
    throw new ServerError('Game not found', { status: 404, code: 'NOT_FOUND' });
  }
  const game = sanitizeGame(await readRaw(id));
  if (!game) throw new ServerError('Game not found', { status: 404, code: 'NOT_FOUND' });
  return game;
};

const requireApp = async (appId) => {
  const app = await getAppById(appId);
  if (!app) throw new ServerError('Managed app not found', { status: 400, code: 'INVALID_APP' });
  return app;
};

export async function listGames() {
  const records = (await listRaw()).map(sanitizeGame).filter(Boolean);
  return records.sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name));
}

export async function getGame(id) {
  if (!isValidGameId(id)) return null;
  return sanitizeGame(await readRaw(id));
}

export async function createGame({ appId, name }) {
  await requireApp(appId);
  const now = new Date().toISOString();
  const game = sanitizeGame({
    id: `game-${randomUUID()}`,
    schemaVersion: 1,
    appId,
    name,
    spriteBindings: [],
    musicBindings: [],
    compiledManifest: null,
    compileHistory: [],
    feedbackHistory: [],
    createdAt: now,
    updatedAt: now,
  });
  await writeRaw(game.id, game);
  return game;
}

export function mutateGame(id, mutator) {
  if (!isValidGameId(id)) {
    throw new ServerError('Game not found', { status: 404, code: 'NOT_FOUND' });
  }
  return queueGameWrite(id, async () => {
    const current = await requireGameRaw(id);
    const changed = await mutator(current);
    if (!changed) return current;
    const next = sanitizeGame({ ...changed, id, updatedAt: new Date().toISOString() });
    if (!next) throw new ServerError('Invalid Game record', { status: 400, code: 'VALIDATION_ERROR' });
    await writeRaw(id, next);
    return next;
  });
}

export async function updateGame(id, patch) {
  if (patch.appId != null) await requireApp(patch.appId);
  return mutateGame(id, (current) => ({
    ...current,
    ...(patch.appId != null ? { appId: patch.appId } : {}),
    ...(patch.name != null ? { name: patch.name } : {}),
  }));
}

export async function deleteGame(id) {
  if (!isValidGameId(id)) {
    throw new ServerError('Game not found', { status: 404, code: 'NOT_FOUND' });
  }
  return queueGameWrite(id, async () => {
    await requireGameRaw(id);
    await deleteRaw(id);
    return { id };
  });
}

export async function bindSprite(id, { spriteId }) {
  const sprite = await getSpriteRecord(spriteId);
  if (!sprite) throw new ServerError('Sprite record not found', { status: 400, code: 'INVALID_SPRITE' });
  return mutateGame(id, (current) => {
    if (current.spriteBindings.some((binding) => binding.spriteId === spriteId)) {
      throw new ServerError('Sprite is already bound to this game', { status: 409, code: 'ALREADY_BOUND' });
    }
    return {
      ...current,
      spriteBindings: [...current.spriteBindings, {
        spriteId,
        boundAt: new Date().toISOString(),
      }],
    };
  });
}

export async function unbindSprite(id, spriteId) {
  return mutateGame(id, (current) => {
    if (!current.spriteBindings.some((binding) => binding.spriteId === spriteId)) {
      throw new ServerError('Sprite binding not found', { status: 404, code: 'NOT_FOUND' });
    }
    return {
      ...current,
      spriteBindings: current.spriteBindings.filter((binding) => binding.spriteId !== spriteId),
    };
  });
}

export async function bindMusic(id, { trackId }) {
  const track = await getTrack(trackId);
  if (!track) throw new ServerError('Music track not found', { status: 400, code: 'INVALID_TRACK' });
  return mutateGame(id, (current) => {
    if (current.musicBindings.some((binding) => binding.trackId === trackId)) {
      throw new ServerError('Music track is already bound to this game', { status: 409, code: 'ALREADY_BOUND' });
    }
    return {
      ...current,
      musicBindings: [...current.musicBindings, {
        id: `music-${randomUUID()}`,
        trackId,
        boundAt: new Date().toISOString(),
      }],
    };
  });
}

export async function unbindMusic(id, bindingId) {
  return mutateGame(id, (current) => {
    if (!current.musicBindings.some((binding) => binding.id === bindingId)) {
      throw new ServerError('Music binding not found', { status: 404, code: 'NOT_FOUND' });
    }
    return {
      ...current,
      musicBindings: current.musicBindings.filter((binding) => binding.id !== bindingId),
    };
  });
}

export const GAME_HISTORY_LIMIT = HISTORY_LIMIT;
