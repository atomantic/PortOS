import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock only what the media tools reach for. The queue is the observable
// boundary — every assertion here is about the params that land on it, because
// `job.params.mode` is the ONLY thing mediaJobQueue routes the backend on.
vi.mock('../../mediaJobQueue/index.js', () => ({ enqueueJob: vi.fn(() => ({ jobId: 'mj-test' })) }));
const getSettings = vi.fn(async () => ({}));
vi.mock('../../settings.js', () => ({
  getSettings: (...args) => getSettings(...args),
  // getSettings() hands back {} for a corrupt settings.json rather than
  // rejecting, so the router reads through this failure-aware wrapper instead.
  // Deriving it from the same mock keeps every existing setup working and makes
  // a mockRejectedValue model a corrupt read, which is what those tests mean.
  getSettingsWithStatus: async (...args) => {
    try {
      return { corrupt: false, settings: await getSettings(...args) };
    } catch {
      return { corrupt: true, settings: null };
    }
  },
}));
vi.mock('../../creativeDirector/local.js', () => ({ getProject: vi.fn(async () => null) }));
const getCommissionMusicContextForProject = vi.fn(async () => null);
vi.mock('../../creativeCommissions/store.js', () => ({
  getCommissionMusicContextForProject: (...args) => getCommissionMusicContextForProject(...args),
}));
const prepareRemoteMediaJob = vi.fn();
vi.mock('../../federatedMedia/remoteSubmission.js', () => ({
  prepareRemoteMediaJob: (...args) => prepareRemoteMediaJob(...args),
}));

import { enqueueJob } from '../../mediaJobQueue/index.js';
import { getProject } from '../../creativeDirector/local.js';
import { MEDIA_TOOLS, reconcileVideoParamsWithModel } from './media.js';

const tool = (name) => MEDIA_TOOLS.find((t) => t.name === name);
const run = (name, params, ctx = {}) => tool(name).execute({ params }, ctx);
const enqueued = () => enqueueJob.mock.calls.at(-1)[0];

// A project with no locked geometry preset, so enforceVideoRenderPreset is a
// no-op and each test isolates the render-backend pin.
const projectWithPin = (renderBackend) => ({ id: 'cd-1', renderBackend });

beforeEach(() => {
  vi.clearAllMocks();
  getSettings.mockResolvedValue({});
  getProject.mockResolvedValue(null);
  getCommissionMusicContextForProject.mockResolvedValue(null);
});

describe('model-aware autonomous video controls', () => {
  it('uses the same H3 options as Video Gen and drops controls its UI disables', () => {
    const params = reconcileVideoParamsWithModel({
      prompt: 'an example shot',
      negativePrompt: 'blur',
      disableAudio: true,
      tiling: 'spatial',
    }, {
      aspectRatio: '16:9', quality: 'standard', targetDurationSeconds: 10,
      modelId: 'minimax-h3-example',
    }, [{
      id: 'minimax-h3-example',
      resolutionOptions: [{ w: 1344, h: 768 }, { w: 768, h: 1344 }],
      fpsOptions: [24],
      frameOptions: [226, 243],
      samplerLocked: true,
      supportsNegativePrompt: false,
      supportsDisableAudio: false,
      supportsTiling: false,
    }]);

    expect(params).toMatchObject({
      prompt: 'an example shot', modelId: 'minimax-h3-example',
      width: 1344, height: 768, fps: 24, numFrames: 243,
    });
    expect(params).not.toHaveProperty('negativePrompt');
    expect(params).not.toHaveProperty('disableAudio');
    expect(params).not.toHaveProperty('tiling');
    expect(params).not.toHaveProperty('steps');
    expect(params).not.toHaveProperty('guidanceScale');
  });
});

