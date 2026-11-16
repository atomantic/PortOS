import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { expectAuthorizedWorkflows, expectRemoteRefusal } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-capture-authority-') }));
afterAll(cleanupTempDataRoots);

// Camera and microphone authority (#11272). Start and stop are plain writes under
// the default-deny gate (#16018), whose principal matrix lives in
// services/authGate.test.js. This suite keeps the HOST_CONTROL_GET_ROUTES live
// feeds: a remote caller is refused before it subscribes to a running feed, and an
// authorized caller still receives the stream.
const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(), getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/instanceIdentity.js', () => ({ loadData: vi.fn(async () => ({ peers: [] })) }));
const media = vi.hoisted(() => ({
  listDevices: vi.fn(async () => []),
  isVideoStreaming: vi.fn(() => true), isAudioStreaming: vi.fn(() => true),
  startVideoStream: vi.fn(), startAudioStream: vi.fn(), stopAll: vi.fn(),
  getVideoStream: vi.fn(), getAudioStream: vi.fn(),
}));
vi.mock('../services/mediaService.js', () => ({ default: media }));
const mounts = [['/api/media', (await import('./media.js')).default]];

// The gated feeds: [method, path, body, effect, success status].
const feeds = [
  ['get', '/api/media/video', undefined, media.getVideoStream, 200],
  ['get', '/api/media/audio', undefined, media.getAudioStream, 200],
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('capture and live-stream operator authority (#11272)', () => {
  it.each(feeds)('refuses %s %s to a remote password-free caller before it subscribes to a running feed', async (...feed) => {
    const source = new PassThrough();
    feed[3].mockReturnValue(source);
    await expectRemoteRefusal(mounts, feed);
    expect([source.listenerCount('data'), source.listenerCount('end')]).toEqual([0, 0]);
  });

  it('still starts capture and streams both feeds for a local operator and a delegated agent session', async () => {
    media.getVideoStream.mockImplementation(() => Readable.from([Buffer.from([0xff, 0xd8, 0xff, 0xd9])]));
    media.getAudioStream.mockImplementation(() => Readable.from([Buffer.from('synthetic audio')]));
    await expectAuthorizedWorkflows({ auth, mounts, workflows: [
      ['post', '/api/media/start', {}, media.startVideoStream, 200],
      ...feeds,
    ] });
  });
});
