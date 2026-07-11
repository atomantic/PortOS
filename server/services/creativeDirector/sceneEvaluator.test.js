import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for the server-side (local-vision) scene evaluator.
 *
 * Covers: verdict parsing (tolerant of fences/chatter), provider resolution
 * (explicit pin → auto local pick → none), the vision-call happy path + the
 * fall-back-to-agent contract, and applySceneVerdict's three transitions
 * (accept + collection add / retry with refined prompt / fail when exhausted).
 */

const mocks = vi.hoisted(() => ({
  runPromptThroughProvider: vi.fn(),
  assertVisionRunUsedImages: vi.fn((r, p) => r?.provider || p),
  getSettings: vi.fn(),
  getProviderById: vi.fn(),
  listVisionModels: vi.fn(),
  addItem: vi.fn(),
  updateScene: vi.fn(),
  recordRun: vi.fn(),
  updateRun: vi.fn(),
  enqueueEvaluateTask: vi.fn(),
  advanceAfterSceneSettled: vi.fn(),
  existsSync: vi.fn(() => true),
}));

vi.mock('fs', () => ({ existsSync: mocks.existsSync }));
vi.mock('../../lib/fileUtils.js', () => ({ PATHS: { videoThumbnails: '/data/video-thumbnails' } }));
vi.mock('../../lib/aiProvider.js', () => ({ stripCodeFences: (s) => String(s).replace(/```[a-z]*\n?/gi, '').replace(/```/g, '') }));
vi.mock('../../lib/promptRunner.js', () => ({
  runPromptThroughProvider: mocks.runPromptThroughProvider,
  assertVisionRunUsedImages: mocks.assertVisionRunUsedImages,
}));
vi.mock('../settings.js', () => ({ getSettings: mocks.getSettings }));
vi.mock('../providers.js', () => ({ getProviderById: mocks.getProviderById }));
vi.mock('../localLlm.js', () => ({ listVisionModels: mocks.listVisionModels }));
vi.mock('../mediaCollections.js', () => ({ addItem: mocks.addItem }));
vi.mock('./local.js', () => ({
  updateScene: mocks.updateScene,
  recordRun: mocks.recordRun,
  updateRun: mocks.updateRun,
}));
vi.mock('./agentBridge.js', () => ({ enqueueEvaluateTask: mocks.enqueueEvaluateTask }));
vi.mock('./completionHook.js', () => ({ advanceAfterSceneSettled: mocks.advanceAfterSceneSettled }));

const {
  parseVisionVerdict,
  resolveVisionEvalTarget,
  evaluateSceneWithVision,
  applySceneVerdict,
  dispatchSceneEvaluation,
} = await import('./sceneEvaluator.js');

const OLLAMA = { id: 'ollama', type: 'api', enabled: true };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.existsSync.mockReturnValue(true);
  mocks.getSettings.mockResolvedValue({});
  mocks.listVisionModels.mockResolvedValue([]);
  mocks.getProviderById.mockResolvedValue(null);
  mocks.updateScene.mockResolvedValue({});
  mocks.recordRun.mockResolvedValue({});
  mocks.updateRun.mockResolvedValue({});
  mocks.addItem.mockResolvedValue({});
  mocks.enqueueEvaluateTask.mockResolvedValue({});
  mocks.advanceAfterSceneSettled.mockResolvedValue(undefined);
  mocks.assertVisionRunUsedImages.mockImplementation((r, p) => r?.provider || p);
});