describe('render-backend pin — the auto/unpinned path is a strict no-op (#3135)', () => {
  // Note (#3231): the image lane now reads settings even without a project pin
  // — the install-wide creative-agent renderDefaults pin is a second pin
  // source — so the old "no settings read at all" assertion is gone. The
  // load-bearing contract is unchanged: with NO pin from either source, the
  // enqueued params are byte-identical to the caller's.
  it('leaves image params untouched with no owning project and no renderDefaults pin', async () => {
    await run('media_enqueueImageJob', { prompt: 'a lighthouse' });
    expect(enqueued().params).toEqual({ prompt: 'a lighthouse' });
  });

  it('leaves image params untouched when the project has no pin', async () => {
    getProject.mockResolvedValue(projectWithPin(null));
    await run('media_enqueueImageJob', { prompt: 'p' }, { projectId: 'cd-1' });
    expect(enqueued().params).toEqual({ prompt: 'p' });
  });

  it('applies the creative-agent renderDefaults pin when the project has none (#3231)', async () => {
    getSettings.mockResolvedValue({
      imageGen: { codex: { enabled: true, codexPath: '/bin/codex', model: 'example-model', effort: 'low' } },
      renderDefaults: { 'creative-agent': { imageMode: 'codex' } },
    });
    await run('media_enqueueImageJob', { prompt: 'p' });
    expect(enqueued().params).toEqual(expect.objectContaining({ mode: 'codex', model: 'example-model' }));
  });

  it('a disabled creative-agent renderDefaults pin still leaves params flowing (degrades, never fails)', async () => {
    getSettings.mockResolvedValue({
      renderDefaults: { 'creative-agent': { imageMode: 'codex' } },
    });
    await run('media_enqueueImageJob', { prompt: 'p' });
    // Codex pin present but disabled → the usability ladder degrades to local.
    expect(enqueued().params).toEqual(expect.objectContaining({ mode: 'local', prompt: 'p' }));
  });

  it('leaves video params untouched when the project has no pin', async () => {
    getProject.mockResolvedValue(projectWithPin(null));
    await run('media_enqueueVideoJob', { prompt: 'p', mode: 'image' }, { projectId: 'cd-1' });
    // The local lane's `mode` is the t2v/i2v SEMANTIC — it must survive untouched.
    expect(enqueued().params).toEqual({ prompt: 'p', mode: 'image' });
  });

  it('applies the creative-agent renderDefaults VIDEO pin when the project has none (#3231 Phase 4)', async () => {
    getSettings.mockResolvedValue({
      imageGen: { grok: { enabled: true, grokPath: '/bin/grok' } },
      renderDefaults: { 'creative-agent': { videoMode: 'grok' } },
    });
    await run('media_enqueueVideoJob', { prompt: 'p' });
    expect(enqueued().params).toEqual(expect.objectContaining({ mode: 'grok', videoMode: 'text', grokPath: '/bin/grok' }));
  });

  it('applies the install-wide settings.videoGen.mode pin when nothing else pins (#3231 Phase 4)', async () => {
    getSettings.mockResolvedValue({
      imageGen: { grok: { enabled: true, grokPath: '/bin/grok' } },
      videoGen: { mode: 'grok' },
    });
    await run('media_enqueueVideoJob', { prompt: 'p' });
    expect(enqueued().params).toEqual(expect.objectContaining({ mode: 'grok' }));
  });

  it('the project video pin outranks the target video pin', async () => {
    getSettings.mockResolvedValue({
      imageGen: { grok: { enabled: true, grokPath: '/bin/grok' } },
      renderDefaults: { 'creative-agent': { videoMode: 'grok' } },
    });
    getProject.mockResolvedValue(projectWithPin({ video: { mode: 'local' } }));
    await run('media_enqueueVideoJob', { prompt: 'p', mode: 'image' }, { projectId: 'cd-1' });
    expect(enqueued().params.mode).toBe('image'); // local pin → semantic survives, no grok discriminator
  });

  it('a disabled grok video pin degrades to local (never fails the commission)', async () => {
    getSettings.mockResolvedValue({
      renderDefaults: { 'creative-agent': { videoMode: 'grok' } },
    });
    await run('media_enqueueVideoJob', { prompt: 'p', mode: 'image' });
    expect(enqueued().params).toEqual(expect.objectContaining({ mode: 'image', prompt: 'p' }));
  });

  it('the target videoModel rides a local resolution when the project pins no model', async () => {
    getSettings.mockResolvedValue({
      renderDefaults: { 'creative-agent': { videoMode: 'local', videoModel: 'target-video-model' } },
    });
    await run('media_enqueueVideoJob', { prompt: 'p', mode: 'image' });
    expect(enqueued().params.modelId).toBe('target-video-model');
  });

  it('reads the owning project exactly once per enqueue', async () => {
    getProject.mockResolvedValue(projectWithPin({ image: { mode: 'local' } }));
    await run('media_enqueueVideoJob', { prompt: 'p' }, { projectId: 'cd-1' });
    expect(getProject).toHaveBeenCalledTimes(1);
  });
});

