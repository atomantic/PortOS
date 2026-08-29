import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetProductionBatchRuns,
  cancelEpisodeProductionBatch,
  getEpisodeProductionBatch,
  planEpisodeProduction,
  reviewEpisodeContinuity,
  resumeEpisodeProductionBatch,
  startEpisodeProductionBatch,
} from './production.js';
import * as records from './records.js';
import * as universeBuilder from '../universeBuilder.js';
import * as voiceProfiles from '../voice/profiles.js';
import * as loras from '../loras.js';

const queueMocks = vi.hoisted(() => {
  const listeners = new Map();
  const mediaJobEvents = {
    on: vi.fn((event, handler) => {
      const handlers = listeners.get(event) || [];
      handlers.push(handler);
      listeners.set(event, handlers);
    }),
    emit: (event, payload) => {
      for (const handler of listeners.get(event) || []) handler(payload);
    },
  };
  return { enqueueJob: vi.fn(), cancelJob: vi.fn(), mediaJobEvents };
});
const settingsMocks = vi.hoisted(() => ({ getSettings: vi.fn() }));
const mediaModelMocks = vi.hoisted(() => ({
  getImageModels: vi.fn(),
  isEditOnly: vi.fn(),
}));
const imagePrepareMocks = vi.hoisted(() => ({
  selectLocalImageModel: vi.fn(),
  resolveLocalImageModel: vi.fn(),
}));
const videoModelMocks = vi.hoisted(() => ({
  DEFAULT_NUM_FRAMES: 16,
  defaultVideoModelId: vi.fn(),
  listVideoModels: vi.fn(),
  resolveVideoModel: vi.fn(),
}));
const visualConditioningMocks = vi.hoisted(() => ({
  compileFableLoomVisualRequest: vi.fn(),
  fableLoomImageCapabilities: vi.fn(),
  fableLoomVideoCapabilities: vi.fn(),
}));

vi.mock('./records.js');
vi.mock('../universeBuilder.js');
vi.mock('../voice/profiles.js');
vi.mock('../loras.js');
vi.mock('../settings.js', () => settingsMocks);
vi.mock('../../lib/mediaModels.js', () => mediaModelMocks);
vi.mock('../imageGen/prepareParams.js', () => imagePrepareMocks);
vi.mock('../videoGen/local.js', () => videoModelMocks);
vi.mock('../mediaJobQueue/index.js', () => queueMocks);
vi.mock('./visualConditioning.js', () => visualConditioningMocks);

