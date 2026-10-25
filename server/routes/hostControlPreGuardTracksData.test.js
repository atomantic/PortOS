import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { unlink } from 'node:fs/promises';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-pre-guard-tracks-data-') }));
afterAll(cleanupTempDataRoots);

// Pre-guard audit remainder (#13055): track uploads and takes, the Suno import,
// SuperCollider renders, game asset publication, a conflict restore, the repo
// probe, data archive, Signal sync and setup check, snapshot apply and LoRA
// checkpoint promotion each run host work. Real routers behind the real gates;
// only the service effect is doubled, and it never runs for a refused caller.
const auth = vi.hoisted(() => ({ enabled: false }));
const effects = vi.hoisted(() => ({
  getTrack: vi.fn(async (id) => ({ id })),
  importUpload: vi.fn(),
  probeDuration: vi.fn(async () => 4),
  attachAudio: vi.fn(async (id) => ({ id })),
  codeTake: vi.fn(async () => ({ filename: 'example.ogg' })),
  superColliderTake: vi.fn(async () => ({ filename: 'example.ogg' })),
  sunoImport: vi.fn(async () => ({ jobId: 'example-suno-job' })),
  chiptuneRender: vi.fn(async () => ({ track: {} })),
  superColliderStatus: vi.fn(async () => ({ ready: true, state: 'ready' })),
  enqueue: vi.fn(async () => ({ jobId: 'example-render', status: 'queued' })),
  resolveConflict: vi.fn(async () => ({ resolved: true })),
  publishArtwork: vi.fn(async () => ({ published: true })),
  publishMusic: vi.fn(async () => ({ published: true })),
  archive: vi.fn(async () => ({ archived: true })),
  getRun: vi.fn(async (id) => ({ id, status: 'completed' })),
  promote: vi.fn(async () => ({ promoted: true })),
  signalSetup: vi.fn(async () => ({ ok: true })),
  signalSync: vi.fn(async () => ({ ok: true })),
  applyRemote: vi.fn(async () => ({ applied: true })),
  probe: vi.fn(() => false),
}));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyPassword: vi.fn(async () => true),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/instanceIdentity.js', () => ({
  ensureInstanceId: vi.fn(async () => 'example-self'),
  loadData: vi.fn(async () => ({ peers: [{
    id: 'example-peer', instanceId: 'example-instance', enabled: true, syncSecret: 'a'.repeat(32),
  }] })),
}));
// The repo probe's first host read is `existsSync(path)`; every other caller
// keeps the real filesystem.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, existsSync: (path) => (path === '/example/project' ? effects.probe(path) : actual.existsSync(path)) };
});
vi.mock('../services/tracks/index.js', async () => ({
  ...await import('../services/tracks/logic.js'),
  getTrack: effects.getTrack,
}));
vi.mock('../services/pipeline/musicLibrary.js', () => ({
  MUSIC_UPLOAD_MAX_BYTES: 1024 * 1024,
  isSupportedMusicUpload: () => true,
  assertSafeMusicFilename: vi.fn(),
  importUploadedTrack: effects.importUpload,
}));
vi.mock('../lib/ffmpeg.js', () => ({ probeVideoDuration: effects.probeDuration }));
vi.mock('../services/trackAudioAttach.js', () => ({ attachAudioAsRender: effects.attachAudio }));
vi.mock('../services/trackSunoImport.js', () => ({ startSunoImport: effects.sunoImport }));
vi.mock('../services/chiptune.js', () => ({ renderChiptuneTrack: effects.chiptuneRender }));
vi.mock('../services/musicCode.js', () => ({
  MUSIC_CODE_MAX: 20000,
  saveCodeTakeToTrack: effects.codeTake,
  saveSuperColliderTakeToTrack: effects.superColliderTake,
}));
vi.mock('../services/trackAlbumMembership.js', () => ({}));
vi.mock('../services/trackYoutubeImport.js', () => ({}));
vi.mock('../services/musicWaveform.js', () => ({}));
vi.mock('../services/superColliderRuntime.js', () => ({ getSuperColliderStatus: effects.superColliderStatus }));
vi.mock('../services/superColliderRender.js', () => ({ superColliderSourceHash: () => 'example-source-hash' }));
vi.mock('../services/mediaJobQueue/index.js', () => ({ enqueueJob: effects.enqueue }));
vi.mock('../lib/conflictJournal.js', () => ({ isBaseHashPersistBlocked: vi.fn(async () => false) }));
vi.mock('../services/conflictJournalResolver.js', () => ({
  ERR_NOT_FOUND: 'CONFLICT_JOURNAL_NOT_FOUND',
  ERR_VALIDATION: 'CONFLICT_JOURNAL_VALIDATION',
  ERR_TARGET_GONE: 'CONFLICT_TARGET_GONE',
  resolveConflict: effects.resolveConflict,
}));
vi.mock('../services/games/index.js', () => ({
  publishGameArtwork: effects.publishArtwork,
  publishGameMusic: effects.publishMusic,
}));
vi.mock('../services/dataManager.js', () => ({ archiveCategory: effects.archive }));
vi.mock('../services/loraTraining/index.js', () => ({
  getRunRequired: effects.getRun,
  promoteCheckpoint: effects.promote,
}));
vi.mock('../lib/pythonSetup.js', () => ({}));
vi.mock('../services/signalSync.js', () => ({ checkSetup: effects.signalSetup, runSync: effects.signalSync }));
vi.mock('../services/dataSync.js', () => ({ applyRemote: effects.applyRemote }));
vi.mock('../services/sharing/tombstoneGc.js', () => ({ TOMBSTONE_GRACE_MS: 24 * 60 * 60 * 1000 }));
vi.mock('../services/sharing/peerPullAuthorization.js', () => ({}));
vi.mock('../services/pm2.js', () => ({}));
vi.mock('../services/aiDetect.js', () => ({}));