describe('render-backend pin — image (#3135)', () => {
  it('locks an image commission to the form aspect and quality presets', async () => {
    getProject.mockResolvedValue({
      id: 'cd-1', aspectRatio: '9:16', quality: 'high',
      directive: { constraints: { targetAbility: 'image' } },
    });
    await run('media_enqueueImageJob', {
      prompt: 'p', width: 1024, height: 1024, steps: 4, cfgScale: 12,
    }, { projectId: 'cd-1' });
    expect(enqueued().params).toMatchObject({
      prompt: 'p', width: 432, height: 768, steps: 30, guidance: 3.5, cfgScale: 3.5,
    });
  });

  it('forces a codex pin onto the job params, overriding the planner LLM', async () => {
    getSettings.mockResolvedValue({ imageGen: { codex: { enabled: true, codexPath: '/bin/codex', model: 'example-model', effort: 'low' } } });
    getProject.mockResolvedValue(projectWithPin({ image: { mode: 'codex' } }));
    // The planner authored `mode: 'local'`; the pin must win.
    await run('media_enqueueImageJob', { prompt: 'p', mode: 'local' }, { projectId: 'cd-1' });
    expect(enqueued().params.mode).toBe('codex');
    expect(enqueued().params.codexPath).toBe('/bin/codex');
    // Creative params the planner owns are preserved.
    expect(enqueued().params.prompt).toBe('p');
  });

  it('forces a grok pin with the provider knob bundle the queue needs', async () => {
    getSettings.mockResolvedValue({ imageGen: { grok: { enabled: true, grokPath: '/bin/grok', aspectRatio: '16:9' } } });
    getProject.mockResolvedValue(projectWithPin({ image: { mode: 'grok' } }));
    await run('media_enqueueImageJob', { prompt: 'p' }, { projectId: 'cd-1' });
    expect(enqueued().params.mode).toBe('grok');
    expect(enqueued().params.grokPath).toBe('/bin/grok');
  });

  it('degrades a pin whose backend the user has since DISABLED', async () => {
    // Grok pinned but the toggle is off — a nightly commission must still render
    // something rather than failing every fire because a setting moved.
    getSettings.mockResolvedValue({ imageGen: { grok: { enabled: false }, local: { pythonPath: '/py' } } });
    getProject.mockResolvedValue(projectWithPin({ image: { mode: 'grok' } }));
    await run('media_enqueueImageJob', { prompt: 'p' }, { projectId: 'cd-1' });
    expect(enqueued().params.mode).toBe('local');
    expect(enqueued().params.pythonPath).toBe('/py');
  });

  it('the pinned local model beats a planner-authored one', async () => {
    getSettings.mockResolvedValue({ imageGen: { local: { pythonPath: '/py' } } });
    getProject.mockResolvedValue(projectWithPin({ image: { mode: 'local', modelId: 'pinned-model' } }));

    await run('media_enqueueImageJob', { prompt: 'p' }, { projectId: 'cd-1' });
    expect(enqueued().params.modelId).toBe('pinned-model');

    // The asymmetry IS the pin: a user who named a model must get that model,
    // not whatever the planner guessed.
    await run('media_enqueueImageJob', { prompt: 'p', modelId: 'planner-model' }, { projectId: 'cd-1' });
    expect(enqueued().params.modelId).toBe('pinned-model');
  });

  it('leaves the planner model alone when the pin names none', async () => {
    getSettings.mockResolvedValue({ imageGen: { local: { pythonPath: '/py' } } });
    getProject.mockResolvedValue(projectWithPin({ image: { mode: 'local' } }));
    await run('media_enqueueImageJob', { prompt: 'p', modelId: 'planner-model' }, { projectId: 'cd-1' });
    expect(enqueued().params.modelId).toBe('planner-model');
  });

  // The backend PIN still falls through untouched on an unreadable read — but
  // since #4348 the enqueue itself now fails instead of completing. An
  // unreadable settings file cannot tell us whether a federated route is
  // configured, and treating that as "no route" would silently render on local
  // GPU work the user deliberately sent to another machine. Failing loudly is
  // the project's sentinel rule (never collapse failed-to-fetch into
  // legitimately-empty) applied to a spend-bearing decision.
  it('fails the enqueue rather than guessing at routing when settings are unreadable', async () => {
    getSettings.mockRejectedValue(new Error('settings unavailable'));
    getProject.mockResolvedValue(projectWithPin({ image: { mode: 'grok' } }));
    await expect(run('media_enqueueImageJob', { prompt: 'p' }, { projectId: 'cd-1' }))
      .rejects.toMatchObject({ code: 'MEDIA_ROUTING_UNREADABLE' });
    expect(enqueueJob).not.toHaveBeenCalled();
  });
});