describe('parseVisionVerdict', () => {
  it('parses a bare JSON object', () => {
    const v = parseVisionVerdict('{"accepted": true, "score": 0.8, "notes": "great"}');
    expect(v).toEqual({ accepted: true, score: 0.8, notes: 'great' });
  });

  it('tolerates code fences and surrounding prose', () => {
    const text = 'Here is my verdict:\n```json\n{"accepted": false, "score": 0.3, "notes": "off-style", "refinedPrompt": "add fog"}\n```\nHope that helps.';
    const v = parseVisionVerdict(text);
    expect(v.accepted).toBe(false);
    expect(v.refinedPrompt).toBe('add fog');
  });

  it('coerces loose numeric strings and requires accepted', () => {
    const v = parseVisionVerdict('{"accepted": true, "score": "0.9"}');
    expect(v.score).toBe(0.9);
  });

  it('drops an out-of-range score instead of failing the whole verdict', () => {
    const v = parseVisionVerdict('{"accepted": true, "score": 85, "notes": "great"}');
    expect(v.accepted).toBe(true);
    expect(v.score).toBeUndefined();
    expect(v.notes).toBe('great');
  });

  it('drops a non-string refinedPrompt (object) instead of writing "[object Object]"', () => {
    const v = parseVisionVerdict('{"accepted": false, "refinedPrompt": {"prompt": "add fog"}, "notes": "off"}');
    expect(v.accepted).toBe(false);
    expect(v.refinedPrompt).toBeUndefined();
    expect(v.notes).toBe('off');
  });

  it('treats explicit JSON null optional fields as absent, not "null"/0', () => {
    const v = parseVisionVerdict('{"accepted": false, "score": null, "notes": null, "refinedPrompt": null, "imageStrength": null}');
    expect(v.accepted).toBe(false);
    expect(v.score).toBeUndefined();
    expect(v.notes).toBeUndefined();
    expect(v.refinedPrompt).toBeUndefined();
    expect(v.imageStrength).toBeUndefined();
  });

  it('throws when there is no JSON object', () => {
    expect(() => parseVisionVerdict('the render looks fine to me')).toThrow();
  });

  it('throws when accepted is missing', () => {
    expect(() => parseVisionVerdict('{"score": 0.5}')).toThrow();
  });
});

describe('resolveVisionEvalTarget', () => {
  it('honors an explicit API-provider assignment', async () => {
    mocks.getSettings.mockResolvedValue({ creativeDirector: { evaluation: { providerId: 'lmstudio', model: 'llava' } } });
    mocks.getProviderById.mockResolvedValue({ id: 'lmstudio', type: 'api', enabled: true });
    const target = await resolveVisionEvalTarget();
    expect(target).toEqual({ provider: { id: 'lmstudio', type: 'api', enabled: true }, model: 'llava' });
    expect(mocks.listVisionModels).not.toHaveBeenCalled();
  });

  it('prefers the per-project override over the global evaluation assignment', async () => {
    mocks.getSettings.mockResolvedValue({ creativeDirector: { evaluation: { providerId: 'global-vlm', model: 'gm' } } });
    mocks.getProviderById.mockImplementation(async (id) => (id === 'proj-vlm' ? { id: 'proj-vlm', type: 'api', enabled: true } : null));
    const target = await resolveVisionEvalTarget({ modelOverrides: { evaluation: { providerId: 'proj-vlm', model: 'moondream' } } });
    expect(target).toEqual({ provider: { id: 'proj-vlm', type: 'api', enabled: true }, model: 'moondream' });
    expect(mocks.listVisionModels).not.toHaveBeenCalled();
  });

  it('falls through to auto when the pinned provider is not an API provider', async () => {
    mocks.getSettings.mockResolvedValue({ creativeDirector: { evaluation: { providerId: 'claude' } } });
    mocks.getProviderById.mockImplementation(async (id) => {
      if (id === 'claude') return { id: 'claude', type: 'cli', enabled: true };
      if (id === 'ollama') return OLLAMA;
      return null;
    });
    mocks.listVisionModels.mockResolvedValue([{ providerId: 'ollama', backend: 'ollama', id: 'qwen2.5-vl', vision: true }]);
    const target = await resolveVisionEvalTarget();
    expect(target).toEqual({ provider: OLLAMA, model: 'qwen2.5-vl' });
  });

  it('auto-picks the first local vision model, skipping CLI-backed entries', async () => {
    mocks.listVisionModels.mockResolvedValue([
      { providerId: 'claude-code', backend: 'cli', id: 'claude-opus-4-8', vision: true },
      { providerId: 'ollama', backend: 'ollama', id: 'llama3.2-vision', vision: true },
    ]);
    mocks.getProviderById.mockImplementation(async (id) => (id === 'ollama' ? OLLAMA : null));
    const target = await resolveVisionEvalTarget();
    expect(target).toEqual({ provider: OLLAMA, model: 'llama3.2-vision' });
  });

  it('skips a disabled/missing local provider and uses the next usable one', async () => {
    mocks.listVisionModels.mockResolvedValue([
      { providerId: 'ollama', backend: 'ollama', id: 'qwen2.5-vl', vision: true },
      { providerId: 'lmstudio', backend: 'lmstudio', id: 'llava', vision: true },
    ]);
    mocks.getProviderById.mockImplementation(async (id) => {
      if (id === 'ollama') return { id: 'ollama', type: 'api', enabled: false }; // disabled
      if (id === 'lmstudio') return { id: 'lmstudio', type: 'api', enabled: true };
      return null;
    });
    const target = await resolveVisionEvalTarget();
    expect(target).toEqual({ provider: { id: 'lmstudio', type: 'api', enabled: true }, model: 'llava' });
  });

  it('returns null when no vision-capable API provider exists', async () => {
    mocks.listVisionModels.mockResolvedValue([{ providerId: 'claude-code', backend: 'cli', id: 'opus', vision: true }]);
    const target = await resolveVisionEvalTarget();
    expect(target).toBeNull();
  });
});

