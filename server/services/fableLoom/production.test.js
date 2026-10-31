import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PATHS } from '../../lib/fileUtils.js';
import { prepareFableLoomImageParams } from '../imageGen/fableLoomParams.js';
import { initFableLoomSceneImageHook, __testing as sceneImageHookTesting } from '../fableLoomSceneImageHook.js';
import { fableLoomRunEvents } from './runEvents.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetProductionBatchRuns,
  cancelEpisodeProductionBatch,
  getEpisodeProductionBatch,
  getLatestEpisodeProductionBatch,
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
    off: vi.fn((event, handler) => {
      listeners.set(event, (listeners.get(event) || []).filter((listener) => listener !== handler));
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
  selectLocalImageModelFromSettings: vi.fn(),
  resolveLocalImageModel: vi.fn(),
}));
const imageSidecarMocks = vi.hoisted(() => ({
  readImageSidecar: vi.fn(async () => ({ metadata: {} })),
}));
const videoModelMocks = vi.hoisted(() => ({
  DEFAULT_NUM_FRAMES: 16,
  defaultVideoModelId: vi.fn(),
  listVideoModels: vi.fn(),
  resolveVideoModel: vi.fn(),
}));
const videoHistoryMocks = vi.hoisted(() => ({ loadHistory: vi.fn() }));
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
vi.mock('../imageGen/local.js', () => imageSidecarMocks);
vi.mock('../videoGen/local.js', () => videoModelMocks);
vi.mock('../videoGen/history.js', () => videoHistoryMocks);
vi.mock('../mediaJobQueue/index.js', () => queueMocks);
vi.mock('./visualConditioning.js', () => visualConditioningMocks);