describe('fableLoom production service', () => {
  const sampleLoom = {
    id: 'loom-1',
    name: 'Test Loom',
    universeId: 'univ-1',
    episodes: [
      {
        id: 'ep-1',
        title: 'Episode 1',
        startNodeId: 'node-1',
        nodes: [
          {
            id: 'node-1',
            title: 'Node 1',
            prose: 'Opening scene prose.',
            imagePrompt: 'Visual prompt 1',
            videoPrompt: 'Video prompt 1',
            transitions: [{ id: 'tr-1', targetNodeId: 'node-2', intent: 'Go forward' }],
          },
          {
            id: 'node-2',
            title: 'Node 2',
            prose: 'Second scene prose.',
            imagePrompt: 'Visual prompt 2',
            videoPrompt: 'Video prompt 2',
            isEnding: true,
            transitions: [],
          },
        ],
      },
    ],
  };

  const sampleUniverse = {
    id: 'univ-1',
    characters: [{ id: 'char-1', name: 'Hero', wardrobes: [{ id: 'w-1' }] }],
    places: [],
    objects: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    _resetProductionBatchRuns();
    records.getLoom.mockResolvedValue(sampleLoom);
    records.findEpisode.mockImplementation((loom, epId) => loom.episodes.find((e) => e.id === epId));
    universeBuilder.getUniverse.mockResolvedValue(sampleUniverse);
    voiceProfiles.listVoiceProfiles.mockResolvedValue([]);
    loras.listLoras.mockResolvedValue([]);
    settingsMocks.getSettings.mockResolvedValue({ imageGen: { local: {} }, videoGen: {} });
    const imageModel = { id: 'image-model', runner: 'flux2', hardwareCompatibility: { state: 'ready', reasons: [] } };
    mediaModelMocks.getImageModels.mockReturnValue([imageModel]);
    mediaModelMocks.isEditOnly.mockReturnValue(false);
    imagePrepareMocks.selectLocalImageModel.mockReturnValue(imageModel);
    imagePrepareMocks.resolveLocalImageModel.mockReturnValue({ pythonPath: null, selectedModel: imageModel });
    videoModelMocks.defaultVideoModelId.mockReturnValue('video-model');
    const videoModel = {
      id: 'video-model',
      supportedModes: ['text', 'image'],
      defaultWidth: 1024,
      defaultHeight: 576,
      defaultFrames: 16,
    };
    videoModelMocks.listVideoModels.mockReturnValue([videoModel]);
    videoModelMocks.resolveVideoModel.mockReturnValue(videoModel);
    visualConditioningMocks.compileFableLoomVisualRequest.mockResolvedValue(null);
    visualConditioningMocks.fableLoomImageCapabilities.mockReturnValue({
      kind: 'image', backend: 'local', modelId: 'image-model', referenceRoles: [], referenceBudget: 0,
    });
    visualConditioningMocks.fableLoomVideoCapabilities.mockReturnValue({
      kind: 'video', backend: 'local', modelId: 'video-model', referenceRoles: [], referenceBudget: 0,
    });
    let nextJobId = 1;
    queueMocks.enqueueJob.mockImplementation(() => ({ jobId: `job-${nextJobId++}`, position: 1, status: 'queued' }));
    queueMocks.cancelJob.mockResolvedValue({ ok: true, status: 'canceled' });
  });

  it('plans episode production with topological asset enumeration', async () => {
    const plan = await planEpisodeProduction('loom-1', 'ep-1', { mode: 'current_canon' });
    expect(plan.totalNodes).toBe(2);
    expect(plan.reachableNodeCount).toBe(2);
    expect(plan.plannedAssets.length).toBeGreaterThan(0);
    expect(plan.plannedAssets.some((a) => a.id === 'asset-node-1-still')).toBe(true);
    expect(plan.plannedAssets.some((a) => a.id === 'asset-node-2-still')).toBe(true);
  });

  it('creates and tracks batch production runs', async () => {
    const run = await startEpisodeProductionBatch('loom-1', 'ep-1', { mode: 'current_canon' });
    expect(run.id).toMatch(/^batch-/);
    expect(run.loomId).toBe('loom-1');
    expect(run.episodeId).toBe('ep-1');
    expect(run.assets.length).toBeGreaterThan(0);
    expect(run.plan.executionStages.length).toBeGreaterThan(0);
    expect(run.assets[0]).toHaveProperty('dependencies');

    const fetched = getEpisodeProductionBatch(run.id);
    expect(fetched).toEqual(run);
  });

  it('refuses a batch when its selected assets are blocked', async () => {
    const blockedLoom = structuredClone(sampleLoom);
    blockedLoom.episodes[0].nodes[0].prose = '';
    blockedLoom.episodes[0].nodes[0].imagePrompt = '';
    blockedLoom.episodes[0].nodes[0].videoPrompt = '';
    records.getLoom.mockResolvedValueOnce(blockedLoom);

    await expect(startEpisodeProductionBatch('loom-1', 'ep-1', { mode: 'current_canon' }))
      .rejects.toMatchObject({ code: 'PRODUCTION_NOT_READY', status: 409 });
  });

  it('refuses exact-input reproduction without recorded provenance', async () => {
    await expect(startEpisodeProductionBatch('loom-1', 'ep-1', { mode: 'exact_inputs' }))
      .rejects.toMatchObject({ code: 'EXACT_INPUTS_REFUSED', status: 409 });
  });

  it('cancels an in-progress batch run', async () => {
    const run = await startEpisodeProductionBatch('loom-1', 'ep-1', { mode: 'current_canon' });
    const canceled = await cancelEpisodeProductionBatch(run.id);
    expect(canceled.status).toBe('canceled');
    expect(canceled.cancelRequested).toBe(true);
  });

  it('resumes a canceled run after resetting unfinished assets', async () => {
    const run = await startEpisodeProductionBatch('loom-1', 'ep-1', { mode: 'current_canon' });
    await cancelEpisodeProductionBatch(run.id);

    const resumed = resumeEpisodeProductionBatch(run.id);
    expect(resumed.status).toBe('in_progress');
    expect(resumed.assets.every((asset) => !['failed', 'blocked', 'canceled'].includes(asset.status))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queueMocks.enqueueJob).toHaveBeenCalled();
  });

  it('advances to the next dependency stage only after queue jobs complete', async () => {
    const run = await startEpisodeProductionBatch('loom-1', 'ep-1', { mode: 'current_canon' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queueMocks.enqueueJob).toHaveBeenCalledTimes(1);
    expect(queueMocks.enqueueJob.mock.calls[0][0].kind).toBe('image');

    queueMocks.mediaJobEvents.emit('completed', {
      id: 'job-1',
      result: { filename: 'node-1.png' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queueMocks.enqueueJob.mock.calls.length).toBeGreaterThan(1);
    expect(queueMocks.enqueueJob.mock.calls.slice(1).some(([job]) => job.kind === 'video')).toBe(true);

    for (let stage = 0; stage < 4 && run.status === 'in_progress'; stage += 1) {
      for (const asset of run.assets.filter((candidate) => candidate.jobId
        && ['queued', 'running'].includes(candidate.status))) {
        queueMocks.mediaJobEvents.emit('completed', {
          id: asset.jobId,
          result: { filename: `${asset.jobId}.mp4` },
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(run.status).toBe('completed');
  });

  it('performs episodic continuity review returning structured findings', async () => {
    const review = await reviewEpisodeContinuity('loom-1', 'ep-1');
    expect(review.passed).toBe(true);
    expect(review.nodesEvaluated).toBe(2);
    expect(review.findings).toBeDefined();
  });
});