describe('render-backend pin — video (#3135)', () => {
  it('locks a video commission to the form duration instead of a planner beat', async () => {
    getProject.mockResolvedValue({
      id: 'cd-1', aspectRatio: '16:9', quality: 'standard', targetDurationSeconds: 10,
      directive: { constraints: { targetAbility: 'video' } },
    });
    await run('media_enqueueVideoJob', { prompt: 'p', durationSeconds: 5 }, { projectId: 'cd-1' });
    expect(enqueued().params.durationSeconds).toBe(10);
  });

  it('forces a grok pin with the grok discriminator + the semantic in videoMode', async () => {
    getSettings.mockResolvedValue({ imageGen: { grok: { enabled: true, grokPath: '/bin/grok', aspectRatio: '9:16' } } });
    getProject.mockResolvedValue(projectWithPin({ video: { mode: 'grok' } }));
    await run('media_enqueueVideoJob', { prompt: 'p' }, { projectId: 'cd-1' });
    expect(enqueued().params.mode).toBe('grok');
    // Text-to-video (no source frame) — the semantic never collides with the
    // 'grok' discriminator, which is why they can share the `mode` namespace.
    expect(enqueued().params.videoMode).toBe('text');
    expect(enqueued().params.grokPath).toBe('/bin/grok');
    expect(enqueued().params.aspectRatio).toBe('9:16');
  });

  it('marks a grok video with a source frame as image-to-video', async () => {
    getSettings.mockResolvedValue({ imageGen: { grok: { enabled: true, grokPath: '/bin/grok' } } });
    getProject.mockResolvedValue(projectWithPin({ video: { mode: 'grok' } }));
    await run('media_enqueueVideoJob', { prompt: 'p', sourceImagePath: '/tmp/frame.png' }, { projectId: 'cd-1' });
    expect(enqueued().params.videoMode).toBe('image');
  });

  it('a local video pin carries only the model id — never a backend name in `mode`', async () => {
    getSettings.mockResolvedValue({ imageGen: {} });
    getProject.mockResolvedValue(projectWithPin({ video: { mode: 'local', modelId: 'pinned-video-model' } }));
    await run('media_enqueueVideoJob', { prompt: 'p', mode: 'fflf' }, { projectId: 'cd-1' });
    // Stamping `mode: 'local'` here would destroy the t2v/i2v semantic and make
    // the runner render text-only, silently dropping the caller's keyframes.
    expect(enqueued().params.mode).toBe('fflf');
    expect(enqueued().params.modelId).toBe('pinned-video-model');
  });

  it('STRIPS a planner-authored BACKEND token from `mode` when the pin says local', async () => {
    // The discriminator and the t2v/i2v semantic share `params.mode`. A leftover
    // 'grok' would dispatch to grok in defiance of the pin; a leftover 'local' is
    // worse than useless — local.js reads an unrecognized non-empty mode as plain
    // text-to-video and would silently ignore the step's sourceImagePath. Dropping
    // the key lets local.js INFER the semantic, which is what an unset mode means.
    getSettings.mockResolvedValue({ imageGen: {} });
    getProject.mockResolvedValue(projectWithPin({ video: { mode: 'local' } }));

    for (const backendToken of ['grok', 'local']) {
      await run('media_enqueueVideoJob', { prompt: 'p', mode: backendToken, sourceImagePath: '/tmp/f.png' }, { projectId: 'cd-1' });
      expect(enqueued().params).toEqual({ prompt: 'p', sourceImagePath: '/tmp/f.png' });
    }
  });

  it('degrades a grok video pin to local when the grok toggle is off — and strips the discriminator', async () => {
    getSettings.mockResolvedValue({ imageGen: { grok: { enabled: false } } });
    getProject.mockResolvedValue(projectWithPin({ video: { mode: 'grok' } }));
    await run('media_enqueueVideoJob', { prompt: 'p' }, { projectId: 'cd-1' });
    expect(enqueued().params).toEqual({ prompt: 'p' });

    // The fallback must also survive a planner that already wrote 'grok', or the
    // disabled-backend degrade would be silently defeated.
    await run('media_enqueueVideoJob', { prompt: 'p', mode: 'grok' }, { projectId: 'cd-1' });
    expect(enqueued().params).toEqual({ prompt: 'p' });
  });

  it('the pinned local video model beats a planner-authored one', async () => {
    getSettings.mockResolvedValue({ imageGen: {} });
    getProject.mockResolvedValue(projectWithPin({ video: { mode: 'local', modelId: 'pinned-video-model' } }));
    await run('media_enqueueVideoJob', { prompt: 'p', modelId: 'planner-model' }, { projectId: 'cd-1' });
    expect(enqueued().params.modelId).toBe('pinned-video-model');
  });

  it('applies a model-only pin that names no backend', async () => {
    // The scene path reads the model pin unconditionally, so dropping it here
    // (via the no-pin early return) would make the two surfaces render the
    // same commission with different models.
    getSettings.mockResolvedValue({ imageGen: {} });
    getProject.mockResolvedValue(projectWithPin({ video: { modelId: 'pinned-video-model' } }));
    await run('media_enqueueVideoJob', { prompt: 'p' }, { projectId: 'cd-1' });
    expect(enqueued().params).toEqual({ prompt: 'p', modelId: 'pinned-video-model' });
  });

  it('still passes params through untouched when nothing at all is pinned', async () => {
    // The byte-identical contract: broadening `pinned` to cover a model-only
    // pin must not start perturbing jobs for an unconfigured install.
    getSettings.mockResolvedValue({ imageGen: {} });
    getProject.mockResolvedValue({ id: 'cd-1' });
    await run('media_enqueueVideoJob', { prompt: 'p', durationSeconds: 8 }, { projectId: 'cd-1' });
    expect(enqueued().params).toEqual({ prompt: 'p', durationSeconds: 8 });
  });

  describe('grok clip length crosses a contract boundary', () => {
    // The local lane derives frames from `durationSeconds`; grok's worker reads
    // `duration` and silently falls back to 6s for anything absent. Without the
    // translation a 10s commission would quietly render a 6s clip.
    beforeEach(() => {
      getSettings.mockResolvedValue({ imageGen: { grok: { enabled: true, grokPath: '/bin/grok' } } });
    });

    it('translates the step durationSeconds, rounding up to a deliverable clip', async () => {
      getProject.mockResolvedValue(projectWithPin({ video: { mode: 'grok' } }));
      await run('media_enqueueVideoJob', { prompt: 'p', durationSeconds: 8 }, { projectId: 'cd-1' });
      // 8s isn't deliverable; rounding DOWN to 6 would truncate the beat, and a
      // longer clip costs nothing extra.
      expect(enqueued().params.duration).toBe(10);
    });

    it("falls back to the project's target duration when the step names none", async () => {
      getProject.mockResolvedValue({ id: 'cd-1', targetDurationSeconds: 10, renderBackend: { video: { mode: 'grok' } } });
      await run('media_enqueueVideoJob', { prompt: 'p' }, { projectId: 'cd-1' });
      expect(enqueued().params.duration).toBe(10);
    });

    it('prefers an explicit grok-shaped duration a caller already set', async () => {
      getProject.mockResolvedValue({ id: 'cd-1', targetDurationSeconds: 10, renderBackend: { video: { mode: 'grok' } } });
      await run('media_enqueueVideoJob', { prompt: 'p', duration: 6, durationSeconds: 10 }, { projectId: 'cd-1' });
      expect(enqueued().params.duration).toBe(6);
    });

    it('defaults to the shortest clip when nothing names a length', async () => {
      getProject.mockResolvedValue(projectWithPin({ video: { mode: 'grok' } }));
      await run('media_enqueueVideoJob', { prompt: 'p' }, { projectId: 'cd-1' });
      expect(enqueued().params.duration).toBe(6);
    });
  });

  it('applies the video pin alongside the locked geometry preset', async () => {
    getSettings.mockResolvedValue({ imageGen: { grok: { enabled: true, grokPath: '/bin/grok' } } });
    getProject.mockResolvedValue({
      id: 'cd-1', aspectRatio: '9:16', quality: 'high', targetDurationSeconds: 10,
      renderBackend: { video: { mode: 'grok' } },
    });
    await run('media_enqueueVideoJob', { prompt: 'p', aspectRatio: '16:9' }, { projectId: 'cd-1' });
    // Both forcing steps applied: geometry from the preset, backend from the pin.
    expect(enqueued().params.width).toBe(432);
    expect(enqueued().params.height).toBe(768);
    expect(enqueued().params.mode).toBe('grok');
  });

  it('an image-only pin does not touch a video enqueue (and vice versa)', async () => {
    getSettings.mockResolvedValue({ imageGen: { grok: { enabled: true, grokPath: '/bin/grok' } } });
    getProject.mockResolvedValue(projectWithPin({ image: { mode: 'grok' } }));
    await run('media_enqueueVideoJob', { prompt: 'p' }, { projectId: 'cd-1' });
    expect(enqueued().params).toEqual({ prompt: 'p' });
  });
});

