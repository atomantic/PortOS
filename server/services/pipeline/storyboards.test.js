/**
 * storyboards.test.js
 *
 * Storyboard scene/shot enqueue, concurrency, durable-id addressing and refine. Split from visualStages.test.js (#16214); shared mocks and state live in
 * visualStages.testFixtures.js.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above imports; the shared fixtures module is
// loaded the same way.
const h = await vi.hoisted(() => import('./visualStages.testFixtures.js'));

vi.mock('./issues.js', () => h.issuesFactory());
vi.mock('./series.js', () => h.seriesFactory());
vi.mock('../settings.js', () => h.settingsFactory());
vi.mock('../universeBuilder.js', () => h.universeBuilderFactory());
vi.mock('../mediaJobQueue/index.js', () => h.mediaJobQueueFactory());
vi.mock('../stageRunner.js', () => h.stageRunnerFactory());
vi.mock('../../lib/mediaModels.js', () => h.mediaModelsFactory());
vi.mock('../characterLoraResolver.js', () => h.characterLoraResolverFactory());

const {
  assertStageUnlockedMock,
  cancelJobMock,
  enqueueJobMock,
  getIssueMock,
  listFakeJobs,
  mockIssue,
  runStagedLLMMock,
  updateStageMock,
  updateStageWithLatestMock,
  useStoryboardScenes,
} = h;
const {
  enqueueStoryboardSceneVideo,
  enqueueStoryboardShotStartFrame,
  refineStoryboardScenePrompt,
  generateStoryboardSceneImagePrompts,
  renderComicCover,
  renderComicPage,
} = await import('./visualStages.js');

// The universeBuilder mock's getUniverse is auto-captured here so individual
// tests can feed enqueueVisualImage a canon (pickCanon reads universe.characters).
const { getUniverse } = await import('../universeBuilder.js');

beforeEach(() => {
  h.resetMocks();
});

describe('per-stage lock enforcement', () => {
  it('checks the storyboards lock before queueing a scene video', async () => {
    await enqueueStoryboardSceneVideo('iss-test', 0, { aspectRatio: '16:9' });
    expect(assertStageUnlockedMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'iss-test' }), 'storyboards');
  });
});

describe('enqueueStoryboardSceneVideo', () => {
  it('rejects a non-integer sceneIndex', async () => {
    await expect(enqueueStoryboardSceneVideo('iss-test', 'nope')).rejects.toThrow(/non-negative integer/);
  });

  it('rejects when sceneIndex is out of range', async () => {
    await expect(enqueueStoryboardSceneVideo('iss-test', 99)).rejects.toThrow(/out of range/);
  });

  it('rejects when the scene has no description', async () => {
    getIssueMock.mockResolvedValueOnce({
      ...structuredClone(mockIssue),
      stages: { ...mockIssue.stages, storyboards: { scenes: [{ description: '   ' }] } },
    });
    await expect(enqueueStoryboardSceneVideo('iss-test', 0)).rejects.toThrow(/no description/);
  });

  it('rejects when modelId is unknown for this platform', async () => {
    await expect(enqueueStoryboardSceneVideo('iss-test', 0, { modelId: 'ltx-typo' }))
      .rejects.toThrow(/Unknown video model/);
  });

  it('rejects when local python is not configured', async () => {
    const settingsMod = await import('../settings.js');
    settingsMod.getSettings.mockResolvedValueOnce({ imageGen: { local: { pythonPath: null }, mode: 'local' }, videoGen: {} });
    await expect(enqueueStoryboardSceneVideo('iss-test', 0)).rejects.toThrow(/VIDEO_GEN_NOT_CONFIGURED|is not configured/);
  });

  it('happy path: enqueues a t2v video job and persists sceneVideoJobId on the scene', async () => {
    const result = await enqueueStoryboardSceneVideo('iss-test', 0, { aspectRatio: '9:16' });
    expect(result.jobId).toBe('job-fake-1234');
    expect(result.sceneIndex).toBe(0);
    expect(enqueueJobMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'video',
      params: expect.objectContaining({ mode: 't2v', disableAudio: true, width: 432, height: 768 }),
    }));
    expect(updateStageWithLatestMock).toHaveBeenCalledWith('iss-test', 'storyboards', expect.any(Function));
    expect(result.stage.scenes[0].sceneVideoJobId).toBe('job-fake-1234');
    expect(result.stage.status).toBe('edited');
  });
});

describe('enqueueStoryboardSceneVideo aspect ratio', () => {
  it('falls back to 16:9 for an unknown or Object.prototype aspect ratio', async () => {
    for (const aspectRatio of ['nope', 'constructor', 'toString']) {
      enqueueJobMock.mockClear();
      await enqueueStoryboardSceneVideo('iss-test', 0, { aspectRatio });
      expect(enqueueJobMock).toHaveBeenCalledWith(expect.objectContaining({
        params: expect.objectContaining({ width: 768, height: 432 }),
      }));
    }
  });
});

describe('enqueueStoryboardShotStartFrame', () => {
  it('rejects non-integer indices', async () => {
    await expect(enqueueStoryboardShotStartFrame('iss-test', 'nope', 0)).rejects.toThrow(/non-negative integers/);
    await expect(enqueueStoryboardShotStartFrame('iss-test', 0, -1)).rejects.toThrow(/non-negative integers/);
  });

  it('404s when the scene index is out of range', async () => {
    await expect(enqueueStoryboardShotStartFrame('iss-test', 99, 0)).rejects.toThrow(/scene.*out of range/i);
  });

  it('404s when the shot index is out of range', async () => {
    getIssueMock.mockResolvedValueOnce({
      ...structuredClone(mockIssue),
      stages: { ...mockIssue.stages, storyboards: { scenes: [{ description: 'a', shots: [{ id: 's1', description: 'first' }] }] } },
    });
    await expect(enqueueStoryboardShotStartFrame('iss-test', 0, 5)).rejects.toThrow(/shot.*out of range/i);
  });

  it('rejects when the shot AND parent scene are both empty', async () => {
    getIssueMock.mockResolvedValueOnce({
      ...structuredClone(mockIssue),
      stages: { ...mockIssue.stages, storyboards: { scenes: [{ description: '   ', shots: [{ id: 's1', description: '   ' }] }] } },
    });
    await expect(enqueueStoryboardShotStartFrame('iss-test', 0, 0)).rejects.toThrow(/no description/i);
  });

  it('happy path: enqueues image job, stamps startFrameJobId on the shot', async () => {
    useStoryboardScenes([{ description: 'wide', shots: [{ id: 's1', description: 'close on the lock' }] }]);
    const result = await enqueueStoryboardShotStartFrame('iss-test', 0, 0);
    expect(result.jobId).toBe('job-fake-1234');
    expect(result.sceneIndex).toBe(0);
    expect(result.shotIndex).toBe(0);
    expect(enqueueJobMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'image',
      // scene carries no id in this fixture (pre-migration record) — the owner
      // still stamps the shot's durable id (#3413).
      owner: 'pipeline:iss-test:storyboards:scene0:shot0:sid:tids1',
    }));
    expect(updateStageWithLatestMock).toHaveBeenCalledWith('iss-test', 'storyboards', expect.any(Function));
    expect(result.stage.scenes[0].shots[0].startFrameJobId).toBe('job-fake-1234');
    expect(result.stage.status).toBe('edited');
  });

  // Uniquely catches a pipeline render's universe / series blocks reaching the
  // model without being listed on its sent-prompt record (#11317).
  it('lists the universe and series blocks folded into the frame prompt', async () => {
    useStoryboardScenes([{ description: 'wide', shots: [{ id: 's1', description: 'close on the lock' }] }]);
    getUniverse.mockResolvedValueOnce({ id: 'u1', influences: { embrace: ['ink wash'], avoid: ['photo'] } });
    await enqueueStoryboardShotStartFrame('iss-test', 0, 0);
    const { params } = enqueueJobMock.mock.calls[0][0];
    expect(params.promptAdditions.map((item) => item.label)).toEqual(['Universe style', 'Series style notes', 'Universe avoid (negative prompt)']);
    for (const item of params.promptAdditions.slice(0, 2)) expect(params.prompt).toContain(item.text);
    expect(params.negativePrompt).toContain('photo');
  });

  it('falls back to the parent scene description when the shot description is empty', async () => {
    useStoryboardScenes([{ description: 'wide shot of the bridge at dawn', shots: [{ id: 's1', description: '' }] }]);
    const result = await enqueueStoryboardShotStartFrame('iss-test', 0, 0);
    expect(result.prompt).toMatch(/bridge at dawn/i);
  });
});

// #3400 — two enqueues for DIFFERENT scenes on the same issue used to clobber
// each other: both read `scenes` up front, then each wrote the whole pre-read
// array back through `updateStage`, so the second write reverted the first
// scene's freshly-stamped job id and left that job running untracked.
// `updateStage` serializing the writes never helped — the array being written
// was computed outside the lock. These tests drive both enqueues concurrently
// against a genuinely stateful store and assert BOTH job ids survive.
describe('concurrent storyboard scene enqueues (#3400)', () => {
  // A real serialized write tail: one shared persisted stage, one mutex, and
  // the caller's computeFn evaluated INSIDE the lock against fresh state.
  const installSerializedWriteTail = (initialScenes) => {
    const persisted = { storyboards: { scenes: structuredClone(initialScenes) } };
    let tail = Promise.resolve();
    getIssueMock.mockImplementation(async () => ({
      ...structuredClone(mockIssue),
      stages: { ...structuredClone(mockIssue.stages), storyboards: structuredClone(persisted.storyboards) },
    }));
    updateStageWithLatestMock.mockImplementation((issueId, stageId, computeFn) => {
      tail = tail.then(async () => {
        // yield once inside the lock so an unserialized implementation would
        // definitely interleave here
        await Promise.resolve();
        const current = structuredClone(persisted[stageId] || {});
        const patch = computeFn(current);
        persisted[stageId] = { ...current, ...patch };
        return { issue: { ...mockIssue, stages: structuredClone(persisted) }, stage: structuredClone(persisted[stageId]) };
      });
      return tail;
    });
    return persisted;
  };

  it('keeps both sceneVideoJobIds when two scene-video enqueues interleave', async () => {
    const persisted = installSerializedWriteTail([
      { slugline: 'A', description: 'Scene 1.' },
      { slugline: 'B', description: 'Scene 2.' },
    ]);
    enqueueJobMock
      .mockReturnValueOnce({ jobId: 'job-scene-0' })
      .mockReturnValueOnce({ jobId: 'job-scene-1' });

    await Promise.all([
      enqueueStoryboardSceneVideo('iss-test', 0, {}),
      enqueueStoryboardSceneVideo('iss-test', 1, {}),
    ]);

    expect(persisted.storyboards.scenes[0].sceneVideoJobId).toBe('job-scene-0');
    expect(persisted.storyboards.scenes[1].sceneVideoJobId).toBe('job-scene-1');
  });

  it('keeps both startFrameJobIds when two shot enqueues on different scenes interleave', async () => {
    const persisted = installSerializedWriteTail([
      { description: 'Scene 1.', shots: [{ id: 's1', description: 'shot one' }] },
      { description: 'Scene 2.', shots: [{ id: 's2', description: 'shot two' }] },
    ]);
    enqueueJobMock
      .mockReturnValueOnce({ jobId: 'job-shot-0' })
      .mockReturnValueOnce({ jobId: 'job-shot-1' });

    await Promise.all([
      enqueueStoryboardShotStartFrame('iss-test', 0, 0),
      enqueueStoryboardShotStartFrame('iss-test', 1, 0),
    ]);

    expect(persisted.storyboards.scenes[0].shots[0].startFrameJobId).toBe('job-shot-0');
    expect(persisted.storyboards.scenes[1].shots[0].startFrameJobId).toBe('job-shot-1');
  });

  it('a scene-video enqueue does not revert a concurrent sibling-scene prompt refine', async () => {
    const persisted = installSerializedWriteTail([
      { description: 'Scene 1.' },
      { description: 'Scene 2.' },
    ]);
    enqueueJobMock.mockReturnValueOnce({ jobId: 'job-scene-0' });

    await Promise.all([
      enqueueStoryboardSceneVideo('iss-test', 0, {}),
      refineStoryboardScenePrompt('iss-test', 1),
    ]);

    expect(persisted.storyboards.scenes[0].sceneVideoJobId).toBe('job-scene-0');
    expect(persisted.storyboards.scenes[1].description).toBe('refined prompt body');
  });

  it('404s when the target scene disappeared before the write landed', async () => {
    installSerializedWriteTail([{ description: 'Scene 1.' }, { description: 'Scene 2.' }]);
    getIssueMock.mockResolvedValueOnce({
      ...structuredClone(mockIssue),
      stages: {
        ...structuredClone(mockIssue.stages),
        // the caller reads 3 scenes, but only 2 are persisted by write time
        storyboards: { scenes: [{ description: 'a' }, { description: 'b' }, { description: 'c' }] },
      },
    });
    await expect(enqueueStoryboardSceneVideo('iss-test', 2, {}))
      .rejects.toThrow(/out of range/);
  });
});

// #3413 — index addressing survived #3400: a reorder/delete that kept `index`
// IN RANGE still retargeted the write onto whatever scene now sat in that slot,
// and a rejected write left the already-enqueued job orphaned in the queue.
// Scenes now carry a durable `id`; the write region resolves by it.
describe('storyboard scene durable-id addressing (#3413)', () => {
  // Same serialized write tail as the #3400 block, but the persisted array can
  // differ from what the caller read — that IS the race being modeled.
  const installWriteTail = (persistedScenes) => {
    const persisted = { storyboards: { scenes: structuredClone(persistedScenes) } };
    let tail = Promise.resolve();
    updateStageWithLatestMock.mockImplementation((issueId, stageId, computeFn) => {
      tail = tail.then(async () => {
        await Promise.resolve();
        const current = structuredClone(persisted[stageId] || {});
        const patch = computeFn(current);
        persisted[stageId] = { ...current, ...patch };
        return { issue: { ...mockIssue, stages: structuredClone(persisted) }, stage: structuredClone(persisted[stageId]) };
      });
      return tail;
    });
    return persisted;
  };

  // What the CALLER read (which may no longer match what is persisted).
  const readScenes = (scenes) => {
    getIssueMock.mockResolvedValue({
      ...structuredClone(mockIssue),
      stages: { ...structuredClone(mockIssue.stages), storyboards: { scenes: structuredClone(scenes) } },
    });
  };

  const SCENE_A = { id: 'scene-01', slugline: 'A', description: 'Scene A.' };
  const SCENE_B = { id: 'scene-02', slugline: 'B', description: 'Scene B.' };

  it('a reorder that keeps the index in range does NOT move the job id onto the wrong scene', async () => {
    // Persisted order is B, A — the caller read A, B and asked for index 0 (A).
    const persisted = installWriteTail([SCENE_B, SCENE_A]);
    readScenes([SCENE_A, SCENE_B]);
    enqueueJobMock.mockReturnValue({ jobId: 'job-scene-a' });

    const result = await enqueueStoryboardSceneVideo('iss-test', 0, {});

    expect(persisted.storyboards.scenes[1].id).toBe('scene-01');
    expect(persisted.storyboards.scenes[1].sceneVideoJobId).toBe('job-scene-a');
    expect(persisted.storyboards.scenes[0].sceneVideoJobId).toBeUndefined();
    // The response reports where the write LANDED, not the stale read index.
    expect(result.sceneIndex).toBe(1);
  });

  it('409s (not a mis-targeted write) when the scene was removed between read and write', async () => {
    const persisted = installWriteTail([SCENE_A, SCENE_B]);
    // Caller read a third scene that is already gone by write time — its index
    // (1) is still in range, so index addressing would have hit SCENE_B.
    readScenes([SCENE_A, { id: 'scene-99', slugline: 'gone', description: 'Deleted scene.' }, SCENE_B]);
    enqueueJobMock.mockReturnValue({ jobId: 'job-doomed' });

    await expect(enqueueStoryboardSceneVideo('iss-test', 1, {}))
      .rejects.toMatchObject({ status: 409, code: 'PIPELINE_SCENE_STALE_TARGET' });
    expect(persisted.storyboards.scenes.every((s) => !s.sceneVideoJobId)).toBe(true);
  });

  it('cancels the orphaned job when the stage write rejects — no queued job left for that owner', async () => {
    installWriteTail([SCENE_A, SCENE_B]);
    readScenes([SCENE_A, { id: 'scene-99', description: 'Deleted scene.' }, SCENE_B]);
    enqueueJobMock.mockReturnValue({ jobId: 'job-doomed' });

    await expect(enqueueStoryboardSceneVideo('iss-test', 1, {})).rejects.toThrow(/no longer exists/);

    const owner = 'pipeline:iss-test:storyboards:scene1:sidscene-99';
    expect(cancelJobMock).toHaveBeenCalledWith('job-doomed');
    expect(listFakeJobs({ owner, status: 'queued' })).toEqual([]);
    expect(listFakeJobs({ owner })).toEqual([{ id: 'job-doomed', owner, status: 'canceled' }]);
  });

  it('resolves the SHOT by id too, so a shot reorder cannot move the start-frame job', async () => {
    const shotOne = { id: 'shot-01', description: 'shot one' };
    const shotTwo = { id: 'shot-02', description: 'shot two' };
    const persisted = installWriteTail([{ ...SCENE_A, shots: [shotTwo, shotOne] }]);
    readScenes([{ ...SCENE_A, shots: [shotOne, shotTwo] }]);
    enqueueJobMock.mockReturnValue({ jobId: 'job-shot-one' });

    const result = await enqueueStoryboardShotStartFrame('iss-test', 0, 0);

    expect(enqueueJobMock).toHaveBeenCalledWith(expect.objectContaining({
      owner: 'pipeline:iss-test:storyboards:scene0:shot0:sidscene-01:tidshot-01',
    }));
    const shots = persisted.storyboards.scenes[0].shots;
    expect(shots[1].id).toBe('shot-01');
    expect(shots[1].startFrameJobId).toBe('job-shot-one');
    expect(shots[0].startFrameJobId).toBeUndefined();
    expect(result.shotIndex).toBe(1);
  });

  it('409s + cancels when the SHOT vanished between read and write', async () => {
    installWriteTail([{ ...SCENE_A, shots: [{ id: 'shot-01', description: 'shot one' }] }]);
    readScenes([{
      ...SCENE_A,
      shots: [{ id: 'shot-01', description: 'shot one' }, { id: 'shot-99', description: 'deleted shot' }],
    }]);
    enqueueJobMock.mockReturnValue({ jobId: 'job-shot-doomed' });

    await expect(enqueueStoryboardShotStartFrame('iss-test', 0, 1))
      .rejects.toMatchObject({ status: 409, code: 'PIPELINE_SHOT_STALE_TARGET' });
    expect(cancelJobMock).toHaveBeenCalledWith('job-shot-doomed');
    expect(listFakeJobs({ status: 'queued' })).toEqual([]);
  });

  it('falls back to the index for a PRE-MIGRATION record whose scenes carry no ids', async () => {
    const legacy = [{ description: 'Scene 1.' }, { description: 'Scene 2.' }];
    const persisted = installWriteTail(legacy);
    readScenes(legacy);
    enqueueJobMock.mockReturnValue({ jobId: 'job-legacy' });

    const result = await enqueueStoryboardSceneVideo('iss-test', 1, {});

    expect(persisted.storyboards.scenes[1].sceneVideoJobId).toBe('job-legacy');
    expect(result.sceneIndex).toBe(1);
    // No ids anywhere → the owner keeps the legacy index-only shape.
    expect(enqueueJobMock).toHaveBeenCalledWith(expect.objectContaining({
      owner: 'pipeline:iss-test:storyboards:scene1',
    }));
  });

  it('a scene-prompt refine lands on the scene it read, not the slot it read', async () => {
    const persisted = installWriteTail([SCENE_B, SCENE_A]);
    readScenes([SCENE_A, SCENE_B]);

    const result = await refineStoryboardScenePrompt('iss-test', 0);

    expect(persisted.storyboards.scenes[1].description).toBe('refined prompt body');
    expect(persisted.storyboards.scenes[0].description).toBe('Scene B.');
    expect(result.scene.id).toBe('scene-01');
  });

  it('a rejected COMIC PAGE slot write cancels its orphaned job too', async () => {
    updateStageWithLatestMock.mockRejectedValue(
      Object.assign(new Error('pageIndex 0 out of range'), { status: 404 }),
    );
    enqueueJobMock.mockReturnValue({ jobId: 'job-page-doomed' });

    await expect(renderComicPage('iss-test', { pageIndex: 0 })).rejects.toThrow(/out of range/);
    expect(cancelJobMock).toHaveBeenCalledWith('job-page-doomed');
    expect(listFakeJobs({ status: 'queued' })).toEqual([]);
  });

  it('a rejected COVER slot write cancels its orphaned job too', async () => {
    updateStageWithLatestMock.mockRejectedValue(new Error('issue vanished'));
    enqueueJobMock.mockReturnValue({ jobId: 'job-cover-doomed' });

    await expect(renderComicCover('iss-test', {})).rejects.toThrow(/issue vanished/);
    expect(cancelJobMock).toHaveBeenCalledWith('job-cover-doomed');
    expect(listFakeJobs({ status: 'queued' })).toEqual([]);
  });
});


describe('refineStoryboardScenePrompt', () => {
  it('rejects a non-integer sceneIndex', async () => {
    await expect(refineStoryboardScenePrompt('iss-test', 'nope')).rejects.toThrow(/non-negative integer/);
  });

  it('returns 404 when the scene does not exist', async () => {
    await expect(refineStoryboardScenePrompt('iss-test', 99)).rejects.toThrow(/out of range/);
  });

  it('rejects when the scene has no description', async () => {
    getIssueMock.mockResolvedValueOnce({
      ...structuredClone(mockIssue),
      stages: { ...mockIssue.stages, storyboards: { scenes: [{ description: '   ' }] } },
    });
    await expect(refineStoryboardScenePrompt('iss-test', 0)).rejects.toThrow(/no description to refine/);
  });

  it('rejects when the LLM returns an empty refined prompt', async () => {
    runStagedLLMMock.mockResolvedValueOnce({
      content: { prompt: '', changes: [] }, runId: 'r', providerId: 'p', model: 'm',
    });
    await expect(refineStoryboardScenePrompt('iss-test', 0)).rejects.toThrow(/empty refined prompt/);
  });

  it('happy path: replaces the scene description and uses the storyboard template', async () => {
    const result = await refineStoryboardScenePrompt('iss-test', 1);
    expect(result.runId).toBe('run-abc12345');
    expect(runStagedLLMMock).toHaveBeenCalledWith(
      'pipeline-storyboard-image-prompt',
      expect.objectContaining({
        sceneNumber: 2,
        slugline: 'EXT. STREET — DAY',
        hasSlugline: true,
        description: expect.stringContaining('Scene 2 baseline.'),
      }),
      expect.objectContaining({ returnsJson: true }),
    );
    expect(updateStageWithLatestMock).toHaveBeenCalledWith('iss-test', 'storyboards', expect.any(Function));
    expect(result.stage.scenes[1].description).toBe('refined prompt body');
    // the sibling scene this call never touched is preserved verbatim
    expect(result.stage.scenes[0].description).toBe('Scene 1 baseline.');
    expect(result.scene.description).toBe('refined prompt body');
  });
});

describe('generateStoryboardSceneImagePrompts', () => {
  it('reuses the scene validation (404 on a missing scene)', async () => {
    await expect(generateStoryboardSceneImagePrompts('iss-test', 99, { count: 2 }))
      .rejects.toThrow(/out of range|PIPELINE_SCENE_NOT_FOUND/);
  });

  it('runs the storyboard template `count` times and returns candidates without persisting', async () => {
    let n = 0;
    runStagedLLMMock.mockImplementation(async () => {
      n += 1;
      return { content: { prompt: `scene candidate ${n}`, changes: [] }, runId: `run-${n}`, providerId: 'codex', model: 'm' };
    });
    const result = await generateStoryboardSceneImagePrompts('iss-test', 1, { count: 2 });
    expect(runStagedLLMMock).toHaveBeenCalledTimes(2);
    expect(runStagedLLMMock).toHaveBeenCalledWith(
      'pipeline-storyboard-image-prompt',
      expect.objectContaining({ sceneNumber: 2 }),
      expect.objectContaining({ returnsJson: true }),
    );
    expect(result).toMatchObject({ sceneIndex: 1, requested: 2 });
    expect(result.candidates).toHaveLength(2);
    expect(updateStageMock).not.toHaveBeenCalled();
  });
});

