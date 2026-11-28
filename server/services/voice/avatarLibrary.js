/**
 * Voice Call avatar library: the portraits in the fixed Avatars media collection and the
 * transceiver channels each one is assigned to.
 *
 * Storage: avatars are images in the `avatars` media collection, so they federate through
 * the `mediaCollections` sync category (records plus image bytes) like any other collection.
 * Channel assignments are machine-local settings (`settings.voiceAvatarChannels`): each
 * install picks which shared avatar answers on which of its channels, and what agent
 * (voice, LLM and persona overrides, see lib/voiceChannels.js) speaks there.
 */

import { join } from 'node:path';
import { access, readFile } from 'node:fs/promises';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS } from '../../lib/fileUtils.js';
import { mergeChannelAgentPatch, VOICE_CHANNELS_SETTINGS_KEY, normalizeChannels as normalizeChannelRecord } from '../../lib/voiceChannels.js';
import { getSettings, updateSettingsWith } from '../settings.js';
import { emitToOperators } from '../socketIo.js';
import { ERR_DUPLICATE, ERR_NOT_FOUND, itemKey } from '../mediaCollections/collectionStore.js';
import { addItem, removeItem } from '../mediaCollections/collectionEdits.js';
import { AVATAR_COLLECTION_ID, findOrCreateAvatarCollection } from '../mediaCollections/ownerAdapters.js';

const SETTINGS_KEY = VOICE_CHANNELS_SETTINGS_KEY;
const PORTRAIT_EDGE = 512;
// Bounds the bytes decoded into a portrait; generated stills are far smaller.
const MAX_PORTRAIT_SOURCE_BYTES = 40 * 1024 * 1024;

const isSafeFilename = (value) => typeof value === 'string' && value.length > 0 && value.length <= 255
  && !/[\\/\0]/.test(value) && value !== '.' && value !== '..';

/** Normalize a stored channels record; anything malformed falls back per field. */
export const normalizeChannels = (raw) => normalizeChannelRecord(raw, { isSafeFilename });

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

/**
 * Edit one channel in place. Merging inside the settings write, and merging `agent` field
 * by field, keeps overlapping edits to different channels or fields from overwriting each other.
 */
export async function updateAvatarChannel(index, patch) {
  await updateSettingsWith((settings) => {
    const current = normalizeChannels(settings[SETTINGS_KEY]);
    const { agent, ...fields } = patch;
    const channels = current.channels.map((channel, i) => (i !== index ? channel : {
      ...channel,
      ...fields,
      ...(agent !== undefined && { agent: mergeChannelAgentPatch(channel.agent, agent) }),
    }));
    return { ...settings, [SETTINGS_KEY]: normalizeChannels({ ...current, channels }) };
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
  try {
    const { default: sharp } = await import('sharp');
    return await sharp(bytes, { limitInputPixels: 64_000_000 })
      .rotate()
      .resize(PORTRAIT_EDGE, PORTRAIT_EDGE, { fit: 'cover', position: 'centre' })
      .jpeg({ quality: 92 })
      .toBuffer();
  } catch (error) {
    console.log(`🎭 Avatar portrait ${filename} could not be decoded; using the default portrait (${error.message})`);
    return null;
  }
}
