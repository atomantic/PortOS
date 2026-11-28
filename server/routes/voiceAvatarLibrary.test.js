import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy, mockNoPeerSync } from '../lib/mockPathsDataRoot.js';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { request } from '../lib/testHelper.js';
import { defaultRequestBody } from '../lib/defaultRequestBody.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { isHostControlRoute } from '../lib/hostControlRoutes.js';
import { PATHS } from '../lib/fileUtils.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-avatar-library-') }));
vi.mock('../services/sharing/peerSync.js', () => mockNoPeerSync());
vi.mock('../services/socketIo.js', () => ({ emitToOperators: vi.fn(), emitToOperatorsOn: vi.fn() }));

const { default: router } = await import('./voiceAvatar.js');
const { getActiveAvatarFilename, loadAvatarPortrait, normalizeChannels } = await import('../services/voice/avatarLibrary.js');
const { AVATAR_CHANNEL_LABEL_MAX } = await import('../lib/voiceChannels.js');
const { emitToOperators } = await import('../services/socketIo.js');

const base = '/api/voice/avatar';
const app = express();
app.use(express.json());
app.use(defaultRequestBody);
app.use(base, router);
app.use(errorMiddleware);
afterAll(cleanupTempDataRoots);

const png = (color) => sharp({ create: { width: 800, height: 600, channels: 3, background: color } }).png().toBuffer();

beforeEach(async () => {
  await rm(join(PATHS.data, 'media-collections'), { recursive: true, force: true });
  await rm(join(PATHS.data, 'settings.json'), { force: true });
  await mkdir(PATHS.images, { recursive: true });
});

it('keeps library writes behind host control while reads stay open', () => {
  expect(isHostControlRoute('GET', base + '/library')).toBe(false);
  expect(isHostControlRoute('POST', base + '/library')).toBe(true);
  expect(isHostControlRoute('DELETE', base + '/library/face.png')).toBe(true);
  expect(isHostControlRoute('PUT', base + '/channels')).toBe(true);
});

it('files gallery images into the fixed Avatars collection and assigns them to channels', async () => {
  const empty = await request(app).get(base + '/library');
  expect(empty.status).toBe(200);
  expect(empty.body).toMatchObject({ collectionId: 'avatars', collectionName: 'Avatars', avatars: [], active: 0 });
  expect(empty.body.channels).toHaveLength(6);
  expect(empty.body.channels.every((channel) => channel.avatar === null && channel.label === '')).toBe(true);

  expect((await request(app).post(base + '/library').send({ filename: 'missing.png' })).status).toBe(404);
  expect((await request(app).post(base + '/library').send({ filename: '../settings.json' })).status).toBe(400);

  await writeFile(join(PATHS.images, 'face.png'), await png('#336699'));
  const added = await request(app).post(base + '/library').send({ filename: 'face.png' });
  expect(added.status).toBe(200);
  expect(added.body.avatars.map((avatar) => avatar.filename)).toEqual(['face.png']);
  // Re-adding is idempotent.
  expect((await request(app).post(base + '/library').send({ filename: 'face.png' })).body.avatars).toHaveLength(1);

  const channels = added.body.channels.map((channel, index) => (index === 2 ? { label: 'Scout', avatar: 'face.png' } : channel));
  expect((await request(app).put(base + '/channels').send({ channels: channels.slice(0, 5) })).status).toBe(400);
  expect((await request(app).put(base + '/channels').send({ active: 6 })).status).toBe(400);
  expect((await request(app).put(base + '/channels').send({})).status).toBe(400);
  const saved = await request(app).put(base + '/channels').send({ channels, active: 2 });
  expect(saved.status).toBe(200);
  expect(saved.body.active).toBe(2);
  expect(saved.body.channels[2]).toEqual({ label: 'Scout', avatar: 'face.png', agent: {} });
  expect(await getActiveAvatarFilename()).toBe('face.png');

  const removed = await request(app).delete(base + '/library/face.png');
  expect(removed.status).toBe(200);
  expect(removed.body.avatars).toEqual([]);
  expect(removed.body.channels[2]).toEqual({ label: 'Scout', avatar: null, agent: {} });
  expect(await getActiveAvatarFilename()).toBeNull();
});

it('renders an assigned avatar as a 512px square JPEG and falls back to the default face', async () => {
  await writeFile(join(PATHS.images, 'wide.png'), await png('#aa3311'));
  const jpeg = await loadAvatarPortrait('wide.png');
  const meta = await sharp(jpeg).metadata();
  expect(meta).toMatchObject({ format: 'jpeg', width: 512, height: 512 });

  await writeFile(join(PATHS.images, 'broken.png'), 'not an image');
  expect(await loadAvatarPortrait('broken.png')).toBeNull();
  expect(await loadAvatarPortrait('not-synced-yet.png')).toBeNull();
  expect(await loadAvatarPortrait('../settings.json')).toBeNull();
});