describe('evaluateSceneWithVision', () => {
  const project = { id: 'p1', name: 'Demo', styleSpec: 'neon noir' };
  const scene = { sceneId: 's1', order: 0, intent: 'hero enters', renderedJobId: 'job-1', evaluationFrames: ['job-1-f1.jpg', 'job-1-f2.jpg'], retryCount: 0 };

  beforeEach(() => {
    mocks.listVisionModels.mockResolvedValue([{ providerId: 'ollama', backend: 'ollama', id: 'qwen2.5-vl', vision: true }]);
    mocks.getProviderById.mockImplementation(async (id) => (id === 'ollama' ? OLLAMA : null));
  });

  it('resolves a verdict from the vision model and reports the model that ran', async () => {
    mocks.runPromptThroughProvider.mockResolvedValue({
      text: '{"accepted": true, "score": 0.85, "notes": "on-style"}',
      model: 'qwen2.5-vl',
      provider: OLLAMA,
    });
    const res = await evaluateSceneWithVision(project, scene);
    expect(res.ok).toBe(true);
    expect(res.verdict.accepted).toBe(true);
    expect(res.llm).toEqual({ provider: 'ollama', model: 'qwen2.5-vl' });
    // Frames passed as absolute paths under the thumbnails dir.
    const call = mocks.runPromptThroughProvider.mock.calls[0][0];
    expect(call.screenshots).toEqual(['/data/video-thumbnails/job-1-f1.jpg', '/data/video-thumbnails/job-1-f2.jpg']);
    expect(call.source).toBe('cd-scene-evaluate');
  });

  it('falls back to the agent when no vision provider is configured', async () => {
    mocks.listVisionModels.mockResolvedValue([]);
    const res = await evaluateSceneWithVision(project, scene);
    expect(res).toMatchObject({ ok: false, fallbackToAgent: true });
    expect(mocks.runPromptThroughProvider).not.toHaveBeenCalled();
  });

  it('falls back to the agent when no frames exist on disk', async () => {
    mocks.existsSync.mockReturnValue(false);
    const res = await evaluateSceneWithVision(project, scene);
    expect(res).toMatchObject({ ok: false, fallbackToAgent: true });
    expect(mocks.runPromptThroughProvider).not.toHaveBeenCalled();
  });

  it('uses the single-thumbnail fallback when no sampled frames are present', async () => {
    mocks.runPromptThroughProvider.mockResolvedValue({ text: '{"accepted": true}', model: 'qwen2.5-vl', provider: OLLAMA });
    await evaluateSceneWithVision(project, { ...scene, evaluationFrames: [] });
    const call = mocks.runPromptThroughProvider.mock.calls[0][0];
    expect(call.screenshots).toEqual(['/data/video-thumbnails/job-1.jpg']);
  });
});

