import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock only what the media tools reach for. The queue is the observable
// boundary — every assertion here is about the params that land on it, because
// `job.params.mode` is the ONLY thing mediaJobQueue routes the backend on.
vi.mock('../../mediaJobQueue/index.js', () => ({ enqueueJob: vi.fn(() => ({ jobId: 'mj-test' })) }));
vi.mock('../../settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));
vi.mock('../../creativeDirector/local.js', () => ({ getProject: vi.fn(async () => null) }));

import { enqueueJob } from '../../mediaJobQueue/index.js';
import { getSettings } from '../../settings.js';
import { getProject } from '../../creativeDirector/local.js';
import { MEDIA_TOOLS } from './media.js';

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
});

describe('render-backend pin — the auto/unpinned path is a strict no-op (#3135)', () => {
  it('leaves image params untouched with no owning project', async () => {
    await run('media_enqueueImageJob', { prompt: 'a lighthouse' });
    expect(enqueued().params).toEqual({ prompt: 'a lighthouse' });
    // No project ⇒ no settings read at all.
    expect(getSettings).not.toHaveBeenCalled();
  });

  it('leaves image params untouched when the project has no pin', async () => {
    getProject.mockResolvedValue(projectWithPin(null));
    await run('media_enqueueImageJob', { prompt: 'p' }, { projectId: 'cd-1' });
    expect(enqueued().params).toEqual({ prompt: 'p' });
    expect(getSettings).not.toHaveBeenCalled();
  });

  it('leaves video params untouched when the project has no pin', async () => {
    getProject.mockResolvedValue(projectWithPin(null));
    await run('media_enqueueVideoJob', { prompt: 'p', mode: 'image' }, { projectId: 'cd-1' });
    // The local lane's `mode` is the t2v/i2v SEMANTIC — it must survive untouched.
    expect(enqueued().params).toEqual({ prompt: 'p', mode: 'image' });
  });

  it('reads the owning project exactly once per enqueue', async () => {
    getProject.mockResolvedValue(projectWithPin({ image: { mode: 'local' } }));
    await run('media_enqueueVideoJob', { prompt: 'p' }, { projectId: 'cd-1' });
    expect(getProject).toHaveBeenCalledTimes(1);
  });
});

describe('render-backend pin — image (#3135)', () => {
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

  it('falls through untouched when settings are unreadable', async () => {
    getSettings.mockRejectedValue(new Error('settings unavailable'));
    getProject.mockResolvedValue(projectWithPin({ image: { mode: 'grok' } }));
    await run('media_enqueueImageJob', { prompt: 'p' }, { projectId: 'cd-1' });
    expect(enqueued().params).toEqual({ prompt: 'p' });
  });
});

describe('render-backend pin — video (#3135)', () => {
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

  it('STRIPS a planner-authored grok discriminator when the pin says local', async () => {
    // The discriminator and the t2v/i2v semantic share `params.mode`, so leaving
    // a planner-written 'grok' in place would dispatch to grok in defiance of the
    // pin. Dropping it lets local.js infer the semantic (= what an unset mode means).
    getSettings.mockResolvedValue({ imageGen: {} });
    getProject.mockResolvedValue(projectWithPin({ video: { mode: 'local' } }));
    await run('media_enqueueVideoJob', { prompt: 'p', mode: 'grok' }, { projectId: 'cd-1' });
    expect(enqueued().params).toEqual({ prompt: 'p' });
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

describe('audio enqueues never consult the render-backend pin', () => {
  it('tags the music bed without reading the project or settings', async () => {
    await run('media_enqueueAudioJob', { prompt: 'a mournful synth score' }, { projectId: 'cd-1' });
    expect(enqueued().params.creativeDirectorMusicBed).toEqual({ projectId: 'cd-1' });
    expect(getProject).not.toHaveBeenCalled();
    expect(getSettings).not.toHaveBeenCalled();
  });
});