it('preserves omitted fields on partial channel updates, emits library change events, and sanitizes stored channels', async () => {
  vi.clearAllMocks();
  await writeFile(join(PATHS.images, 'pilot.png'), await png('#224466'));
  const added = await request(app).post(base + '/library').send({ filename: 'pilot.png' });
  expect(emitToOperators).toHaveBeenCalledWith('voice:avatar:library:changed');

  const channels = added.body.channels.map((ch, idx) => (idx === 1 ? { label: 'Pilot', avatar: 'pilot.png' } : ch));
  await request(app).put(base + '/channels').send({ channels });
  const activeOnly = await request(app).put(base + '/channels').send({ active: 1 });
  expect(activeOnly.status).toBe(200);
  expect(activeOnly.body.active).toBe(1);
  expect(activeOnly.body.channels[1]).toEqual({ label: 'Pilot', avatar: 'pilot.png', agent: {} });

  // A channel's agent keeps only the overrides it was given; the rest inherit.
  const tuned = activeOnly.body.channels.map((ch, idx) => (idx === 1
    ? { ...ch, agent: { voiceId: 'qwen3:warm', provider: 'ollama', name: '  Scout ', traits: ['dry', 'dry', ''] } }
    : ch));
  const withAgent = await request(app).put(base + '/channels').send({ channels: tuned });
  expect(withAgent.status).toBe(200);
  expect(withAgent.body.channels[1].agent).toEqual({
    voiceId: 'qwen3-tts:warm', provider: 'ollama', model: 'auto', name: 'Scout', traits: ['dry'],
  });
  const badAgent = await request(app).put(base + '/channels').send({
    channels: tuned.map((ch, idx) => (idx === 1 ? { ...ch, agent: { temperature: 2 } } : ch)),
  });
  expect(badAgent.status).toBe(400);

  // Single-channel edits merge server-side, so overlapping edits to different fields both land.
  expect(isHostControlRoute('PATCH', base + '/channels/1')).toBe(true);
  await request(app).patch(base + '/channels/1').send({ agent: null });
  await Promise.all([
    request(app).patch(base + '/channels/1').send({ label: 'Ranger' }),
    request(app).patch(base + '/channels/1').send({ agent: { speechStyle: 'dry' } }),
  ]);
  const merged = await request(app).get(base + '/library');
  expect(merged.body.channels[1]).toEqual({ label: 'Ranger', avatar: 'pilot.png', agent: { speechStyle: 'dry' } });
  // Agent edits merge field by field: overlapping edits keep each other, null clears one, agent: null clears all.
  await Promise.all([
    request(app).patch(base + '/channels/1').send({ agent: { name: 'Scout' } }),
    request(app).patch(base + '/channels/1').send({ agent: { provider: 'ollama', model: 'm' } }),
  ]);
  const fieldWise = await request(app).patch(base + '/channels/1').send({ agent: { speechStyle: null } });
  expect(fieldWise.body.channels[1].agent).toEqual({ name: 'Scout', provider: 'ollama', model: 'm' });
  const cleared = await request(app).patch(base + '/channels/1').send({ agent: { provider: null } });
  expect(cleared.body.channels[1].agent).toEqual({ name: 'Scout' });
  expect((await request(app).patch(base + '/channels/1').send({ agent: null })).body.channels[1].agent).toEqual({});
  expect((await request(app).patch(base + '/channels/6').send({ label: 'x' })).status).toBe(400);
  expect((await request(app).patch(base + '/channels/1').send({})).status).toBe(400);

  const sanitized = normalizeChannels({
    active: 99,
    channels: [
      { label: '  ' + 'x'.repeat(80), avatar: '../escape.png' },
      null,
      { label: 'Valid', avatar: 'ok.png' },
    ],
  });
  expect(sanitized.active).toBe(0);
  expect(sanitized.channels).toHaveLength(6);
  expect(sanitized.channels[0]).toEqual({ label: 'x'.repeat(AVATAR_CHANNEL_LABEL_MAX), avatar: null, agent: {} });
  expect(sanitized.channels[1]).toEqual({ label: '', avatar: null, agent: {} });
  expect(sanitized.channels[2]).toEqual({ label: 'Valid', avatar: 'ok.png', agent: {} });
});