describe('applySceneVerdict', () => {
  const project = { id: 'p1', name: 'Demo', collectionId: 'col-1' };
  const scene = { sceneId: 's1', order: 0, renderedJobId: 'job-1', retryCount: 0 };
  const llm = { provider: 'ollama', model: 'qwen2.5-vl' };

  it('accept → marks accepted, adds video to the collection, and advances', async () => {
    await applySceneVerdict(project, scene, { accepted: true, score: 0.9, notes: 'good' }, llm);
    expect(mocks.updateScene).toHaveBeenCalledWith('p1', 's1', expect.objectContaining({ status: 'accepted' }));
    expect(mocks.addItem).toHaveBeenCalledWith('col-1', { kind: 'video', ref: 'job-1' });
    expect(mocks.advanceAfterSceneSettled).toHaveBeenCalledWith('p1');
  });

  it('accept → an already-in-collection error is swallowed (idempotent)', async () => {
    mocks.addItem.mockRejectedValue(new Error('Item already in collection: video:job-1'));
    await expect(applySceneVerdict(project, scene, { accepted: true }, llm)).resolves.not.toThrow();
    expect(mocks.advanceAfterSceneSettled).toHaveBeenCalledWith('p1');
  });

  it('miss with retries left → pending + refined prompt + bumped retryCount, no collection add', async () => {
    await applySceneVerdict(project, { ...scene, retryCount: 1 }, { accepted: false, notes: 'fix', refinedPrompt: 'more fog', imageStrength: 0.6 }, llm);
    expect(mocks.updateScene).toHaveBeenCalledWith('p1', 's1', expect.objectContaining({
      status: 'pending',
      retryCount: 2,
      prompt: 'more fog',
      imageStrength: 0.6,
    }));
    expect(mocks.addItem).not.toHaveBeenCalled();
    expect(mocks.advanceAfterSceneSettled).toHaveBeenCalledWith('p1');
  });

  it('miss with retries exhausted → failed', async () => {
    await applySceneVerdict(project, { ...scene, retryCount: 3 }, { accepted: false, notes: 'still bad' }, llm);
    expect(mocks.updateScene).toHaveBeenCalledWith('p1', 's1', expect.objectContaining({ status: 'failed' }));
    expect(mocks.advanceAfterSceneSettled).toHaveBeenCalledWith('p1');
  });

  it('skips the collection add when the project has no collectionId', async () => {
    await applySceneVerdict({ id: 'p1' }, scene, { accepted: true }, llm);
    expect(mocks.addItem).not.toHaveBeenCalled();
  });
});