import { authGate, hostControlBodyGate, hostControlRouteGate } from '../services/authGate.js';
import { createSession } from '../services/auth.js';
import tracksRoutes from './tracks.js';
import superColliderRoutes from './superCollider.js';
import conflictJournalRoutes from './conflictJournal.js';
import gamesRoutes from './games.js';
import dataManagerRoutes from './dataManager.js';
import loraTrainingRoutes from './loraTraining.js';
import signalRoutes from './signal.js';
import dataSyncRoutes from './dataSync.js';
import detectRoutes from './detect.js';

effects.importUpload.mockImplementation(async (path) => {
  await unlink(path);
  return { filename: 'example.mp3', sizeBytes: 11 };
});

const BOUNDARY = 'example-boundary';
const multipart = (filename, mime, fields = {}) => ({
  contentType: `multipart/form-data; boundary=${BOUNDARY}`,
  bytes: Buffer.concat([
    ...Object.entries(fields).map(([name, value]) =>
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)),
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="track"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
    Buffer.from('RIFFexample'),
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]),
});

const trackId = '11111111-1111-4111-8111-111111111111';
const gameId = 'game-11111111-1111-4111-8111-111111111111';
const restore = ['post', '/api/conflict-journal/example-conflict-1/resolve', { action: 'restore-all' }, effects.resolveConflict, 200];
const operations = [
  ['post', `/api/tracks/${trackId}/audio/upload`, multipart('example.mp3', 'audio/mpeg', { source: 'upload' }), effects.attachAudio, 200],
  ['post', `/api/tracks/${trackId}/code/render`, multipart('example.wav', 'audio/wav', { prompt: 'Example take' }), effects.codeTake, 200],
  ['post', `/api/tracks/${trackId}/supercollider/take`, { jobId: 'example-job-0001' }, effects.superColliderTake, 200],
  ['post', '/api/tracks/import/suno', { url: 'https://suno.com/song/11111111-1111-4111-8111-111111111111' }, effects.sunoImport, 202],
  ['post', '/api/music/supercollider/render', { code: '{ SinOsc.ar(440) * 0.1 }', durationSec: 4 }, effects.enqueue, 202],
  ['post', `/api/games/${gameId}/artwork/artwork-1/publish`, {}, effects.publishArtwork, 200],
  ['post', `/api/games/${gameId}/music/music-1/publish`, {}, effects.publishMusic, 200],
  ['post', '/api/detect/repo', { path: '/example/project' }, effects.probe, 200],
  ['post', '/api/data/health/archive', { daysToKeep: 365 }, effects.archive, 200],
  ['post', '/api/signal/sync', {}, effects.signalSync, 200],
  ['get', '/api/signal/setup-check', undefined, effects.signalSetup, 200],
  ['post', '/api/sync/digitalTwin/apply', { data: {} }, effects.applyRemote, 200],
  ['post', '/api/lora-training/runs/run-example/promote-checkpoint', { step: 300 }, effects.promote, 200],
];

