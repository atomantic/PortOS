import { beforeEach, describe, it, expect, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { enqueueJob } from '../services/mediaJobQueue/index.js';
import { resolveMusicTrackPath } from '../services/pipeline/audioMux.js';
import { getBeatGrid } from '../lib/beatGrid.js';
import router from './htmlComposition.js';
import { authGate, hostControlRouteGate } from '../services/authGate.js';
import { execFile } from '../lib/childProcess.js';
import { derivePeerAuthToken } from '../lib/peerHttpClient.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';

const authState = vi.hoisted(() => ({ enabled: false }));
vi.mock('../services/auth.js', () => ({
  isAuthEnabled: async () => authState.enabled,
  verifyPassword: async password => password === 'example-password',
  verifyRequestSession: async req => req.headers.authorization === 'Bearer example-operator-session',
}));
vi.mock('../services/settings.js', async () => ({
  getSettings: async () => ({}),
  settingsEvents: new (await import('node:events')).EventEmitter(),
}));
vi.mock('../services/instanceIdentity.js', () => ({
  loadData: async () => ({ peers: [{ id: 'example-peer', instanceId: 'example-instance', enabled: true, syncSecret: 'example-pair-secret-0123456789-abcdef' }] }),
}));
vi.mock('../lib/ffmpeg.js', () => ({ findFfmpeg: async () => '/example/ffmpeg' }));

vi.mock('../services/mediaJobQueue/index.js', () => ({
  enqueueJob: vi.fn(async () => ({ jobId: 'example-job', status: 'queued' })),
  attachSseClient: vi.fn(() => false), cancelJob: vi.fn(),
}));
vi.mock('../services/pipeline/audioMux.js', () => ({ resolveMusicTrackPath: vi.fn(async () => null) }));
const skillState = vi.hoisted(() => ({ installed: false, existingPack: null }));
vi.mock('../lib/childProcess.js', async importOriginal => ({
  ...(await importOriginal()),
  execFile: vi.fn((command, args, options, callback) => { skillState.installed = true; callback(null); }),
}));
vi.mock('../lib/motionSkills.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, detectMotionSkills: () => actual.MOTION_SKILL_PACKS.map(pack => ({ id: pack.id, label: pack.label, skills: [...pack.skills], found: skillState.installed || pack.id === skillState.existingPack ? [...pack.skills] : [], installed: skillState.installed || pack.id === skillState.existingPack })) };
});
vi.mock('../lib/beatGrid.js', () => ({ getBeatGrid: vi.fn(async () => null) }));

const app = express();
app.use(express.json());
app.use('/api/html-composition', router);
app.use(errorMiddleware);

describe('HTML composition admission', () => {
  it('drops the music-video owner option from the public render body', async () => {
    enqueueJob.mockClear();
    const response = await request(app).post('/api/html-composition/render').send({
      directory: 'compositions/example',
      owner: 'music-video',
      audio: { path: '/tmp/master.wav', startSec: 60 },
      maxDurationSec: 900,
      durationSec: 180,
      song: { features: [] },
    });
    expect(response.status).toBe(202);
    expect(enqueueJob).toHaveBeenCalledWith({ kind: 'html-composition', params: { directory: 'compositions/example' } });
  });

  it('accepts local composition assets and optional library music as a local-only media job', async () => {
    const params = { directory: 'compositions/example', musicTrack: 'example.wav' };
    const response = await request(app).post('/api/html-composition/render').send(params);
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ jobId: 'example-job' });
    expect(enqueueJob).toHaveBeenCalledWith({ kind: 'html-composition', params });
  });

  it.each([{ directory: 'valid', synthesizeMusic: true, musicTrack: 'example.wav' }, { directory: '../private' }, { directory: '/etc' }, { directory: 'C:\\private' }, { directory: 'valid', musicTrack: '../track.wav' }, {}])('rejects invalid paths before queue admission: %j', async body => {
    enqueueJob.mockClear();
    const response = await request(app).post('/api/html-composition/render').send(body);
    expect(response.status).toBe(400);
    expect(enqueueJob).not.toHaveBeenCalled();
  });
});

