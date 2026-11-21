import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectAuthorizedWorkflows, expectRemoteRefusal } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-pre-guard-tracks-data-') }));
afterAll(cleanupTempDataRoots);

// Every write here is gated by the default-deny policy (#16018); the refusal and
// principal matrix live in services/authGate.test.js and server/test/guards/modules/hostControlCoverage.test.js.
// This suite proves each mounted router still runs behind the real gates for a
// local operator and a delegated agent session, and keeps the refusal/allow pair
// for the Signal setup check, a HOST_CONTROL_GET_ROUTES read of the keychain
// secret. Only the service effect is doubled.
const auth = vi.hoisted(() => ({ enabled: false }));
const effects = vi.hoisted(() => ({
  getTrack: vi.fn(async (id) => ({ id })),
  sunoImport: vi.fn(async () => ({ jobId: 'example-suno-job' })),
  superColliderStatus: vi.fn(async () => ({ ready: true, state: 'ready' })),
  enqueue: vi.fn(async () => ({ jobId: 'example-render', status: 'queued' })),
  resolveConflict: vi.fn(async () => ({ resolved: true })),
  publishArtwork: vi.fn(async () => ({ published: true })),
  archive: vi.fn(async () => ({ archived: true })),
  getRun: vi.fn(async (id) => ({ id, status: 'completed' })),
  promote: vi.fn(async () => ({ promoted: true })),
  signalSetup: vi.fn(async () => ({ ok: true })),
  signalSync: vi.fn(async () => ({ ok: true })),
  applyRemote: vi.fn(async () => ({ applied: true })),
}));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/tracks/index.js', async () => ({
  ...await import('../services/tracks/logic.js'),
  getTrack: effects.getTrack,
}));
vi.mock('../services/pipeline/musicLibrary.js', () => ({ MUSIC_UPLOAD_MAX_BYTES: 1024 * 1024 }));
vi.mock('../lib/ffmpeg.js', () => ({}));
vi.mock('../services/trackAudioAttach.js', () => ({}));
vi.mock('../services/trackSunoImport.js', () => ({ startSunoImport: effects.sunoImport }));
vi.mock('../services/chiptune.js', () => ({}));
vi.mock('../services/musicCode.js', () => ({ MUSIC_CODE_MAX: 20000 }));
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
vi.mock('../services/games/index.js', () => ({ publishGameArtwork: effects.publishArtwork }));
vi.mock('../services/dataManager.js', () => ({ archiveCategory: effects.archive }));
vi.mock('../services/loraTraining/index.js', () => ({ getRunRequired: effects.getRun, promoteCheckpoint: effects.promote }));
vi.mock('../lib/pythonSetup.js', () => ({}));
vi.mock('../services/signalSync.js', () => ({ checkSetup: effects.signalSetup, runSync: effects.signalSync }));
vi.mock('../services/dataSync.js', () => ({ applyRemote: effects.applyRemote }));
vi.mock('../services/sharing/tombstoneGc.js', () => ({ TOMBSTONE_GRACE_MS: 24 * 60 * 60 * 1000 }));
vi.mock('../services/sharing/peerPullAuthorization.js', () => ({}));


const gameId = 'game-11111111-1111-4111-8111-111111111111';
const setupCheck = ['get', '/api/signal/setup-check', undefined, effects.signalSetup, 200];
// One write per router plus the sensitive read: [method, path, body, effect, success status].
const workflows = [
  ['post', '/api/tracks/import/suno', { url: 'https://suno.com/song/11111111-1111-4111-8111-111111111111' }, effects.sunoImport, 202],
  ['post', '/api/music/supercollider/render', { code: '{ SinOsc.ar(440) * 0.1 }', durationSec: 4 }, effects.enqueue, 202],
  ['post', '/api/conflict-journal/example-conflict-1/resolve', { action: 'restore-all' }, effects.resolveConflict, 200],
  ['post', `/api/games/${gameId}/artwork/artwork-1/publish`, {}, effects.publishArtwork, 200],
  ['post', '/api/data/health/archive', { daysToKeep: 365 }, effects.archive, 200],
  ['post', '/api/lora-training/runs/run-example/promote-checkpoint', { step: 300 }, effects.promote, 200],
  ['post', '/api/signal/sync', {}, effects.signalSync, 200],
  setupCheck,
  ['post', '/api/sync/digitalTwin/apply', { data: {} }, effects.applyRemote, 200],
];

const mounts = [
  ['/api/tracks', (await import('./tracks.js')).default],
  ['/api/music/supercollider', (await import('./superCollider.js')).default],
  ['/api/conflict-journal', (await import('./conflictJournal.js')).default],
  ['/api/games', (await import('./games.js')).default],
  ['/api/data', (await import('./dataManager.js')).default],
  ['/api/lora-training', (await import('./loraTraining.js')).default],
  ['/api/signal', (await import('./signal.js')).default],
  ['/api/sync', (await import('./dataSync.js')).default],
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('tracks, renders, publication and host-data routers behind the host-control gate (#16114)', () => {
  it('refuses the Signal setup check to a remote password-free caller before the keychain read', async () => {
    await expectRemoteRefusal(mounts, setupCheck);
  });

  it('still run for a local operator and a delegated agent session', async () => {
    await expectAuthorizedWorkflows({ auth, mounts, workflows });
    expect(effects.enqueue).toHaveBeenLastCalledWith({ kind: 'supercollider', params: expect.objectContaining({
      source: '{ SinOsc.ar(440) * 0.1 }', durationSec: 4,
    }) });
    expect(effects.archive).toHaveBeenLastCalledWith('health', { daysToKeep: 365 });
    expect(effects.promote).toHaveBeenLastCalledWith('run-example', 300);
  });
});