const snapshots = [];
const recordSnapshot = run => snapshots.push(run);
beforeEach(() => { snapshots.length = 0; fableLoomRunEvents.on('production', recordSnapshot); });
afterEach(() => { fableLoomRunEvents.off('production', recordSnapshot); });

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
        storyOutline: {
          version: 1,
          startKey: 'node-1',
          scenes: [
            {
              key: 'node-1', title: 'Node 1', summary: 'The hero reaches the threshold.',
              playbackMode: 'cut', audienceConnection: 'disconnected', protagonistPresence: 'onscreen',
              isEnding: false, transitions: [{ targetKey: 'node-2', intent: 'Go forward' }],
            },
            {
              key: 'node-2', title: 'Node 2', summary: 'The choice opens a way forward.',
              playbackMode: 'cut', audienceConnection: 'disconnected', protagonistPresence: 'onscreen',
              isEnding: true, endingLabel: 'Forward', transitions: [],
            },
          ],
          validation: { status: 'valid', issues: [] },
        },
        nodes: [
          {
            id: 'node-1',
            title: 'Node 1',
            prose: 'Opening scene prose.',
            imagePrompt: 'Visual prompt 1',
            videoPrompt: 'Video prompt 1',
            playbackMode: 'cut',
            audienceConnection: 'disconnected',
            protagonistPresence: 'onscreen',
            isEnding: false,
            transitions: [{ id: 'tr-1', targetNodeId: 'node-2', intent: 'Go forward' }],
          },
          {
            id: 'node-2',
            title: 'Node 2',
            prose: 'Second scene prose.',
            imagePrompt: 'Visual prompt 2',
            videoPrompt: 'Video prompt 2',
            playbackMode: 'cut',
            audienceConnection: 'disconnected',
            protagonistPresence: 'onscreen',
            isEnding: true,
            endingLabel: 'Forward',
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
    const imageModel = {
      id: 'image-model', revision: 'image-revision-1', runner: 'flux2',
      hardwareCompatibility: { state: 'ready', reasons: [] },
    };
    mediaModelMocks.getImageModels.mockReturnValue([imageModel]);
    mediaModelMocks.isEditOnly.mockReturnValue(false);
    imagePrepareMocks.selectLocalImageModelFromSettings.mockReturnValue(imageModel);
    imagePrepareMocks.resolveLocalImageModel.mockReturnValue({ pythonPath: null, selectedModel: imageModel });
    videoModelMocks.defaultVideoModelId.mockReturnValue('video-model');
    const videoModel = {
      id: 'video-model',
      supportedModes: ['text', 'image'],
      defaultWidth: 1024,
      defaultHeight: 576,
      defaultFrames: 16,
      defaultFps: 24,
      steps: 30,
      guidance: 4,
      revision: 'video-revision-1',
    };
    videoModelMocks.listVideoModels.mockReturnValue([videoModel]);
    videoModelMocks.resolveVideoModel.mockReturnValue(videoModel);
    videoHistoryMocks.loadHistory.mockResolvedValue([]);
    visualConditioningMocks.compileFableLoomVisualRequest.mockResolvedValue(null);
    visualConditioningMocks.fableLoomImageCapabilities.mockReturnValue({
      kind: 'image', backend: 'local', modelId: 'image-model', referenceRoles: [], referenceBudget: 0,
    });
    visualConditioningMocks.fableLoomVideoCapabilities.mockReturnValue({
      kind: 'video', backend: 'local', modelId: 'video-model', referenceRoles: [], referenceBudget: 0,
    });
    imageSidecarMocks.readImageSidecar.mockReset();
    imageSidecarMocks.readImageSidecar.mockResolvedValue({ metadata: {} });
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
    expect(plan.seriesStoryReadiness.stats.ready).toBe(true);
    expect(plan.renderOptions).toMatchObject({
      formatId: 'landscape-16-9', aspectRatio: '16:9', width: 1024, height: 576,
    });
  });

  it('uses the loom render preferences when a production run has no overrides', async () => {
    const preferredLoom = structuredClone(sampleLoom);
    preferredLoom.renderSettings = {
      formatId: 'square-1-1',
      imageMode: 'local',
      imageModel: 'image-model',
      videoMode: 'grok',
      effort: 'high',
    };
    records.getLoom.mockResolvedValueOnce(preferredLoom);

    const plan = await planEpisodeProduction('loom-1', 'ep-1', { mode: 'current_canon' });

    expect(plan.renderOptions).toMatchObject({
      formatId: 'square-1-1',
      aspectRatio: '1:1',
      width: 1024,
      height: 1024,
      imageMode: 'local',
      imageModel: 'image-model',
      videoMode: 'grok',
      videoModel: null,
      effort: 'high',
    });
  });

  it('flags an existing portrait storyboard and its clips for landscape regeneration', async () => {
    const portraitLoom = structuredClone(sampleLoom);
    portraitLoom.episodes[0].nodes[0].image = 'portrait.png';
    portraitLoom.episodes[0].nodes[0].videoHistoryId = 'portrait-video';
    records.getLoom.mockResolvedValueOnce(portraitLoom);
    imageSidecarMocks.readImageSidecar.mockResolvedValueOnce({
      metadata: { width: 576, height: 1024 },
    });

    const plan = await planEpisodeProduction('loom-1', 'ep-1', { mode: 'current_canon' });

    expect(plan.formatMismatches).toEqual([expect.objectContaining({
      nodeId: 'node-1',
      actualWidth: 576,
      actualHeight: 1024,
      expectedAspectRatio: '16:9',
    })]);
    expect(plan.plannedAssets.find((asset) => asset.id === 'asset-node-1-still')).toMatchObject({
      status: 'ready',
      formatMismatch: expect.objectContaining({ expectedWidth: 1024, expectedHeight: 576 }),
    });
    expect(plan.plannedAssets.find((asset) => asset.id === 'asset-node-1-video-entry')).toMatchObject({
      status: 'ready',
      formatMismatch: expect.objectContaining({ expectedAspectRatio: '16:9' }),
    });
  });

  it('inspects existing video dimensions even when the storyboard already matches', async () => {
    const portraitVideoLoom = structuredClone(sampleLoom);
    portraitVideoLoom.episodes[0].nodes[0].image = 'landscape.png';
    portraitVideoLoom.episodes[0].nodes[0].videoHistoryId = 'portrait-video';
    records.getLoom.mockResolvedValueOnce(portraitVideoLoom);
    imageSidecarMocks.readImageSidecar.mockResolvedValueOnce({
      metadata: { width: 1024, height: 576 },
    });
    videoHistoryMocks.loadHistory.mockResolvedValueOnce([{
      id: 'portrait-video', width: 576, height: 1024,
    }]);

    const plan = await planEpisodeProduction('loom-1', 'ep-1', { mode: 'current_canon' });

    expect(plan.formatMismatches).toEqual([expect.objectContaining({
      assetId: 'asset-node-1-video-entry',
      assetType: 'video_entry',
      actualWidth: 576,
      actualHeight: 1024,
    })]);
    expect(plan.plannedAssets.find((asset) => asset.id === 'asset-node-1-video-entry'))
      .toMatchObject({ status: 'ready', formatMismatch: expect.any(Object) });
  });

  it('blocks production planning until the complete series beat arc is validated', async () => {
    const draftLoom = structuredClone(sampleLoom);
    draftLoom.episodes[0].storyOutline.validation = { status: 'draft', issues: [] };
    records.getLoom.mockResolvedValueOnce(draftLoom);

    const plan = await planEpisodeProduction('loom-1', 'ep-1', { mode: 'current_canon' });

    expect(plan.seriesStoryReadiness.stats.ready).toBe(false);
    expect(plan.planningIssues).toEqual(expect.arrayContaining([
      expect.stringContaining("Episode 1's beat outline must be validated"),
    ]));
  });

  it('reports the ordered storyboard gate for a later episode', async () => {
    const laterLoom = structuredClone(sampleLoom);
    laterLoom.episodes.push({
      id: 'ep-2', number: 2, title: 'Episode 2', startNodeId: 'later-node',
      storyOutline: structuredClone(sampleLoom.episodes[0].storyOutline),
      nodes: [{ id: 'later-node', title: 'Later node', prose: 'Later prose.', imagePrompt: 'Later prompt.', transitions: [] }],
    });
    records.getLoom.mockResolvedValueOnce(laterLoom);

    const plan = await planEpisodeProduction('loom-1', 'ep-2', { mode: 'current_canon' });

    expect(plan.episodeOrderReadiness.ready).toBe(false);
    expect(plan.planningIssues).toEqual(expect.arrayContaining([
      expect.stringContaining('Episode order: Finish storyboard images for Episode 1'),
    ]));
  });

  it('creates and tracks batch production runs', async () => {
    const run = await startEpisodeProductionBatch('loom-1', 'ep-1', { mode: 'current_canon' });
    expect(run.id).toMatch(/^batch-/);
    expect(run.loomId).toBe('loom-1');
    expect(run.episodeId).toBe('ep-1');
    expect(run.assets.length).toBeGreaterThan(0);
    expect(run.plan.executionStages.length).toBeGreaterThan(0);
    expect(run.assets[0]).toHaveProperty('dependencies');

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queueMocks.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'image',
      params: expect.objectContaining({ width: 1024, height: 576, aspectRatio: '16:9' }),
    }));

    const fetched = getEpisodeProductionBatch(run.id);
    expect(fetched).toEqual(run);
    const queuedCalls = queueMocks.enqueueJob.mock.calls.length;
    expect(getLatestEpisodeProductionBatch('loom-1', 'ep-1')).toBe(run);
    expect(getLatestEpisodeProductionBatch('loom-1', 'other-episode')).toBeNull();
    expect(queueMocks.enqueueJob).toHaveBeenCalledTimes(queuedCalls);
    expect(snapshots[0]).toMatchObject({ id: run.id, loomId: 'loom-1', episodeId: 'ep-1', revision: 1 });
    expect(snapshots[0].summary.queued).toBe(0);
    expect(snapshots.at(-1).summary.queued).toBeGreaterThan(0);
    expect(snapshots.every(snapshot => !('tail' in snapshot) && !('runtime' in snapshot))).toBe(true);
  });

  it('queues the Runway text lane with the compiled prompt and no invented source frame', async () => {
    const loom = structuredClone(sampleLoom);
    loom.episodes[0].nodes.forEach(node => { node.image = 'example-frame.png'; });
    records.getLoom.mockResolvedValue(loom);
    settingsMocks.getSettings.mockResolvedValue({ videoGen: { runway: { apiKey: 'example-key' } } });
    const prompt = 'A fox crosses the clearing at dawn.';
    visualConditioningMocks.compileFableLoomVisualRequest.mockResolvedValue({
      prompt, sourceImagePath: null, visualConditioning: { compiledPrompt: prompt },
    });
    await startEpisodeProductionBatch('loom-1', 'ep-1', {
      videoMode: 'runway', assetTypes: ['video_entry'], nodeIds: ['node-1'],
    });
    await vi.waitFor(() => expect(queueMocks.enqueueJob).toHaveBeenCalled());
    expect(queueMocks.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'video', params: expect.objectContaining({
        mode: 'runway', videoMode: 'text', prompt, sourceImagePath: null,
        visualConditioning: expect.objectContaining({ compiledPrompt: prompt }),
      }),
    }));
  });

  it('queues fal without render geometry and Grok with its provider parameters and geometry', async () => {
    const loom = structuredClone(sampleLoom);
    loom.episodes[0].nodes.forEach(node => { node.image = 'example-frame.png'; });
    records.getLoom.mockResolvedValue(loom);
    const prompt = 'A lantern sways over the river.';
    visualConditioningMocks.compileFableLoomVisualRequest.mockResolvedValue({
      prompt, promptAdditions: [{ id: 'style' }], sourceImagePath: '/example/frame.png',
      visualConditioning: { compiledPrompt: prompt },
    });
    const options = { assetTypes: ['video_entry'], nodeIds: ['node-1'] };
    const fableLoom = { loomId: 'loom-1', episodeId: 'ep-1', nodeId: 'node-1', role: 'entry' };

    settingsMocks.getSettings.mockResolvedValue({ videoGen: { fal: { apiKey: 'example-key' } } });
    const falRun = await startEpisodeProductionBatch('loom-1', 'ep-1', { ...options, videoMode: 'fal' });
    await vi.waitFor(() => expect(queueMocks.enqueueJob).toHaveBeenCalled());
    const videoAsset = (run) => getEpisodeProductionBatch(run.id).assets.find(asset => asset.id === 'asset-node-1-video-entry');
    expect(videoAsset(falRun)).toMatchObject({ provider: 'fal', modelId: null });
    expect(visualConditioningMocks.fableLoomVideoCapabilities).toHaveBeenCalledWith({
      backend: 'fal', model: { id: 'fal-video', supportedModes: ['text', 'image'] },
    });
    const [falJob] = queueMocks.enqueueJob.mock.calls[0];
    expect(falJob.kind).toBe('video');
    expect(falJob.params).toEqual({
      mode: 'fal', videoMode: 'image', prompt, promptAdditions: [{ id: 'style' }], negativePrompt: '',
      sourceImagePath: '/example/frame.png',
      visualConditioning: expect.objectContaining({ compiledPrompt: prompt }),
      fableLoom,
    });

    _resetProductionBatchRuns();
    queueMocks.enqueueJob.mockClear();
    settingsMocks.getSettings.mockResolvedValue({ imageGen: { grok: { enabled: true } }, videoGen: {} });
    const grokRun = await startEpisodeProductionBatch('loom-1', 'ep-1', { ...options, videoMode: 'grok' });
    await vi.waitFor(() => expect(queueMocks.enqueueJob).toHaveBeenCalled());
    expect(videoAsset(grokRun)).toMatchObject({ provider: 'grok', modelId: 'grok-imagegen' });
    expect(visualConditioningMocks.fableLoomVideoCapabilities).toHaveBeenLastCalledWith({
      backend: 'grok', model: { id: 'grok-video', supportedModes: ['image'] },
    });
    const [grokJob] = queueMocks.enqueueJob.mock.calls[0];
    expect(grokJob.kind).toBe('video');
    expect(grokJob.params).toMatchObject({
      mode: 'grok', videoMode: 'image', prompt, negativePrompt: '',
      width: 1024, height: 576, aspectRatio: '16:9', sourceImagePath: '/example/frame.png', fableLoom,
    });
  });

  it('sends an edit-only local image model its lead reference as the init image, not twice', async () => {
    mediaModelMocks.isEditOnly.mockReturnValue(true);
    visualConditioningMocks.compileFableLoomVisualRequest.mockResolvedValue({
      prompt: 'p', referenceImagePaths: ['/example/lead.png', '/example/second.png'], referenceImageStrengths: [0.4, 0.6],
    });
    await startEpisodeProductionBatch('loom-1', 'ep-1', { assetTypes: ['image'], nodeIds: ['node-1'] });
    await vi.waitFor(() => expect(queueMocks.enqueueJob).toHaveBeenCalled());
    expect(queueMocks.enqueueJob.mock.calls[0][0].params).toMatchObject({
      initImagePath: '/example/lead.png',
      referenceImagePaths: ['/example/second.png'],
      referenceImageStrengths: [0.6],
    });

    _resetProductionBatchRuns();
    queueMocks.enqueueJob.mockClear();
    mediaModelMocks.isEditOnly.mockReturnValue(false);
    await startEpisodeProductionBatch('loom-1', 'ep-1', { assetTypes: ['image'], nodeIds: ['node-1'] });
    await vi.waitFor(() => expect(queueMocks.enqueueJob).toHaveBeenCalled());
    const params = queueMocks.enqueueJob.mock.calls[0][0].params;
    expect(params).not.toHaveProperty('initImagePath');
    expect(params).toMatchObject({
      referenceImagePaths: ['/example/lead.png', '/example/second.png'],
      referenceImageStrengths: [0.4, 0.6],
    });
  });

  it('fails a local video render whose model cannot take the resolved input mode', async () => {
    const loom = structuredClone(sampleLoom);
    loom.episodes[0].nodes.forEach(node => { node.image = 'example-frame.png'; });
    records.getLoom.mockResolvedValue(loom);
    videoModelMocks.resolveVideoModel.mockReturnValue({ id: 'video-model', supportedModes: ['image'] });
    visualConditioningMocks.compileFableLoomVisualRequest.mockResolvedValue({ prompt: 'p', sourceImagePath: null });
    const run = await startEpisodeProductionBatch('loom-1', 'ep-1', {
      videoMode: 'local', assetTypes: ['video_entry'], nodeIds: ['node-1'],
    });
    await vi.waitFor(() => expect(getEpisodeProductionBatch(run.id).status).toBe('failed'));
    expect(getEpisodeProductionBatch(run.id).error).toBe('Video model "video-model" does not support text-to-video renders.');
    expect(queueMocks.enqueueJob).not.toHaveBeenCalled();
  });

  it('queues Reactor with its compact compiled script and fails oversized scripts before queueing', async () => {
    const loom = structuredClone(sampleLoom);
    loom.episodes[0].nodes.forEach((node) => { node.image = 'example-frame.png'; });
    loom.episodes[0].nodes[0].shot = { durationSeconds: 8 };
    records.getLoom.mockResolvedValue(loom);
    settingsMocks.getSettings.mockResolvedValue({ videoGen: { reactor: { apiKey: 'example-key' } } });
    const prompt = 'Preserve source identity. No subtitles. Static close-up. HERO: "The gate is open."';
    visualConditioningMocks.compileFableLoomVisualRequest.mockResolvedValue({
      prompt, sourceImagePath: '/example/frame.png', visualConditioning: { compiledPrompt: prompt },
    });
    const options = { videoMode: 'reactor', assetTypes: ['video_entry'], nodeIds: ['node-1'] };
    await startEpisodeProductionBatch('loom-1', 'ep-1', options);
    await vi.waitFor(() => expect(queueMocks.enqueueJob).toHaveBeenCalled());
    expect(visualConditioningMocks.fableLoomVideoCapabilities).toHaveBeenCalledWith(expect.objectContaining({ backend: 'reactor', model: { id: 'reactor-video', supportedModes: ['text', 'image'] } }));
    expect(queueMocks.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'video', params: expect.objectContaining({
        mode: 'reactor', prompt, seconds: 8, sourceImagePath: '/example/frame.png',
        visualConditioning: expect.objectContaining({ compiledPrompt: prompt, render: expect.objectContaining({ provider: 'reactor', parameters: expect.objectContaining({ seconds: 8 }) }) }),
      }),
    }));

    _resetProductionBatchRuns();
    queueMocks.enqueueJob.mockClear();
    visualConditioningMocks.compileFableLoomVisualRequest.mockResolvedValue({ prompt: 'x'.repeat(801) });
    const rejected = await startEpisodeProductionBatch('loom-1', 'ep-1', options);
    await vi.waitFor(() => expect(getEpisodeProductionBatch(rejected.id).status).toBe('failed'));
    expect(queueMocks.enqueueJob).not.toHaveBeenCalled();
    expect(getEpisodeProductionBatch(rejected.id).error).toContain('1–800');
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

  describe('exact-input recorded environment audit', () => {
    const planWithManifests = async (manifests) => {
      const exactLoom = structuredClone(sampleLoom);
      const [first, ...rest] = manifests;
      exactLoom.episodes[0].nodes[0].visualConditioning = first;
      exactLoom.episodes[0].nodes[0].playbackAssets = {
        visualConditioningByAsset: Object.fromEntries(rest.map((manifest, index) => [`extra-${index}`, manifest])),
      };
      records.getLoom.mockResolvedValue(exactLoom);
      const plan = await planEpisodeProduction('loom-1', 'ep-1', { mode: 'exact_inputs' });
      return plan.exactInputIssues
        .filter((issue) => issue.nodeId === 'node-1')
        .flatMap((issue) => issue.errors)
        .filter((error) => /names unsupported|requires Grok|is disabled/.test(error));
    };
    const manifest = (capability) => ({ version: 1, status: 'locked', capability });

    it.each([
      ['an unsupported video backend', { kind: 'video', backend: 'mystery', modelId: 'm' },
        {}, 'Recorded visual conditioning names unsupported video backend "mystery".'],
      ['a recorded Grok video while Grok is disabled', { kind: 'video', backend: 'grok', modelId: 'm' },
        { imageGen: { grok: { enabled: false } } },
        'Recorded visual conditioning requires Grok video, which is disabled in Settings → Image Gen.'],
      ['an unsupported image backend', { kind: 'image', backend: 'mystery', modelId: 'm' },
        {}, 'Recorded visual conditioning names unsupported image backend "mystery".'],
      ['a disabled cloud image provider', { kind: 'image', backend: 'fal', modelId: 'm' },
        { imageGen: { fal: { enabled: false } } }, 'is disabled'],
    ])('reports %s', async (_label, capability, settings, expected) => {
      settingsMocks.getSettings.mockResolvedValue({ videoGen: {}, ...settings });
      const errors = await planWithManifests([manifest(capability)]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(expected);
    });

    it('reports one message when two manifests on a node share a capability key', async () => {
      const capability = { kind: 'image', backend: 'mystery', modelId: 'm' };
      const errors = await planWithManifests([manifest(capability), manifest(capability)]);
      expect(errors).toEqual(['Recorded visual conditioning names unsupported image backend "mystery".']);
    });

    it('reports nothing for a recorded local image backend', async () => {
      const errors = await planWithManifests([manifest({ kind: 'image', backend: 'local', modelId: 'image-model' })]);
      expect(errors).toEqual([]);
    });
  });

  it('replays the complete recorded image parameter tuple in exact-input mode', async () => {
    const exactLoom = structuredClone(sampleLoom);
    const recorded = (assetId) => ({
      version: 1,
      compilerVersion: 'visual-v1',
      status: 'locked',
      universeId: 'univ-1',
      assetId,
      capability: {
        kind: 'image', backend: 'local', modelId: 'image-model', modelRevision: 'image-revision-1',
      },
      bindings: { inferred: false, characterAppearances: [], objectIds: [] },
      assets: [],
      adapters: [],
      omitted: [],
      warnings: [],
      render: {
        parameters: {
          width: 1280,
          height: 720,
          aspectRatio: '16:9',
          steps: 41,
          guidance: 5.25,
          quantize: '4',
          seed: 987654,
        },
      },
    });
    for (const node of exactLoom.episodes[0].nodes) {
      node.image = `${node.id}.png`;
      node.visualConditioning = recorded(`asset-${node.id}-still`);
    }
    records.getLoom.mockResolvedValue(exactLoom);
    visualConditioningMocks.compileFableLoomVisualRequest.mockImplementation(async ({ tag }) => ({
      prompt: 'Recorded prompt',
      negativePrompt: '',
      referenceImagePaths: [],
      referenceImageStrengths: [],
      loraFilenames: [],
      loraScales: [],
      visualConditioning: recorded(`asset-${tag.nodeId}-still`),
    }));

    await startEpisodeProductionBatch('loom-1', 'ep-1', {
      mode: 'exact_inputs',
      assetTypes: ['image'],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(queueMocks.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'image',
      params: expect.objectContaining({
        width: 1280,
        height: 720,
        aspectRatio: '16:9',
        steps: 41,
        guidance: 5.25,
        quantize: '4',
        seed: 987654,
      }),
    }));
  });

  it('replays the same authored conditioning after persistence and refuses changed input bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fableloom-replay-'));
    const originalImages = PATHS.images;
    const originalLoras = PATHS.loras;
    const originalData = PATHS.data;
    PATHS.images = join(dir, 'images');
    PATHS.loras = join(dir, 'loras');
    PATHS.data = join(dir, 'data');
    let store;
    try {
      await mkdir(PATHS.images, { recursive: true });
      await mkdir(join(PATHS.loras, 'nested'), { recursive: true });
      const reference = join(PATHS.images, 'reference.png');
      const init = join(PATHS.images, 'init.png');
      const adapter = join(PATHS.loras, 'nested', 'adapter.safetensors');
      const canonAdapter = join(PATHS.loras, 'canon.safetensors');
      const canonImages = ['neutral', 'profile', 'full-body'].map(role => join(PATHS.images, `${role}.png`));
      await Promise.all([
        writeFile(reference, 'reference-original'), writeFile(init, 'init-original'),
        writeFile(adapter, 'adapter-original'), writeFile(canonAdapter, 'canon-original'),
        ...canonImages.map((path, index) => writeFile(path, `canon-image-${index}`)),
      ]);
      const universe = structuredClone(sampleUniverse);
      universe.characters[0].identityPack = { assets: ['neutral', 'profile', 'full-body'].map(role => ({
        role, imageRef: `${role}.png`, approved: true,
      })) };
      universeBuilder.getUniverse.mockResolvedValue(universe);
      loras.listLoras.mockResolvedValue([{ filename: 'canon.safetensors', source: 'trained',
        character: { entryId: 'char-1' }, loraCompatKey: 'flux2', recommendedScale: 0.8 }]);
      const exactLoom = structuredClone(sampleLoom);
      for (const node of exactLoom.episodes[0].nodes) {
        node.image = `${node.id}.png`;
        node.visualCanon = { mode: 'locked', characterAppearances: [{ characterId: 'char-1' }], placeId: null, objectIds: [] };
      }
      records.getLoom.mockImplementation(async () => exactLoom);
      const imageModel = {
        id: 'image-model', revision: 'image-revision-1', runner: 'flux2', quantization: 'none',
        hardwareCompatibility: { state: 'ready', reasons: [] },
      };
      mediaModelMocks.getImageModels.mockReturnValue([imageModel]);
      imagePrepareMocks.selectLocalImageModelFromSettings.mockReturnValue(imageModel);
      imagePrepareMocks.resolveLocalImageModel.mockReturnValue({ pythonPath: null, selectedModel: imageModel });
      const realCompiler = await vi.importActual('./visualConditioning.js');
      visualConditioningMocks.compileFableLoomVisualRequest.mockImplementation(realCompiler.compileFableLoomVisualRequest);
      visualConditioningMocks.fableLoomImageCapabilities.mockImplementation(realCompiler.fableLoomImageCapabilities);
      loras.readTriggerWordsByFilename.mockResolvedValue({});
      const settings = await settingsMocks.getSettings();
      const prepared = await prepareFableLoomImageParams({ settings, mode: 'local', params: {
        fableLoom: { loomId: 'loom-1', episodeId: 'ep-1', nodeId: 'node-1' },
        prompt: 'An authored view', negativePrompt: 'fog', modelId: 'image-model',
        referenceImagePaths: [reference], referenceImageStrengths: [0.4],
        initImagePath: init, initImageStrength: 0.3,
        loraPaths: [adapter], loraScales: [0.7],
      } });
      expect(prepared.visualConditioning.adapters).toEqual([
        expect.objectContaining({ source: 'Canon adapter', filename: 'canon.safetensors' }),
        expect.objectContaining({ source: 'Request adapter', relativePath: 'nested/adapter.safetensors' }),
      ]);
      imageSidecarMocks.readImageSidecar.mockResolvedValue({ metadata: {
        filename: 'node-1.png', modelId: 'image-model', prompt: prepared.prompt,
        width: 1024, height: 576, steps: 20, guidance: 1, quantize: '8', seed: 123,
      } });
      const actualRecords = await vi.importActual('./records.js');
      store = await vi.importActual('./store.js');
      store._resetFableLoomBackend();
      await store.writeRaw('loom-1', exactLoom);
      records.attachNodeImage.mockImplementation(actualRecords.attachNodeImage);
      sceneImageHookTesting.reset();
      initFableLoomSceneImageHook();
      queueMocks.mediaJobEvents.emit('completed', {
        kind: 'image', id: 'render-job-1',
        params: { ...prepared, fableLoom: { loomId: 'loom-1', episodeId: 'ep-1', nodeId: 'node-1' } },
        result: { filename: 'node-1.png' },
      });
      await sceneImageHookTesting.settled();
      expect(records.attachNodeImage).toHaveBeenCalledWith('loom-1', 'ep-1', 'node-1', expect.objectContaining({
        filename: 'node-1.png', jobId: 'render-job-1', visualConditioning: expect.objectContaining({
          renderedPrompt: prepared.prompt, render: expect.objectContaining({ parameters: expect.objectContaining({ seed: 123 }) }),
        }),
      }));
      const storedLoom = JSON.parse(await readFile(join(PATHS.data, 'fableloom', 'loom-1', 'index.json'), 'utf8'));
      const reloadedLoom = await actualRecords.getLoom('loom-1');
      const reloaded = reloadedLoom.episodes[0].nodes[0].visualConditioning;
      expect(storedLoom.episodes[0].nodes[0].visualConditioning).toEqual(reloaded);
      expect(reloaded.assets).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'character-neutral', inputRoot: 'images', filename: 'neutral.png', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
        expect.objectContaining({ role: 'request-reference', inputRoot: 'images', filename: 'reference.png' }),
        expect.objectContaining({ role: 'request-init', inputRoot: 'images', strength: 0.3 }),
      ]));
      expect(reloaded.adapters).toEqual([
        expect.objectContaining({ source: 'Canon adapter', filename: 'canon.safetensors' }),
        expect.objectContaining({ source: 'Request adapter', relativePath: 'nested/adapter.safetensors' }),
      ]);
      for (const node of reloadedLoom.episodes[0].nodes) node.visualConditioning = reloaded;
      records.getLoom.mockResolvedValue(reloadedLoom);
      await startEpisodeProductionBatch('loom-1', 'ep-1', { mode: 'exact_inputs', assetTypes: ['image'], nodeIds: ['node-1'] });
      await vi.waitFor(() => expect(queueMocks.enqueueJob).toHaveBeenCalled());
      expect(queueMocks.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({
        prompt: prepared.prompt, negativePrompt: prepared.negativePrompt, seed: 123,
        initImagePath: init, initImageStrength: 0.3,
        referenceImagePaths: [...canonImages, reference], referenceImageStrengths: [1, 1, 1, 0.4],
        loraFilenames: ['canon.safetensors'], loraPaths: [adapter], loraScales: [0.8, 0.7],
      }) }));
      reloadedLoom.episodes[0].nodes[0].visualCanon.placeId = 'place-that-no-longer-exists';
      await expect(startEpisodeProductionBatch('loom-1', 'ep-1', { mode: 'exact_inputs', assetTypes: ['image'], nodeIds: ['node-1'] }))
        .rejects.toMatchObject({ code: 'EXACT_INPUTS_REFUSED', status: 409 });
      reloadedLoom.episodes[0].nodes[0].visualCanon.placeId = null;
      await writeFile(reference, 'reference-changed');
      await expect(startEpisodeProductionBatch('loom-1', 'ep-1', { mode: 'exact_inputs', assetTypes: ['image'], nodeIds: ['node-1'] }))
        .rejects.toMatchObject({ code: 'EXACT_INPUTS_REFUSED', status: 409 });
      await writeFile(reference, 'reference-original');
      await writeFile(adapter, 'adapter-changed');
      await expect(startEpisodeProductionBatch('loom-1', 'ep-1', { mode: 'exact_inputs', assetTypes: ['image'], nodeIds: ['node-1'] }))
        .rejects.toMatchObject({ code: 'EXACT_INPUTS_REFUSED', status: 409 });
      await writeFile(adapter, 'adapter-original');
      await writeFile(canonAdapter, 'canon-changed');
      await expect(startEpisodeProductionBatch('loom-1', 'ep-1', { mode: 'exact_inputs', assetTypes: ['image'], nodeIds: ['node-1'] }))
        .rejects.toMatchObject({ code: 'EXACT_INPUTS_REFUSED', status: 409 });
      await writeFile(canonAdapter, 'canon-original');
      // A canon image keeps its filename but changes bytes after the render.
      await writeFile(canonImages[1], 'canon-image-changed');
      await expect(startEpisodeProductionBatch('loom-1', 'ep-1', { mode: 'exact_inputs', assetTypes: ['image'], nodeIds: ['node-1'] }))
        .rejects.toMatchObject({ code: 'EXACT_INPUTS_REFUSED', status: 409 });
      const plan = await planEpisodeProduction('loom-1', 'ep-1', { mode: 'exact_inputs', assetTypes: ['image'], nodeIds: ['node-1'] });
      expect(plan.exactInputIssues.flatMap(issue => issue.errors)).toContain('Canon image "profile.png" is unavailable or changed.');
      await writeFile(canonImages[1], 'canon-image-1');
      // A render recorded before canon fingerprints names its canon images but cannot prove their bytes.
      for (const node of reloadedLoom.episodes[0].nodes) {
        node.visualConditioning = { ...reloaded, assets: reloaded.assets.map(({ inputRoot: _root, sha256: _sha, ...asset }) => (
          asset.role.startsWith('request-') ? { ...asset, inputRoot: _root, sha256: _sha } : asset)) };
      }
      const legacyPlan = await planEpisodeProduction('loom-1', 'ep-1', { mode: 'exact_inputs', assetTypes: ['image'], nodeIds: ['node-1'] });
      expect(legacyPlan.exactInputIssues.flatMap(issue => issue.errors)).toContainEqual(expect.stringContaining('images "neutral.png", "profile.png", "full-body.png" have no content fingerprints'));
      await expect(startEpisodeProductionBatch('loom-1', 'ep-1', { mode: 'exact_inputs', assetTypes: ['image'], nodeIds: ['node-1'] }))
        .rejects.toMatchObject({ code: 'EXACT_INPUTS_REFUSED', status: 409 });
      expect(queueMocks.enqueueJob).toHaveBeenCalledTimes(1);
    } finally {
      sceneImageHookTesting.reset();
      records.attachNodeImage.mockReset();
      store?._resetFableLoomBackend();
      PATHS.images = originalImages;
      PATHS.loras = originalLoras;
      PATHS.data = originalData;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('cancels an in-progress batch run', async () => {
    const run = await startEpisodeProductionBatch('loom-1', 'ep-1', { mode: 'current_canon' });
    const canceled = await cancelEpisodeProductionBatch(run.id);
    expect(canceled.status).toBe('canceled');
    expect(canceled.cancelRequested).toBe(true);
    expect(snapshots.at(-1)).toMatchObject({ status: 'canceled', cancelRequested: true });
  });

  it('resumes a canceled run after resetting unfinished assets', async () => {
    const run = await startEpisodeProductionBatch('loom-1', 'ep-1', { mode: 'current_canon' });
    await cancelEpisodeProductionBatch(run.id);

    const resumed = resumeEpisodeProductionBatch(run.id);
    expect(resumed.status).toBe('in_progress');
    expect(snapshots.at(-1)).toMatchObject({ status: 'in_progress', attempt: 2 });
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
    expect(snapshots.at(-1)).toMatchObject({ id: run.id, status: 'completed', summary: run.summary });
  });

  it('performs episodic continuity review returning structured findings', async () => {
    const review = await reviewEpisodeContinuity('loom-1', 'ep-1');
    expect(review.passed).toBe(true);
    expect(review.nodesEvaluated).toBe(2);
    expect(review.findings).toBeDefined();
  });
});
