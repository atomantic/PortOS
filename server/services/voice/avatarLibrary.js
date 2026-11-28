/**
 * Voice Call avatar library: the portraits in the fixed Avatars media collection and the
 * transceiver channels each one is assigned to.
 *
 * Storage: avatars are images in the `avatars` media collection, so they federate through
 * the `mediaCollections` sync category (records plus image bytes) like any other collection.
 * Channel assignments are machine-local settings (`settings.voiceAvatarChannels`): each
 * install picks which shared avatar answers on which of its channels.
 */

import { join } from 'node:path';
import { access, readFile } from 'node:fs/promises';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS } from '../../lib/fileUtils.js';
import { AVATAR_CHANNEL_COUNT, AVATAR_CHANNEL_LABEL_MAX } from '../../lib/voiceValidation.js';
import { getSettings, updateSettingsWith } from '../settings.js';
import { emitToOperators } from '../socketIo.js';
import { ERR_DUPLICATE, ERR_NOT_FOUND, itemKey } from '../mediaCollections/collectionStore.js';
import { addItem, removeItem } from '../mediaCollections/collectionEdits.js';
import { AVATAR_COLLECTION_ID, findOrCreateAvatarCollection } from '../mediaCollections/ownerAdapters.js';

const SETTINGS_KEY = 'voiceAvatarChannels';
const PORTRAIT_EDGE = 512;
// Bounds the bytes decoded into a portrait; generated stills are far smaller.
const MAX_PORTRAIT_SOURCE_BYTES = 40 * 1024 * 1024;

const isSafeFilename = (value) => typeof value === 'string' && value.length > 0 && value.length <= 255
  && !/[\\/\0]/.test(value) && value !== '.' && value !== '..';

const blankChannel = () => ({ label: '', avatar: null });

/** Normalize a stored channels record; anything malformed falls back per field. */
export function normalizeChannels(raw) {
  const list = Array.isArray(raw?.channels) ? raw.channels : [];
  const channels = Array.from({ length: AVATAR_CHANNEL_COUNT }, (_, index) => {
    const entry = list[index];
    if (!entry || typeof entry !== 'object') return blankChannel();
    return {
      label: typeof entry.label === 'string' ? entry.label.trim().slice(0, AVATAR_CHANNEL_LABEL_MAX) : '',
      avatar: isSafeFilename(entry.avatar) ? entry.avatar : null,
    };
  });
  const active = Number.isInteger(raw?.active) && raw.active >= 0 && raw.active < AVATAR_CHANNEL_COUNT ? raw.active : 0;
  return { active, channels };
}

const readChannels = async () => normalizeChannels((await getSettings())?.[SETTINGS_KEY]);

const announce = () => emitToOperators('voice:avatar:library:changed');

/** The Avatars collection's images (newest first) plus this install's channel assignments. */
export async function getAvatarLibrary() {
  const collection = await findOrCreateAvatarCollection();
  const avatars = collection.items
    .filter((item) => item.kind === 'image' && isSafeFilename(item.ref))
    .sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)))
    .map((item) => ({ filename: item.ref, addedAt: item.addedAt }));
  return { collectionId: collection.id, collectionName: collection.name, avatars, ...(await readChannels()) };
}

/** Replace the channel assignments and/or the active channel. */
export async function updateAvatarChannels(patch) {
  await updateSettingsWith((settings) => {
    const current = normalizeChannels(settings[SETTINGS_KEY]);
    const next = normalizeChannels({
      active: patch.active ?? current.active,
      channels: patch.channels ?? current.channels,
    });
    return { ...settings, [SETTINGS_KEY]: next };
  });
  announce();
  return getAvatarLibrary();
}

/** File an existing gallery image into the Avatars collection. Idempotent. */
export async function addAvatar(filename) {
  if (!isSafeFilename(filename)) throw new ServerError('Invalid image file name', { status: 400, code: 'VALIDATION_ERROR' });
  await access(join(PATHS.images, filename)).catch((error) => {
    if (error.code === 'ENOENT') throw new ServerError('That image is not in the gallery', { status: 404, code: 'NOT_FOUND' });
    throw error;
  });
  await findOrCreateAvatarCollection();
  await addItem(AVATAR_COLLECTION_ID, { kind: 'image', ref: filename }).catch((error) => {
    if (error?.code !== ERR_DUPLICATE) throw error;
  });
  announce();
  return getAvatarLibrary();
}

/** Remove an image from the Avatars collection (the gallery image stays) and clear its channels. */
export async function removeAvatar(filename) {
  if (!isSafeFilename(filename)) throw new ServerError('Invalid image file name', { status: 400, code: 'VALIDATION_ERROR' });
  await removeItem(AVATAR_COLLECTION_ID, itemKey({ kind: 'image', ref: filename })).catch((error) => {
    if (error?.code !== ERR_NOT_FOUND) throw error;
  });
  await updateSettingsWith((settings) => {
    const current = normalizeChannels(settings[SETTINGS_KEY]);
    if (!current.channels.some((channel) => channel.avatar === filename)) return settings;
    const channels = current.channels.map((channel) => (channel.avatar === filename ? { ...channel, avatar: null } : channel));
    return { ...settings, [SETTINGS_KEY]: { ...current, channels } };
  });
  announce();
  return getAvatarLibrary();
}

/** The active channel's avatar filename, or null for the bundled default portrait. */
export async function getActiveAvatarFilename() {
  const { active, channels } = await readChannels();
  return channels[active]?.avatar ?? null;
}

/**
 * The active avatar as a 512px square JPEG for AvatarForcing, or null for the bundled
 * portrait. A missing (not yet synced) or undecodable image also falls back to null so
 * the call keeps a face.
 */
export async function loadAvatarPortrait(filename) {
  if (!isSafeFilename(filename)) return null;
  const bytes = await readFile(join(PATHS.images, filename)).catch(() => null);
  if (!bytes || bytes.length > MAX_PORTRAIT_SOURCE_BYTES) return null;
  const { default: sharp } = await import('sharp');
  return sharp(bytes, { limitInputPixels: 64_000_000 })
    .rotate()
    .resize(PORTRAIT_EDGE, PORTRAIT_EDGE, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 92 })
    .toBuffer()
    .catch((error) => {
      console.log(`🎭 Avatar portrait ${filename} could not be decoded; using the default portrait (${error.message})`);
      return null;
    });
}