describe('dispatchSceneEvaluation', () => {
  const project = { id: 'p1', name: 'Demo', collectionId: 'col-1' };
  const scene = { sceneId: 's1', order: 0, renderedJobId: 'job-1', evaluationFrames: ['job-1-f1.jpg'], retryCount: 0 };

  it('applies the verdict via the vision path when a provider resolves', async () => {
    mocks.listVisionModels.mockResolvedValue([{ providerId: 'ollama', backend: 'ollama', id: 'qwen2.5-vl', vision: true }]);
    mocks.getProviderById.mockImplementation(async (id) => (id === 'ollama' ? OLLAMA : null));
    mocks.runPromptThroughProvider.mockResolvedValue({ text: '{"accepted": true, "score": 0.9}', model: 'qwen2.5-vl', provider: OLLAMA });
    const res = await dispatchSceneEvaluation(project, scene);
    expect(res.via).toBe('vision');
    expect(mocks.updateScene).toHaveBeenCalledWith('p1', 's1', expect.objectContaining({ status: 'accepted' }));
    expect(mocks.enqueueEvaluateTask).not.toHaveBeenCalled();
  });

  it('opens a running evaluate run before the vision call and closes it after (blocks double-dispatch)', async () => {
    mocks.listVisionModels.mockResolvedValue([{ providerId: 'ollama', backend: 'ollama', id: 'qwen2.5-vl', vision: true }]);
    mocks.getProviderById.mockImplementation(async (id) => (id === 'ollama' ? OLLAMA : null));
    mocks.runPromptThroughProvider.mockResolvedValue({ text: '{"accepted": true}', model: 'qwen2.5-vl', provider: OLLAMA });
    await dispatchSceneEvaluation(project, scene);
    // A running run is recorded up-front so completionHook's noLiveEvaluateRun sees it.
    const running = mocks.recordRun.mock.calls.find((c) => c[1]?.status === 'running');
    expect(running).toBeTruthy();
    expect(running[1]).toMatchObject({ kind: 'evaluate', sceneId: 's1', status: 'running', runId: expect.any(String) });
    // …then closed to completed via updateRun with the SAME runId.
    expect(mocks.updateRun).toHaveBeenCalledWith('p1', running[1].runId, expect.objectContaining({ status: 'completed' }));
  });

  it('does NOT overwrite an accepted scene with failed when downstream advance throws', async () => {
    mocks.listVisionModels.mockResolvedValue([{ providerId: 'ollama', backend: 'ollama', id: 'qwen2.5-vl', vision: true }]);
    mocks.getProviderById.mockImplementation(async (id) => (id === 'ollama' ? OLLAMA : null));
    mocks.runPromptThroughProvider.mockResolvedValue({ text: '{"accepted": true}', model: 'qwen2.5-vl', provider: OLLAMA });
    // The next-scene/stitch step fails (e.g. ffmpeg) — must not corrupt the settled scene.
    mocks.advanceAfterSceneSettled.mockRejectedValue(new Error('ffmpeg stitch failed'));
    await expect(dispatchSceneEvaluation(project, scene)).resolves.not.toThrow();
    expect(mocks.updateScene).toHaveBeenCalledWith('p1', 's1', expect.objectContaining({ status: 'accepted' }));
    // The dispatch catch must NOT have fired to mark the scene failed.
    const failedCall = mocks.updateScene.mock.calls.find((c) => c[2]?.status === 'failed');
    expect(failedCall).toBeUndefined();
  });

  it('marks the running run failed when the vision call throws, then falls back to the agent', async () => {
    mocks.listVisionModels.mockResolvedValue([{ providerId: 'ollama', backend: 'ollama', id: 'qwen2.5-vl', vision: true }]);
    mocks.getProviderById.mockImplementation(async (id) => (id === 'ollama' ? OLLAMA : null));
    mocks.runPromptThroughProvider.mockRejectedValue(new Error('connection refused'));
    await dispatchSceneEvaluation(project, scene);
    const running = mocks.recordRun.mock.calls.find((c) => c[1]?.status === 'running');
    expect(mocks.updateRun).toHaveBeenCalledWith('p1', running[1].runId, expect.objectContaining({ status: 'failed' }));
    expect(mocks.enqueueEvaluateTask).toHaveBeenCalledWith(project, scene);
  });

  it('skips a concurrent duplicate dispatch for the same scene while one is in flight', async () => {
    mocks.listVisionModels.mockResolvedValue([{ providerId: 'ollama', backend: 'ollama', id: 'qwen2.5-vl', vision: true }]);
    mocks.getProviderById.mockImplementation(async (id) => (id === 'ollama' ? OLLAMA : null));
    // Hold the vision call open so the first dispatch keeps its lock.
    let release;
    const pending = new Promise((res) => { release = res; });
    mocks.runPromptThroughProvider.mockReturnValue(pending);

    const first = dispatchSceneEvaluation(project, scene); // acquires the lock synchronously
    const second = await dispatchSceneEvaluation(project, scene); // same scene → skipped
    expect(second).toBeNull();

    release({ text: '{"accepted": true}', model: 'qwen2.5-vl', provider: OLLAMA });
    await first;
    // Exactly one evaluation ran despite two dispatches.
    expect(mocks.runPromptThroughProvider).toHaveBeenCalledTimes(1);
  });

  it('falls back to the agent when the vision path is unavailable', async () => {
    mocks.listVisionModels.mockResolvedValue([]);
    await dispatchSceneEvaluation(project, scene);
    expect(mocks.enqueueEvaluateTask).toHaveBeenCalledWith(project, scene);
    expect(mocks.updateScene).not.toHaveBeenCalled();
  });

  it('falls back to the agent when the vision call throws', async () => {
    mocks.listVisionModels.mockResolvedValue([{ providerId: 'ollama', backend: 'ollama', id: 'qwen2.5-vl', vision: true }]);
    mocks.getProviderById.mockImplementation(async (id) => (id === 'ollama' ? OLLAMA : null));
    mocks.runPromptThroughProvider.mockRejectedValue(new Error('connection refused'));
    await dispatchSceneEvaluation(project, scene);
    expect(mocks.enqueueEvaluateTask).toHaveBeenCalledWith(project, scene);
  });

  it('never throws even when the agent-fallback enqueue itself rejects', async () => {
    mocks.listVisionModels.mockResolvedValue([]); // no vision provider → agent fallback
    mocks.enqueueEvaluateTask.mockRejectedValue(new Error('disk full'));
    await expect(dispatchSceneEvaluation(project, scene)).resolves.not.toThrow();
  });
});