describe('audio enqueues', () => {
  it('tags a general project music bed without reading settings', async () => {
    await run('media_enqueueAudioJob', { prompt: 'a mournful synth score' }, { projectId: 'cd-1' });
    expect(enqueued().params.creativeDirectorMusicBed).toEqual({ projectId: 'cd-1' });
    expect(getProject).toHaveBeenCalledTimes(1);
    expect(getSettings).not.toHaveBeenCalled();
  });

  it('locks a non-taste music commission to its form duration and install renderer', async () => {
    getProject.mockResolvedValue({
      id: 'cd-1', targetDurationSeconds: 75,
      directive: { constraints: { targetAbility: 'music', generation: { lengthSeconds: 75 } } },
    });
    await run('media_enqueueAudioJob', {
      prompt: 'a mournful synth score', engine: 'planner-engine', modelId: 'planner-model', durationSec: 5,
    }, { projectId: 'cd-1' });
    expect(enqueued().params).toEqual({
      prompt: 'a mournful synth score', durationSec: 75,
      creativeDirectorMusicBed: { projectId: 'cd-1' },
    });
  });

  it('authoritatively applies a taste commission recipe and configured renderer', async () => {
    getCommissionMusicContextForProject.mockResolvedValue({
      commissionId: 'commission-example',
      runId: 'run-example',
      prompt: 'Bounded taste directive with original-work constraints',
      tasteRecipe: { version: 1, sourceHash: 'example-hash' },
      musicGeneration: { engine: 'acestep', modelId: 'example-model', repo: 'example/model', durationSec: 45 },
    });
    await run('media_enqueueAudioJob', {
      prompt: 'planner guess', engine: 'musicgen', modelId: 'wrong', durationSec: 5, durationMode: 'auto',
    }, { projectId: 'cd-1' });
    expect(enqueued().params).toEqual({
      prompt: 'Bounded taste directive with original-work constraints',
      engine: 'acestep', modelId: 'example-model', repo: 'example/model', durationSec: 45,
      creativeDirectorMusicBed: { projectId: 'cd-1' },
      provenance: {
        kind: 'creative-commission-music-taste', commissionId: 'commission-example', runId: 'run-example',
        recipeVersion: 1, sourceHash: 'example-hash',
      },
    });
  });

  it('fails closed when local taste provenance cannot be resolved', async () => {
    getCommissionMusicContextForProject.mockRejectedValueOnce(new Error('commission store unavailable'));
    await expect(run('media_enqueueAudioJob', {
      prompt: 'planner guess', engine: 'musicgen', modelId: 'planner-model', durationSec: 5,
    }, { projectId: 'cd-1' })).rejects.toThrow('commission store unavailable');
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('fails closed when a taste run lost its bounded authoritative prompt', async () => {
    getCommissionMusicContextForProject.mockResolvedValueOnce({
      commissionId: 'commission-example', runId: 'run-example', prompt: null,
      tasteRecipe: { version: 1, sourceHash: 'example-hash' },
      musicGeneration: { engine: 'acestep', modelId: 'example-model', durationSec: 45 },
    });
    await expect(run('media_enqueueAudioJob', { prompt: 'planner guess' }, { projectId: 'cd-1' }))
      .rejects.toThrow('taste-commission-prompt-unavailable');
    expect(enqueueJob).not.toHaveBeenCalled();
  });
});

// #4348 — unattended jobs route to a peer only because THIS instance's settings
// say so. The planner never names a peer, so these assertions are all about
// what reaches the queue when `federation.mediaRouting` is (and is not) set.
describe('federated default provider routing (#4348)', () => {
  const route = { peerId: 'peer-1', engine: 'comfy', modelId: 'sdxl-remote' };
  const routedSettings = (mediaRouting) => ({ federation: { mediaRouting } });

  beforeEach(() => {
    prepareRemoteMediaJob.mockReset();
    prepareRemoteMediaJob.mockImplementation(async ({ peerId, kind, request }) => ({
      peer: { id: peerId, name: 'Render Box', host: 'render-box.tailnet-example.ts.net' },
      remoteMedia: { wireVersion: 1, peerId, reconcile: false, cancelRequested: false, request },
    }));
  });

  it('renders locally, with its prompt intact, when no route is configured', async () => {
    getSettings.mockResolvedValue({});
    await run('media_enqueueImageJob', { prompt: 'a lighthouse' }, { projectId: 'cd-1' });
    expect(prepareRemoteMediaJob).not.toHaveBeenCalled();
    expect(enqueued().params.prompt).toBe('a lighthouse');
    expect(enqueued().params).not.toHaveProperty('remoteMedia');
  });

  it('routes an image job to the configured peer without the planner naming one', async () => {
    getSettings.mockResolvedValue(routedSettings({ image: route }));
    await run('media_enqueueImageJob', { prompt: 'a lighthouse', modelId: 'local-sdxl' }, { projectId: 'cd-1' });
    expect(prepareRemoteMediaJob).toHaveBeenCalledWith(expect.objectContaining({ peerId: 'peer-1', kind: 'image' }));
    const { params } = enqueued();
    // The prompt rides ONLY inside the versioned marker, so a build that cannot
    // read `remoteMedia` fails closed instead of re-rendering on local hardware.
    expect(params.prompt).toBe('');
    expect(params.remoteMedia.request.prompt).toBe('a lighthouse');
    // The route's model wins: a peer advertises its own ids, not the planner's.
    expect(params.modelId).toBe('sdxl-remote');
  });

  it('keeps the owner tag so a routed render stays attributable to its project', async () => {
    getSettings.mockResolvedValue(routedSettings({ image: route }));
    await run('media_enqueueImageJob', { prompt: 'a lighthouse' }, { projectId: 'cd-1' });
    expect(enqueued().owner).toBe('creative-director:cd-1');
  });

  it('routes a video job independently of the image route', async () => {
    getSettings.mockResolvedValue(routedSettings({ video: { ...route, modelId: 'wan-remote' } }));
    await run('media_enqueueVideoJob', { prompt: 'a drifting balloon' }, { projectId: 'cd-1' });
    expect(prepareRemoteMediaJob).toHaveBeenCalledWith(expect.objectContaining({ kind: 'video' }));
    expect(enqueued().params.modelId).toBe('wan-remote');
  });

  it('leaves audio local — free-form music prompts cannot cross the wire', async () => {
    getSettings.mockResolvedValue(routedSettings({ audio: route, image: route }));
    await run('media_enqueueAudioJob', { prompt: 'a warm ambient bed' });
    expect(prepareRemoteMediaJob).not.toHaveBeenCalled();
    expect(enqueued().params.prompt).toBe('a warm ambient bed');
  });

  it('fails the enqueue rather than silently burning local GPU when the peer is busy', async () => {
    getSettings.mockResolvedValue(routedSettings({ image: route }));
    prepareRemoteMediaJob.mockRejectedValue(
      Object.assign(new Error('Media provider is at capacity'), { code: 'MEDIA_PROVIDER_BUSY' }),
    );
    await expect(run('media_enqueueImageJob', { prompt: 'a lighthouse' }, { projectId: 'cd-1' }))
      .rejects.toThrow('Media provider is at capacity');
    expect(enqueueJob).not.toHaveBeenCalled();
  });
});