describe('GET /api/html-composition/beats (#8958)', () => {
  it('returns the measured beat grid for a resolved library track', async () => {
    resolveMusicTrackPath.mockResolvedValueOnce('/data/music/example.mp3');
    getBeatGrid.mockResolvedValueOnce({ bpm: 120, beats: [0, 0.5], downbeats: [0], hits: [0, 0.25] });
    const response = await request(app).get('/api/html-composition/beats?musicTrack=example.mp3');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ bpm: 120, beats: [0, 0.5], downbeats: [0], hits: [0, 0.25] });
    expect(getBeatGrid).toHaveBeenCalledWith('/data/music/example.mp3');
  });

  it('rejects a musicTrack that is not a Music-library filename', async () => {
    const response = await request(app).get('/api/html-composition/beats?musicTrack=..%2Fetc%2Fpasswd');
    expect(response.status).toBe(400);
    expect(getBeatGrid).not.toHaveBeenCalled();
  });

  it('rejects a musicTrack that does not resolve in the library', async () => {
    const response = await request(app).get('/api/html-composition/beats?musicTrack=missing.wav');
    expect(response.status).toBe(400);
  });

  it('reports 422 when the track resolves but cannot be measured', async () => {
    resolveMusicTrackPath.mockResolvedValueOnce('/data/music/example.mp3');
    getBeatGrid.mockResolvedValueOnce(null);
    const response = await request(app).get('/api/html-composition/beats?musicTrack=example.mp3');
    expect(response.status).toBe(422);
  });
});

describe('motion skills install authority (#9439)', () => {
  const installPath = '/api/html-composition/toolkit/skills/install';
  const buildApp = (remoteAddress = '192.0.2.10') => {
    const gatedApp = express();
    gatedApp.use((req, res, next) => {
      Object.defineProperty(req.socket, 'remoteAddress', { value: remoteAddress, configurable: true });
      next();
    });
    gatedApp.use(authGate);
    gatedApp.use(hostControlRouteGate);
    gatedApp.use(express.json());
    gatedApp.use('/api/html-composition', router);
    gatedApp.use(errorMiddleware);
    return gatedApp;
  };

  beforeEach(() => {
    authState.enabled = false;
    skillState.installed = false;
    skillState.existingPack = null;
    execFile.mockClear();
  });

  it.each([
    ['192.0.2.10', '127.0.0.1'],
    ['127.0.0.1', '192.0.2.10'],
  ])('refuses a remote caller through socket %s and proxy marker %s before installing', async (remoteAddress, proxyAddress) => {
    const response = await request(buildApp(remoteAddress)).post('/API/HTML-COMPOSITION/TOOLKIT/SKILLS/INSTALL/')
      .set('X-Forwarded-For', '127.0.0.1')
      .set(DEV_PROXY_CLIENT_ADDRESS_HEADER, proxyAddress);
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('HOST_CONTROL_FORBIDDEN');
    expect(execFile).not.toHaveBeenCalled();
    expect(skillState.installed).toBe(false);
  });

  it('refuses legacy Basic and scoped peer credentials when a password is set', async () => {
    authState.enabled = true;
    const basic = await request(buildApp()).post(installPath)
      .set('Authorization', `Basic ${Buffer.from(':example-password').toString('base64')}`);
    expect(basic.status).toBe(403);
    expect(basic.body.code).toBe('HOST_CONTROL_FORBIDDEN');
    const peer = await request(buildApp()).post(installPath)
      .set('X-PortOS-Instance-Id', 'example-instance')
      .set('X-PortOS-Peer-Auth', derivePeerAuthToken('example-pair-secret-0123456789-abcdef', 'example-instance'));
    expect(peer.status).toBe(403);
    expect(peer.body.code).toBe('PEER_SCOPE_FORBIDDEN');
    expect(execFile).not.toHaveBeenCalled();
    expect(skillState.installed).toBe(false);
  });

  it.each(['loopback', 'operator-session'])('allows %s authority and installs only missing packs', async mode => {
    const { MOTION_SKILL_PACKS, skillInstallCommand } = await import('../lib/motionSkills.js');
    skillState.existingPack = MOTION_SKILL_PACKS[0].id;
    authState.enabled = mode === 'operator-session';
    const pending = request(buildApp(mode === 'loopback' ? '127.0.0.1' : '192.0.2.10')).post(installPath);
    if (authState.enabled) pending.set('Authorization', 'Bearer example-operator-session');
    const response = await pending;
    expect(response.status).toBe(200);
    expect(execFile).toHaveBeenCalledTimes(MOTION_SKILL_PACKS.length - 1);
    expect(execFile.mock.calls.map(([command, args]) => [command, args])).toEqual(MOTION_SKILL_PACKS.slice(1).map(skillInstallCommand));
    expect(response.body.skillPacks.every(pack => pack.installed)).toBe(true);
    execFile.mockClear();
    expect((await request(buildApp('127.0.0.1')).post(installPath)
      .set('Authorization', 'Bearer example-operator-session')).status).toBe(200);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('keeps toolkit status and contained rendering available to a remote password-free caller', async () => {
    const gatedApp = buildApp();
    expect((await request(gatedApp).get('/api/html-composition/toolkit')).status).toBe(200);
    expect((await request(gatedApp).post('/api/html-composition/render').send({ directory: 'compositions/example' })).status).toBe(202);
    expect(execFile).not.toHaveBeenCalled();
  });
});