const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json(), hostControlBodyGate);
  app.use('/api/tracks', tracksRoutes);
  app.use('/api/music/supercollider', superColliderRoutes);
  app.use('/api/conflict-journal', conflictJournalRoutes);
  app.use('/api/games', gamesRoutes);
  app.use('/api/data', dataManagerRoutes);
  app.use('/api/lora-training', loraTrainingRoutes);
  app.use('/api/signal', signalRoutes);
  app.use('/api/sync', dataSyncRoutes);
  app.use('/api/detect', detectRoutes);
  app.use(errorMiddleware);
  return app;
};
const call = (app, [method, path, body], headers = {}) => {
  const pending = request(app)[method](path);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  if (body?.bytes) return pending.set('Content-Type', body.contentType).send(body.bytes);
  return body === undefined ? pending : pending.send(body);
};
const expectNoEffects = () => {
  for (const [name, effect] of Object.entries(effects)) expect(effect, name).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('pre-guard audit remainder: tracks, renders, publication and host data (#13055)', () => {
  it('refuses remote password-free callers, spoofed-proxy and case variants before any effect', async () => {
    for (const operation of [...operations, restore]) {
      const [method, path, body] = operation;
      const targets = operation === restore ? [path] : [path, path.toUpperCase() + '/'];
      for (const [address, headers] of [
        ['192.0.2.10', {}],
        ['127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }],
        ['192.0.2.10', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '127.0.0.1' }],
      ]) {
        for (const target of targets) {
          const response = await call(appFor(address), [method, target, body], headers);
          expect([response.status, response.body.code], `${method} ${target}`).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
        }
      }
    }
    expectNoEffects();
  });

  it('requires authentication with a password and denies legacy Basic and scoped-peer credentials', async () => {
    auth.enabled = true;
    for (const operation of [...operations, restore]) {
      for (const [headers, status, code] of [
        [{}, 401, 'AUTH_REQUIRED'],
        [{ Authorization: 'Basic ' + Buffer.from(':example-password').toString('base64') }, 403, 'HOST_CONTROL_FORBIDDEN'],
        [{
          [PEER_AUTH_HEADER]: derivePeerAuthToken('a'.repeat(32), 'example-instance'),
          [PEER_INSTANCE_HEADER]: 'example-instance',
        }, 403, 'PEER_SCOPE_FORBIDDEN'],
      ]) {
        const response = await call(appFor(), operation, headers);
        expect([response.status, response.body.code], `${operation[0]} ${operation[1]}`).toEqual([status, code]);
      }
    }
    expectNoEffects();
  });

  it('keeps working for local callers, operator sessions and delegated agent sessions', async () => {
    const operator = await createSession();
    const agent = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Authorization: `Bearer ${operator.token}` }],
      [true, '192.0.2.10', { Authorization: `Bearer ${agent.token}` }],
    ]) {
      auth.enabled = enabled;
      for (const operation of [...operations, restore]) {
        const [method, path, , effect, status] = operation;
        const previousCalls = effect.mock.calls.length;
        const response = await call(appFor(address), operation, headers);
        expect(response.status, `${method} ${path}: ${JSON.stringify(response.body)}`).toBe(status);
        expect(effect, `${method} ${path}`).toHaveBeenCalledTimes(previousCalls + 1);
      }
    }
    expect(effects.importUpload).toHaveBeenLastCalledWith(expect.any(String), 'example.mp3');
    expect(effects.codeTake).toHaveBeenLastCalledWith(expect.objectContaining({ trackId, prompt: 'Example take' }));
    expect(effects.enqueue).toHaveBeenLastCalledWith({ kind: 'supercollider', params: expect.objectContaining({
      source: '{ SinOsc.ar(440) * 0.1 }', durationSec: 4,
    }) });
    expect(effects.archive).toHaveBeenLastCalledWith('health', { daysToKeep: 365 });
    expect(effects.applyRemote).toHaveBeenLastCalledWith('digitalTwin', {}, { portosMeta: undefined });
    expect(effects.promote).toHaveBeenLastCalledWith('run-example', 300);
    expect(effects.resolveConflict).toHaveBeenLastCalledWith('example-conflict-1', { action: 'restore-all' });
  });

  it('leaves a conflict discard and the deterministic chiptune render open to a remote caller', async () => {
    const discard = await call(appFor(), ['post', restore[1], { action: 'discard' }]);
    expect(discard.status, JSON.stringify(discard.body)).toBe(200);
    expect(effects.resolveConflict).toHaveBeenCalledExactlyOnceWith('example-conflict-1', { action: 'discard' });
    const chiptune = await call(appFor(), ['post', `/api/tracks/${trackId}/chiptune/render`, {}]);
    expect(chiptune.status, JSON.stringify(chiptune.body)).toBe(200);
    expect(effects.chiptuneRender).toHaveBeenCalledExactlyOnceWith({ trackId });
  });
});
