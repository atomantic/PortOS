import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyProjectRenderPool } from './renderPool.js';
import { musicVideoVideoSettingsSchema } from '../../lib/musicVideoValidation.js';
import { stripMusicVideoLocalRenderPins } from '../../lib/syncWire.js';
import { mergeProjectRecord } from './projectsLogic.js';

const m = vi.hoisted(() => ({ project: null, jobs: [], local: null, resolve: vi.fn() }));
vi.mock('./projects.js', () => ({ getProject: async () => m.project }));
vi.mock('../instances.js', () => ({ getPeers: async () => [{ id: 'peer-a' }, { id: 'peer-b' }] }));
vi.mock('../federatedMediaConsumer.js', () => ({ resolveFederatedMediaProvider: (...args) => m.resolve(...args) }));
vi.mock('../mediaJobQueue/index.js', () => ({ listJobs: () => m.jobs }));
vi.mock('../federatedMediaProvider.js', () => ({ getLocalVideoRenderCapability: async () => m.local }));
const body = () => ({ prompt: 'Example shot', backend: 'local', mode: 'image', musicVideo: { projectId: 'project', sceneId: 'scene' } });
const ready = () => ({ capability: { hardwareEligible: true, ready: true, memory: { requiredGb: 12, totalGb: 48, freeGb: 32 },
  inputAssets: { roles: ['sourceImage'] }, supportedModes: ['image', 'a2v'], sourceAudio: { requiresImage: true } },
status: { features: ['sourceAudio'], queue: { totalActive: 0, maintenanceHeld: false } } });
beforeEach(() => {
  m.project = { id: 'project', scenes: [{ sceneId: 'scene', startSec: 0, endSec: 1 }],
    videoSettings: { backend: 'local', generationMode: 'image', renderPool: { mode: 'peers', peers: [
      { peerId: 'peer-a', modelId: 'model-a' }, { peerId: 'peer-b', modelId: 'model-b' },
    ] } } };
  m.local = null; m.jobs = []; m.resolve.mockReset().mockResolvedValue(ready());
});
describe('project render-pool submission policy', () => {
  it('assigns the least occupied explicit peer/model and never modifies grants', async () => {
    m.jobs = [{ status: 'queued', params: { remoteMedia: { peerId: 'peer-a' } } }];
    expect(await applyProjectRenderPool(body())).toMatchObject({ mediaProviderPeerId: 'peer-b', modelId: 'model-b' });
    expect(m.resolve).toHaveBeenCalledWith({ id: 'peer-b' }, { kind: 'video', engine: 'local', modelId: 'model-b' });
  });
  it('refuses ready-but-too-large models, unknown maintenance and missing audio negotiation', async () => {
    const fail = ready(); fail.capability.memory.requiredGb = 96;
    m.resolve.mockResolvedValue(fail);
    await expect(applyProjectRenderPool(body())).rejects.toMatchObject({ code: 'MUSIC_VIDEO_RENDER_POOL_UNAVAILABLE' });
    const unknown = ready(); delete unknown.status.queue.maintenanceHeld;
    m.resolve.mockResolvedValue(unknown);
    await expect(applyProjectRenderPool(body())).rejects.toThrow(/No selected render node/);
    m.project.videoSettings.generationMode = 'suppliedAudio';
    const oldPeer = ready(); oldPeer.status.features = [];
    m.resolve.mockResolvedValue(oldPeer);
    await expect(applyProjectRenderPool(body())).rejects.toThrow(/No selected render node/);
  });
  it('allows Both to choose an eligible selected peer when this Mac is ineligible, never an unselected fallback', async () => {
    m.project.videoSettings.renderPool.mode = 'both'; m.project.videoSettings.modelId = 'local-model';
    expect(await applyProjectRenderPool(body())).toMatchObject({ mediaProviderPeerId: 'peer-a' });
    m.resolve.mockRejectedValue(new Error('not allowlisted'));
    await expect(applyProjectRenderPool(body())).rejects.toThrow(/No selected render node/);
  });
  it('chooses a ready explicit local model in Both and excludes it when its installed runtime is unavailable', async () => {
    m.project.videoSettings.renderPool.mode = 'both'; m.project.videoSettings.modelId = 'local-model';
    m.local = ready().capability;
    const busyPeer = ready(); busyPeer.status.queue.totalActive = 1;
    m.resolve.mockResolvedValue(busyPeer);
    const local = await applyProjectRenderPool(body());
    expect(local.modelId).toBe('local-model');
    expect(local.mediaProviderPeerId).toBeUndefined();
    m.local.ready = false;
    expect(await applyProjectRenderPool(body())).toMatchObject({ mediaProviderPeerId: 'peer-a', modelId: 'model-a' });
  });
  it('excludes a frame-capable node that cannot run the requested shot mode, including Both local placement', async () => {
    m.project.videoSettings.renderPool.mode = 'both'; m.project.videoSettings.modelId = 'local-model';
    m.local = ready().capability; m.local.supportedModes = ['text', 'fflf'];
    m.resolve.mockImplementation(async (peer) => {
      const result = ready();
      if (peer.id === 'peer-a') result.capability.supportedModes = ['text', 'fflf'];
      return result;
    });
    expect(await applyProjectRenderPool(body())).toMatchObject({ mediaProviderPeerId: 'peer-b', modelId: 'model-b' });
    m.resolve.mockImplementation(async () => { const result = ready(); delete result.capability.supportedModes; return result; });
    await expect(applyProjectRenderPool(body())).rejects.toThrow(/No selected render node/);
  });
  it('refuses performance, production-budget substitutions, and individual target overrides', async () => {
    m.project.scenes[0].shotMode = 'performance';
    await expect(applyProjectRenderPool(body())).rejects.toThrow(/lip-sync/);
    m.project.scenes[0].shotMode = 'cutaway';
    await expect(applyProjectRenderPool({ ...body(), musicVideo: { ...body().musicVideo, productionRunId: 'run' } })).rejects.toThrow(/production runs/);
    m.project.videoSettings.renderPool.mode = 'local';
    await expect(applyProjectRenderPool({ ...body(), mediaProviderPeerId: 'peer-a' })).rejects.toThrow(/saved project/);
    m.project.videoSettings.generationMode = 'suppliedAudio';
    await expect(applyProjectRenderPool({ ...body(), backend: 'fal' })).rejects.toThrow(/explicitly/);
  });
  it('rejects an empty or duplicated remote pool at the project write schema', () => {
    expect(musicVideoVideoSettingsSchema.safeParse({ renderPool: { mode: 'peers', peers: [] } }).success).toBe(false);
  });
  it('refuses an explicit continuation before the local supplied-audio mode override', async () => {
    m.project.videoSettings.generationMode = 'suppliedAudio';
    m.project.videoSettings.renderPool.mode = 'local';
    await expect(applyProjectRenderPool({ ...body(), mode: 'extend', extendFromVideoId: 'prior-clip' })).rejects.toThrow(/continuation/);
    expect(m.resolve).not.toHaveBeenCalled();
    expect(await applyProjectRenderPool(body())).toMatchObject({ mode: 'a2v', backend: 'local' });
  });
  it('keeps node selections machine-local on outbound and inbound project sync', () => {
    const pool = m.project.videoSettings.renderPool;
    expect(stripMusicVideoLocalRenderPins(m.project, { stripVideoBackend: false }).videoSettings.renderPool).toBeUndefined();
    const remote = { ...m.project, updatedAt: '2026-10-02T00:00:00.000Z' };
    expect(mergeProjectRecord(null, remote).next.videoSettings.renderPool).toBeUndefined();
    const local = { ...m.project, updatedAt: '2026-10-01T00:00:00.000Z' };
    expect(mergeProjectRecord(local, remote).next.videoSettings.renderPool).toEqual(pool);
  });
});
