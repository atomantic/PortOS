import {
  compiledVisual,
  compileFableLoomVisualRequest,
  fableLoomVideoCapabilities,
  getLoom,
  loraCapability,
  clipCastReferences,
  prepareSourceAudioWindow,
  recordUserAction,
  setPendingUpload,
  app,
  installVideoRouteHooks,
} from './videoGen.test.fixture.js';
import { describe, it, expect, vi } from 'vitest';
import { join, resolve } from 'path';
import { request } from '../lib/testHelper.js';
import { DEFAULT_CONTEXT_FRAMES, MAX_CONTEXT_FRAMES } from '../lib/videoContinuity.js';
import { copyFile } from 'fs/promises';
import * as videoGenService from '../services/videoGen/local.js';
import * as mediaJobQueue from '../services/mediaJobQueue/index.js';
import { getProject as getMusicVideoProject } from '../services/musicVideo/projects.js';
import { getTrack } from '../services/tracks/index.js';
import { resolveGalleryImage } from '../lib/fileUtils.js';
import { listIcLoraWeights } from '../lib/icLoraWeights.js';
import { isAudioMime } from './videoGen.js';
import { LOCAL_ONLY_VIDEO_PARAMS } from '../lib/videoGenValidation.js';

// isAudioMime is the gating function inside the fileFilter callback. The
// multipart mock in these route tests bypasses fileFilter entirely, so we
// unit-test the helper directly to cover all the MIME / extension cases.
describe('isAudioMime', () => {
  it('accepts standard audio/* types', () => {
    expect(isAudioMime('audio/wav', 'clip.wav')).toBe(true);
    expect(isAudioMime('audio/mpeg', 'song.mp3')).toBe(true);
    expect(isAudioMime('audio/ogg', 'clip.ogg')).toBe(true);
    expect(isAudioMime('audio/flac', 'clip.flac')).toBe(true);
  });

  it('accepts audio/mp4 (Chrome/Firefox label for M4A)', () => {
    expect(isAudioMime('audio/mp4', 'song.m4a')).toBe(true);
  });

  it('accepts audio/x-m4a', () => {
    expect(isAudioMime('audio/x-m4a', 'song.m4a')).toBe(true);
  });

  it('accepts audio/aac', () => {
    expect(isAudioMime('audio/aac', 'clip.aac')).toBe(true);
  });

  it('accepts video/mp4 + .m4a extension (Safari label for M4A)', () => {
    expect(isAudioMime('video/mp4', 'song.m4a')).toBe(true);
  });

  it('accepts video/mp4 + .aac extension', () => {
    expect(isAudioMime('video/mp4', 'clip.aac')).toBe(true);
  });

  it('rejects video/mp4 when extension is .mp4 (genuine video)', () => {
    expect(isAudioMime('video/mp4', 'movie.mp4')).toBe(false);
  });

  it('rejects video/mp4 with no filename (no extension to confirm)', () => {
    expect(isAudioMime('video/mp4', '')).toBe(false);
    expect(isAudioMime('video/mp4', undefined)).toBe(false);
  });

  it('rejects image/* and video/* (non-audio) types', () => {
    expect(isAudioMime('image/jpeg', 'photo.jpg')).toBe(false);
    expect(isAudioMime('video/webm', 'clip.webm')).toBe(false);
  });

  it('rejects null/undefined mime', () => {
    expect(isAudioMime(null, 'clip.wav')).toBe(false);
    expect(isAudioMime(undefined, 'clip.wav')).toBe(false);
  });
});

describe('videoGen routes', () => {
  installVideoRouteHooks();

  describe('POST / — video pin ladder (#3231 Phase 4)', () => {
    const grokReady = { grok: { enabled: true, grokPath: '/opt/grok' } };

    it('routes an unpinned-request render to grok via settings.videoGen.mode', async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce({ imageGen: grokReady, videoGen: { mode: 'grok' } });
      const r = await request(app).post('/api/video-gen/').send({ prompt: 'a fox' });
      expect(r.status).toBe(200);
      expect(r.body.mode).toBe('grok');
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'video',
        params: expect.objectContaining({ mode: 'grok', videoMode: 'text', grokPath: '/opt/grok' }),
      }));
    });

    it('an explicit backend outranks the install pin', async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce({
        imageGen: { ...grokReady, local: { pythonPath: '/usr/bin/python3' } },
        videoGen: { mode: 'grok' },
      });
      const r = await request(app).post('/api/video-gen/').send({ prompt: 'a fox', backend: 'local' });
      expect(r.status).toBe(200);
      const [call] = mediaJobQueue.enqueueJob.mock.calls;
      expect(call[0].params.mode).not.toBe('grok');
    });

    it('restores the LF line breaks a browser form upload turns into CRLF', async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce({ imageGen: { local: { pythonPath: '/usr/bin/python3' } }, videoGen: {} });
      const r = await request(app).post('/api/video-gen/')
        .send({ prompt: 'Reference sheet: Rider.\r\n\r\nGenerated video: a fox', negativePrompt: 'blur\r\nnoise', backend: 'local' });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob.mock.calls.at(-1)[0].params).toMatchObject({
        prompt: 'Reference sheet: Rider.\n\nGenerated video: a fox', negativePrompt: 'blur\nnoise',
      });
    });

    it('a named local model anchors a no-backend request local, even under a grok pin', async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce({
        imageGen: { ...grokReady, local: { pythonPath: '/usr/bin/python3' } },
        videoGen: { mode: 'grok' },
      });
      // A media requeue rebuilds a local render's config (modelId, no backend)
      // — grok has no model knob, so the pin must not discard the model.
      const r = await request(app).post('/api/video-gen/').send({ prompt: 'a fox', modelId: 'ltx2_unified' });
      expect(r.status).toBe(200);
      const [call] = mediaJobQueue.enqueueJob.mock.calls;
      expect(call[0].params.mode).not.toBe('grok');
      expect(call[0].params.modelId).toBe('ltx2_unified');
    });

    it.each(Object.entries({
      numFrames: 49,
      fps: 24,
      steps: 25,
      guidanceScale: 3,
      seed: 0,
      imageStrength: 0.5,
      tiling: 'auto',
    }))('keeps %s on the local path under a grok pin', async (param, value) => {
      expect(Object.keys(LOCAL_ONLY_VIDEO_PARAMS)).toEqual([
        'numFrames',
        'fps',
        'steps',
        'guidanceScale',
        'batchSize',
        'seed',
        'imageStrength',
        // Not in the it.each table above: a non-default value is only legal on
        // an image-mode request with a source image, so the generic
        // prompt-only round-trip would 400 rather than assert anything. Its
        // own case is below.
        'i2vReferenceMode',
        'a2vLoraStageStrengths',
        'tiling',
        // Not in the it.each table above: the route deliberately DROPS the
        // stock/default value from persisted params, so the generic round-trip
        // assertion can't cover either. Their own cases are below.
        'textEncoderId',
        'speedProfileId',
        'draftDecode',
        // Not in the it.each table above: the route deliberately DROPS the
        // 'auto' default from persisted params, same reason as draftDecode's
        // full-decode default — the generic round-trip can't cover it. Its
        // own case is below.
        'streamingMode',
        'continuityStrategy',
      ]);
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce({ imageGen: grokReady, videoGen: { mode: 'grok' } });
      const r = await request(app).post('/api/video-gen/').send({ prompt: 'a fox', [param]: value });
      expect(r.status).toBe(200);
      const [call] = mediaJobQueue.enqueueJob.mock.calls;
      expect(call[0].params.mode).not.toBe('grok');
      expect(call[0].params[param]).toBe(value);
    });

    // grok has no conditioner knob, so naming one must keep the render local —
    // even for the stock id, which the route then drops from persisted params
    // (an unswapped render's job params stay byte-identical to a request that
    // never sent the field). Both halves matter: keeping it local without
    // dropping it would persist a knob that never applied.
    // Same contract for the decode knob (#5423): grok has no decoder choice, so
    // naming one keeps the render local — and the default value is dropped from
    // persisted params so a full-decode render's job params stay byte-identical
    // to a request that never sent the field.
    it('keeps draftDecode on the local path under a grok pin, without persisting the full value', async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce({ imageGen: grokReady, videoGen: { mode: 'grok' } });
      const r = await request(app).post('/api/video-gen/').send({ prompt: 'a fox', draftDecode: 'full' });
      expect(r.status).toBe(200);
      const [call] = mediaJobQueue.enqueueJob.mock.calls;
      expect(call[0].params.mode).not.toBe('grok');
      expect(call[0].params.draftDecode).toBeUndefined();
    });

    it('persists a non-default draftDecode on the local path', async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce({ imageGen: grokReady, videoGen: { mode: 'grok' } });
      const r = await request(app).post('/api/video-gen/').send({ prompt: 'a fox', draftDecode: 'draft' });
      expect(r.status).toBe(200);
      const [call] = mediaJobQueue.enqueueJob.mock.calls;
      expect(call[0].params.draftDecode).toBe('draft');
    });

    // A closed enum, unlike textEncoderId/speedProfileId — there is at most one
    // draft decoder per model, so an unknown value is a client bug, not a
    // per-model option the route can't enumerate.
    it.each(['turbo', 'DRAFT', ''])('rejects the draftDecode value %p', async (draftDecode) => {
      const r = await request(app).post('/api/video-gen/').send({ prompt: 'a fox', draftDecode });
      expect(r.status).toBe(400);
    });

    // Same contract for block streaming (#6499): grok has no such knob, so
    // naming one keeps the render local — and 'auto' (the bridge's own
    // default) is dropped from persisted params so an unswapped render's job
    // params stay byte-identical to a request that never sent the field.
    it('keeps streamingMode on the local path under a grok pin, without persisting the auto value', async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce({ imageGen: grokReady, videoGen: { mode: 'grok' } });
      const r = await request(app).post('/api/video-gen/').send({ prompt: 'a fox', streamingMode: 'auto' });
      expect(r.status).toBe(200);
      const [call] = mediaJobQueue.enqueueJob.mock.calls;
      expect(call[0].params.mode).not.toBe('grok');
      expect(call[0].params.streamingMode).toBeUndefined();
    });

    it('persists a non-default streamingMode on the local path', async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce({ imageGen: grokReady, videoGen: { mode: 'grok' } });
      const r = await request(app).post('/api/video-gen/').send({ prompt: 'a fox', streamingMode: 'stream' });
      expect(r.status).toBe(200);
      const [call] = mediaJobQueue.enqueueJob.mock.calls;
      expect(call[0].params.streamingMode).toBe('stream');
    });

    // A closed enum — the render bridge, not this route, decides whether the
    // resolved mode's pinned pipeline can honor 'stream' (#6499).
    it.each(['fast', 'STREAM', ''])('rejects the streamingMode value %p', async (streamingMode) => {
      const r = await request(app).post('/api/video-gen/').send({ prompt: 'a fox', streamingMode });
      expect(r.status).toBe(400);
    });

    it('keeps textEncoderId on the local path under a grok pin, without persisting the stock value', async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce({ imageGen: grokReady, videoGen: { mode: 'grok' } });
      const r = await request(app).post('/api/video-gen/').send({ prompt: 'a fox', textEncoderId: 'stock' });
      expect(r.status).toBe(200);
      const [call] = mediaJobQueue.enqueueJob.mock.calls;
      expect(call[0].params.mode).not.toBe('grok');
      expect(call[0].params.textEncoderId).toBeUndefined();
    });

    // grok's image_to_video always anchors, so naming a reference mode must keep
    // the render local — including the default, which the route then drops from
    // persisted params so an anchored render's job params stay byte-identical to
    // a request that never sent the field. Both halves matter: keeping it local
    // without dropping it would persist a knob that never applied.
    it('keeps i2vReferenceMode on the local path under a grok pin, without persisting the default', async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce({ imageGen: grokReady, videoGen: { mode: 'grok' } });
      const r = await request(app).post('/api/video-gen/').send({ prompt: 'a fox', i2vReferenceMode: 'anchor' });
      expect(r.status).toBe(200);
      const [call] = mediaJobQueue.enqueueJob.mock.calls;
      expect(call[0].params.mode).not.toBe('grok');
      expect(call[0].params.i2vReferenceMode).toBeUndefined();
    });

    // Same two halves for the speed profile (#4875): naming one keeps the
    // render local (grok has no sampler-schedule knob), and the default
    // 'quality' value is dropped from persisted params so a default render's
    // job params stay byte-identical to a request that never sent the field.
    it('keeps speedProfileId on the local path under a grok pin, without persisting the default value', async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce({ imageGen: grokReady, videoGen: { mode: 'grok' } });
      const r = await request(app).post('/api/video-gen/').send({ prompt: 'a fox', speedProfileId: 'quality' });
      expect(r.status).toBe(200);
      const [call] = mediaJobQueue.enqueueJob.mock.calls;
      expect(call[0].params.mode).not.toBe('grok');
      expect(call[0].params.speedProfileId).toBeUndefined();
    });

    it('persists a non-default speedProfileId on the local path under a grok pin', async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce({ imageGen: grokReady, videoGen: { mode: 'grok' } });
      const r = await request(app).post('/api/video-gen/').send({ prompt: 'a fox', speedProfileId: 'fast' });
      expect(r.status).toBe(200);
      const [call] = mediaJobQueue.enqueueJob.mock.calls;
      expect(call[0].params.mode).not.toBe('grok');
      expect(call[0].params.speedProfileId).toBe('fast');
    });

    it('a grok pin degrades to local when the request carries local-only machinery', async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce({
        imageGen: { ...grokReady, local: { pythonPath: '/usr/bin/python3' } },
        videoGen: { mode: 'grok' },
      });
      // 'fflf' is a local-runtime semantic — the pin must not hijack it to grok
      // (which would silently drop the keyframe machinery).
      const r = await request(app).post('/api/video-gen/').send({ prompt: 'a fox', mode: 'fflf' });
      expect(r.status).toBe(200);
      const [call] = mediaJobQueue.enqueueJob.mock.calls;
      expect(call[0].params.mode).not.toBe('grok');
    });

    it('a disabled grok install pin degrades to local instead of erroring', async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce({
        imageGen: { grok: { enabled: false }, local: { pythonPath: '/usr/bin/python3' } },
        videoGen: { mode: 'grok' },
      });
      const r = await request(app).post('/api/video-gen/').send({ prompt: 'a fox' });
      expect(r.status).toBe(200);
      const [call] = mediaJobQueue.enqueueJob.mock.calls;
      expect(call[0].params.mode).not.toBe('grok');
    });
  });

  describe('POST /', () => {
    it('rejects missing prompt', async () => {
      const r = await request(app).post('/api/video-gen/').send({ width: 512 });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/prompt/i);
    });

    it('rejects out-of-range width', async () => {
      const r = await request(app).post('/api/video-gen/').send({ prompt: 'a cat', width: 99999 });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/width/i);
    });

    it('rejects bad tiling enum value', async () => {
      const r = await request(app).post('/api/video-gen/').send({ prompt: 'a cat', tiling: 'wrong' });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/tiling/i);
    });

    it('queues a JSON request with a gallery sourceImageFile (#15963)', async () => {
      const r = await request(app)
        .post('/api/video-gen/')
        .set('Content-Type', 'application/json')
        .send({
          backend: 'local',
          mode: 'image',
          sourceImageFile: 'gallery-frame.png',
          prompt: 'a slow blink',
          width: 1024,
          height: 576,
          numFrames: 49,
          fps: 24,
        });
      expect(r.status).toBe(200);
      expect(r.body).toEqual(expect.objectContaining({
        jobId: 'mock-video-job',
        status: 'queued',
      }));
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'video',
        params: expect.objectContaining({
          prompt: 'a slow blink',
          sourceImagePath: '/mock/images/gallery-frame.png',
        }),
      }));
    });

    it('returns 400 validation error rather than INVALID_CONTENT_TYPE for invalid JSON body (#15963)', async () => {
      const r = await request(app)
        .post('/api/video-gen/')
        .set('Content-Type', 'application/json')
        .send({ width: 99999 });
      expect(r.status).toBe(400);
      expect(r.body.code).not.toBe('INVALID_CONTENT_TYPE');
      expect(r.body.error).toMatch(/prompt|width/i);
    });

    it('accepts empty-string numerics as undefined (multipart preprocess fix)', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a cat',
        width: '',
        height: '',
        seed: '',
      });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('queued');
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'video',
        params: expect.objectContaining({
          prompt: 'a cat',
          width: undefined,
          height: undefined,
          seed: undefined,
        }),
      }));
      expect(recordUserAction).toHaveBeenCalledWith(expect.objectContaining({
        type: 'media.video.enqueue',
        target: 'mock-video-job',
        summary: 'enqueued video job',
        payload: { jobId: 'mock-video-job' },
      }));
      expect(JSON.stringify(recordUserAction.mock.calls[0][0])).not.toContain('a cat');
    });

    it('carries the requested motion/refine multipliers from HTTP through the queue to helper arguments without changing prompt or audio', async () => {
      const { buildArgs } = await import('../services/videoGen/renderArgs.js');
      videoGenService.listVideoModels.mockReturnValueOnce([{ id: 'ltx25', runtime: 'ltx25', supportedModes: ['a2v'] }]);
      const prompt = '  A paper singer says hello.  ';
      setPendingUpload({ fieldname: 'audioFile', path: '/tmp/synthetic-voice.wav', originalname: 'voice.wav', mimetype: 'audio/wav', size: 128 });
      const response = await request(app).post('/api/video-gen/').send({
        prompt, mode: 'a2v', modelId: 'ltx25', a2vLoraStageStrengths: '[0,1]',
        loraFilenames: ['style.safetensors'], loraScales: [0.7],
      });
      expect(response.status).toBe(200);
      const { params } = mediaJobQueue.enqueueJob.mock.calls.at(-1)[0];
      expect(params).toMatchObject({ prompt, a2vLoraStageStrengths: [0, 1], loras: [{ filename: 'style.safetensors', scale: 0.7 }] });
      const command = buildArgs({ ...params, model: { runtime: 'ltx25' }, ltxModelPath: '/mock/model', outputPath: '/tmp/output.mp4',
        loras: [{ path: '/mock/style.safetensors', strength: 0.7 }] });
      expect(command.args[command.args.indexOf('--a2v-lora-stage-strengths') + 1]).toBe('[0,1]');
      expect(command.args[command.args.indexOf('--prompt') + 1]).toBe(prompt);
      expect(command.args[command.args.indexOf('--audio') + 1]).toBe(params.audioFilePath);
      for (const strengths of [undefined, [1, 1]]) {
        const legacy = buildArgs({ ...params, a2vLoraStageStrengths: strengths, model: { runtime: 'ltx25' },
          ltxModelPath: '/mock/model', outputPath: '/tmp/output.mp4' });
        expect(legacy.args).not.toContain('--a2v-lora-stage-strengths');
      }
    });

    it.each([[[-0.1, 1]], [[0, 1.1]], [[0]], [[false, 1]], [['0', 1]], ['broken-json']])(
      'rejects malformed stage strengths %j before queue admission', async (strengths) => {
        const response = await request(app).post('/api/video-gen/').send({ prompt: 'an invented singer', a2vLoraStageStrengths: strengths });
        expect(response.status).toBe(400);
        expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      });

    it.each([
      { backend: 'grok' }, { mediaProviderPeerId: 'peer-example' }, { mode: 'text' },
    ])('refuses a non-default stage request on an incompatible lane: %j', async (overrides) => {
      const response = await request(app).post('/api/video-gen/').send({
        prompt: 'an invented singer', a2vLoraStageStrengths: [0, 1], ...overrides,
      });
      expect(response.status).toBe(400);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    it('translates the universal loraFilenames/loraScales contract into internal { filename, scale } params', async () => {
      // This is the contract a history requeue (getRenderConfigForItem) emits,
      // so it must round-trip without a bespoke shape.
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'styled clip',
        loraFilenames: ['a.safetensors', 'b.safetensors'],
        loraScales: [0.7, 1.0],
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'video',
        params: expect.objectContaining({
          loras: [
            { filename: 'a.safetensors', scale: 0.7 },
            { filename: 'b.safetensors', scale: 1.0 },
          ],
        }),
      }));
    });

    it('defaults a missing scale to 1.0 when fewer loraScales than loraFilenames', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'clip',
        loraFilenames: ['a.safetensors'],
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        params: expect.objectContaining({ loras: [{ filename: 'a.safetensors', scale: 1.0 }] }),
      }));
    });

    it('rejects LoRAs on a non-ltx2 runtime with LORAS_REQUIRE_LTX2', async () => {
      videoGenService.listVideoModels.mockReturnValueOnce([
        { id: 'ltx_legacy', name: 'LTX legacy', runtime: 'mlx_video' },
      ]);
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'clip',
        modelId: 'ltx_legacy',
        loraFilenames: ['a.safetensors'],
      });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('LORAS_REQUIRE_LTX2');
    });

    // H3 CAN take LoRAs — it is the installed runner plus adapter capability
    // that is unavailable in this case. "Use an LTX-2.x model" would be wrong
    // advice, so the rejection carries its own code and reason.
    it('rejects LoRAs on an H3 model whose adapter probe fails, with an H3-specific code', async () => {
      videoGenService.listVideoModels.mockReturnValueOnce([
        { id: 'minimax_h3_8bit', name: 'MiniMax H3', runtime: 'minimax_h3', defaultFrames: 141, frameOptions: [141], fpsOptions: [24], runtimeLoraCapable: false },
      ]);
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'clip',
        modelId: 'minimax_h3_8bit',
        loraFilenames: ['a.safetensors'],
      });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('MINIMAX_H3_LORA_UNSUPPORTED');
    });

    // The decoration is a SYNC cache read, so a capable install still reports
    // `runtimeLoraCapable: false` until the probe lands. The gate must resolve
    // it rather than trust that snapshot — otherwise the first LoRA render after
    // boot is refused and only succeeds on a retry.
    it('resolves the probe rather than trusting a cold decoration on the model payload', async () => {
      loraCapability.capable = true;
      videoGenService.listVideoModels.mockReturnValueOnce([
        { id: 'minimax_h3_8bit', name: 'MiniMax H3', runtime: 'minimax_h3', defaultFrames: 141, frameOptions: [141], fpsOptions: [24], runtimeLoraCapable: false },
      ]);
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'clip',
        modelId: 'minimax_h3_8bit',
        loraFilenames: ['a.safetensors'],
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    });

    it('accepts LoRAs on an H3 model once the runtime probe proved it capable', async () => {
      loraCapability.capable = true;
      videoGenService.listVideoModels.mockReturnValueOnce([
        { id: 'minimax_h3_8bit', name: 'MiniMax H3', runtime: 'minimax_h3', defaultFrames: 141, frameOptions: [141], fpsOptions: [24], runtimeLoraCapable: true },
      ]);
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'clip',
        modelId: 'minimax_h3_8bit',
        loraFilenames: ['a.safetensors'],
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        params: expect.objectContaining({ loras: [{ filename: 'a.safetensors', scale: 1.0 }] }),
      }));
    });

    it('strips path-traversal segments from sourceImageFile via basename + prefix-check', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a cat',
        sourceImageFile: '../../etc/passwd',
      });
      // Documented-safe behavior: `basename()` strips dirs so the resolved
      // path is `/mock/images/passwd` (under PATHS.images). The route does
      // NOT 400 — it just consumes whatever's safely under the images root.
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'video',
        params: expect.objectContaining({
          prompt: 'a cat',
          sourceImagePath: '/mock/images/passwd',
        }),
      }));
    });

    it('rejects a mismatched board shot type carried through the video route', async () => {
      const project = { id: 'mv-1', scenes: [{ sceneId: 'mvs-1', shotMode: 'cutaway' }] };
      await getMusicVideoProject.withImplementation(async () => project, async () => {
        const r = await request(app).post('/api/video-gen/').send({ prompt: 'a singer', mode: 'image',
          sourceImageFile: 'scene-frame.png', musicVideo: JSON.stringify({ projectId: 'mv-1', sceneId: 'mvs-1', expectedShot: 'lipsync', songAudio: false }) });
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('MUSIC_VIDEO_SHOT_TYPE_CHANGED');
        expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      });
    });

    it('accepts a matching cutaway shot type through the video route', async () => {
      const project = { id: 'mv-1', scenes: [{ sceneId: 'mvs-1', shotMode: 'cutaway' }] };
      await getMusicVideoProject.withImplementation(async () => project, async () => {
        const tag = { projectId: 'mv-1', sceneId: 'mvs-1', expectedShot: 'cutaway', songAudio: false };
        const r = await request(app).post('/api/video-gen/').send({ prompt: 'a shot', mode: 'image',
          sourceImageFile: 'scene-frame.png', musicVideo: JSON.stringify(tag) });
        expect(r.status).toBe(200);
        expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ musicVideo: tag }) }));
      });
    });

    it('forwards a musicVideo i2v tag into job.params alongside the resolved frame (#1760 Phase 1)', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'slow dolly across the skyline',
        mode: 'image',
        sourceImageFile: 'scene-frame.png',
        musicVideo: JSON.stringify({ projectId: 'mv-1', sceneId: 'mvs-1' }),
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'video',
        params: expect.objectContaining({
          sourceImagePath: '/mock/images/scene-frame.png',
          musicVideo: { projectId: 'mv-1', sceneId: 'mvs-1' },
        }),
      }));
    });

    it('forwards a fableLoom i2v tag into job.params alongside the resolved frame', async () => {
      getLoom.mockResolvedValueOnce({
        id: 'loom-1',
        renderSettings: { formatId: 'portrait-9-16' },
      });
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'the gate slowly opens',
        mode: 'image',
        sourceImageFile: 'scene-image.png',
        fableLoom: JSON.stringify({ loomId: 'loom-1', episodeId: 'ep-1', nodeId: 'node-1' }),
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'video',
        params: expect.objectContaining({
          sourceImagePath: '/mock/images/scene-image.png',
          width: 576,
          height: 1024,
          aspectRatio: '9:16',
          fableLoom: { loomId: 'loom-1', episodeId: 'ep-1', nodeId: 'node-1' },
          visualConditioning: expect.objectContaining({
            render: expect.objectContaining({
              parameters: { width: 576, height: 1024, aspectRatio: '9:16' },
            }),
          }),
        }),
      }));
      expect(compileFableLoomVisualRequest).toHaveBeenCalledWith(expect.objectContaining({
        tag: { loomId: 'loom-1', episodeId: 'ep-1', nodeId: 'node-1' }, kind: 'video',
      }));
      expect(fableLoomVideoCapabilities).toHaveBeenCalledWith(expect.objectContaining({
        backend: 'local',
        model: expect.objectContaining({ supportedModes: expect.any(Array) }),
      }));
    });

    it('converts an explicitly degraded FableLoom render to text mode when its frame is omitted', async () => {
      compileFableLoomVisualRequest.mockResolvedValueOnce({
        prompt: 'the gate slowly opens', negativePrompt: '', sourceImagePath: null,
        visualConditioning: { ...compiledVisual, status: 'degraded' },
      });
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'the gate slowly opens',
        mode: 'image',
        sourceImageFile: 'scene-image.png',
        fableLoom: JSON.stringify({ loomId: 'loom-1', episodeId: 'ep-1', nodeId: 'node-1' }),
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        params: expect.objectContaining({ mode: 'text', sourceImagePath: null }),
      }));
    });

    it('rejects a musicVideo i2v render when the reference frame cannot be resolved (no silent t2v)', async () => {
      // A stale/deleted gallery file resolves to null (mustExist defaults true).
      resolveGalleryImage.mockReturnValueOnce(null);
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'slow dolly across the skyline',
        mode: 'image',
        sourceImageFile: 'gone.png',
        musicVideo: JSON.stringify({ projectId: 'mv-1', sceneId: 'mvs-1' }),
      });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('MUSIC_VIDEO_SOURCE_REQUIRED');
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    it('forwards lastImageFile + mode for FFLF', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'morph between two scenes',
        sourceImageFile: 'first.png',
        lastImageFile: 'last.png',
        mode: 'fflf',
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'video',
        params: expect.objectContaining({
          prompt: 'morph between two scenes',
          sourceImagePath: '/mock/images/first.png',
          lastImagePath: '/mock/images/last.png',
          mode: 'fflf',
        }),
      }));
    });

    it('forwards multi-keyframe array (resolved to gallery paths) under params.keyframes', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'four-pose shot',
        mode: 'fflf',
        numFrames: 121,
        keyframes: [
          { file: 'pose-a.png', index: 0 },
          { file: 'pose-b.png', index: 40 },
          { file: 'pose-c.png', index: 80 },
          { file: 'pose-d.png', index: 120 },
        ],
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'video',
        params: expect.objectContaining({
          mode: 'fflf',
          keyframes: [
            { path: '/mock/images/pose-a.png', index: 0 },
            { path: '/mock/images/pose-b.png', index: 40 },
            { path: '/mock/images/pose-c.png', index: 80 },
            { path: '/mock/images/pose-d.png', index: 120 },
          ],
        }),
      }));
    });

    it('parses keyframes when sent as a JSON-encoded string (multipart bodies)', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'multipart-style submission',
        mode: 'fflf',
        numFrames: 49,
        keyframes: JSON.stringify([
          { file: 'a.png', index: 0 },
          { file: 'b.png', index: 48 },
        ]),
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        params: expect.objectContaining({
          keyframes: [
            { path: '/mock/images/a.png', index: 0 },
            { path: '/mock/images/b.png', index: 48 },
          ],
        }),
      }));
    });

    it("defaults mode to 'fflf' when keyframes is set without an explicit mode", async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'mode-default coercion',
        numFrames: 49,
        keyframes: [
          { file: 'a.png', index: 0 },
          { file: 'b.png', index: 48 },
        ],
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        params: expect.objectContaining({ mode: 'fflf' }),
      }));
    });

    it('rejects keyframes when paired with mode != fflf', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'wrong mode',
        mode: 'image',
        keyframes: [
          { file: 'a.png', index: 0 },
          { file: 'b.png', index: 24 },
        ],
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/keyframes is only valid with mode='fflf'/);
    });

    it('rejects keyframes when chunks > 1 (no defined chained semantic)', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'chained keyframes',
        mode: 'fflf',
        chunks: 3,
        keyframes: [
          { file: 'a.png', index: 0 },
          { file: 'b.png', index: 24 },
        ],
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/keyframes cannot be combined with chunks/);
    });

    it('rejects keyframes when an index is outside [0, numFrames-1]', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'out of range index',
        mode: 'fflf',
        numFrames: 25,
        keyframes: [
          { file: 'a.png', index: 0 },
          { file: 'b.png', index: 25 }, // == numFrames, must be < numFrames
        ],
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/>= numFrames/);
    });

    it('rejects keyframes paired with a non-ltx2 modelId (KEYFRAMES_REQUIRE_LTX2)', async () => {
      // Multi-keyframe FFLF is an LTX-2 primitive — the route must reject
      // up-front rather than enqueue and let the worker fail asynchronously.
      videoGenService.listVideoModels.mockReturnValueOnce([
        { id: 'ltx_legacy', name: 'LTX legacy', runtime: 'mlx_video' },
      ]);
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'multi-keyframe on the wrong runtime',
        modelId: 'ltx_legacy',
        keyframes: [
          { file: 'a.png', index: 0 },
          { file: 'b.png', index: 24 },
        ],
      });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('KEYFRAMES_REQUIRE_LTX2');
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    it('rejects keyframes paired with sourceImageFile (KEYFRAMES_LEGACY_INPUTS_CONFLICT)', async () => {
      // Mixing keyframes with the legacy 2-keyframe inputs has ambiguous
      // precedence — force callers to pick one shape per request so the
      // worker doesn't silently drop one.
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'ambiguous inputs',
        sourceImageFile: 'first.png',
        keyframes: [
          { file: 'a.png', index: 0 },
          { file: 'b.png', index: 24 },
        ],
      });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('KEYFRAMES_LEGACY_INPUTS_CONFLICT');
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    it('rejects keyframes paired with lastImageFile (KEYFRAMES_LEGACY_INPUTS_CONFLICT)', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'ambiguous inputs 2',
        lastImageFile: 'last.png',
        keyframes: [
          { file: 'a.png', index: 0 },
          { file: 'b.png', index: 24 },
        ],
      });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('KEYFRAMES_LEGACY_INPUTS_CONFLICT');
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    it('rejects keyframes with index > default numFrames when numFrames is omitted', async () => {
      // generateVideo() defaults numFrames to 121 — the route must reject
      // out-of-range indices up-front instead of letting them queue and
      // fail late inside the worker / Python helper.
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'no numframes specified',
        mode: 'fflf',
        keyframes: [
          { file: 'a.png', index: 0 },
          { file: 'b.png', index: 500 }, // way past default of 121
        ],
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/default numFrames 121/);
    });

    it('rejects keyframes with non-ascending indices', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'bad order',
        mode: 'fflf',
        numFrames: 121,
        keyframes: [
          { file: 'a.png', index: 50 },
          { file: 'b.png', index: 30 }, // < previous
        ],
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/strictly ascending/);
    });

    it('forwards chunks > 1 so the queue dispatches the chain orchestrator', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a long shot',
        chunks: 4,
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'video',
        params: expect.objectContaining({ chunks: 4 }),
      }));
    });

    it('coerces chunks=1 (and missing) to 1 — the non-chained path', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a single render',
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'video',
        params: expect.objectContaining({ chunks: 1 }),
      }));
    });

    it('forces audio-to-video submissions to a single chunk', async () => {
      setPendingUpload({
        fieldname: 'audioFile',
        originalname: 'song.wav',
        mimetype: 'audio/wav',
        path: '/tmp/song.wav',
      });
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'sync to the track',
        mode: 'a2v',
        chunks: 4,
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'video',
        params: expect.objectContaining({ mode: 'a2v', chunks: 1 }),
      }));
    });

    it('rejects chunks above the 1..8 cap', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'too long',
        chunks: 99,
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/chunks/i);
    });

    it('persists explicit temporal intent and rejects invalid strategies before queueing', async () => {
      const accepted = await request(app).post('/api/video-gen/').send({
        prompt: 'a long shot', chunks: 3, continuityStrategy: 'window', contextFrames: 17,
      });
      expect(accepted.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({
        continuityStrategy: 'window', contextFrames: 17,
        continuation: expect.objectContaining({ requestedStrategy: 'window', effectiveStrategy: 'window', actualHistoryFrames: null }),
      }) }));
      mediaJobQueue.enqueueJob.mockClear();
      const invalid = await request(app).post('/api/video-gen/').send({ prompt: 'a shot', continuityStrategy: 'experimental' });
      expect(invalid.status).toBe(400);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    it('defaults the continuation context window on a chained request', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a long shot',
        chunks: 3,
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        params: expect.objectContaining({ chunks: 3, contextFrames: DEFAULT_CONTEXT_FRAMES }),
      }));
    });

    it('forwards an explicit context window', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a long shot',
        chunks: 2,
        contextFrames: 45,
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        params: expect.objectContaining({ contextFrames: 45 }),
      }));
    });

    it('preserves contextFrames: 0 — last-frame chaining, not "unset"', async () => {
      // Dropping the 0 would silently upgrade the render back to a window and
      // give the user a materially different clip than they asked for.
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a long shot',
        chunks: 2,
        contextFrames: 0,
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        params: expect.objectContaining({ contextFrames: 0 }),
      }));
    });

    it('omits contextFrames entirely when the request does not chain', async () => {
      // Persisting a knob that could never have applied would replay into the
      // form on resume as if the user had chosen it.
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a single render',
        contextFrames: 45,
      });
      expect(r.status).toBe(200);
      const { params } = mediaJobQueue.enqueueJob.mock.calls.at(-1)[0];
      expect(params.chunks).toBe(1);
      expect(params).not.toHaveProperty('contextFrames');
    });

    it('rejects a context window past the cap', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a long shot',
        chunks: 2,
        contextFrames: MAX_CONTEXT_FRAMES + 1,
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/contextFrames/i);
    });

    it('forwards per-chunk prompt beats, keeping a blank entry as a fallback marker', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a long shot',
        chunks: 3,
        chunkPrompts: ['she opens the door', '', 'the storm breaks'],
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        params: expect.objectContaining({
          chunks: 3,
          chunkPrompts: ['she opens the door', null, 'the storm breaks'],
        }),
      }));
    });

    it('accepts a JSON-encoded beat list (the multipart submit shape)', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a long shot',
        chunks: 2,
        chunkPrompts: JSON.stringify(['first beat', 'second beat']),
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        params: expect.objectContaining({ chunkPrompts: ['first beat', 'second beat'] }),
      }));
    });

    it('omits beats entirely from a single-chunk render', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a single render',
        chunkPrompts: ['a stale beat'],
      });
      expect(r.status).toBe(200);
      const { params } = mediaJobQueue.enqueueJob.mock.calls.at(-1)[0];
      expect(params.chunks).toBe(1);
      expect('chunkPrompts' in params).toBe(false);
    });

    it('rejects a beat list longer than the chunk cap', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'too many beats',
        chunks: 2,
        chunkPrompts: Array.from({ length: 9 }, (_, i) => `beat ${i}`),
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/chunkPrompts/i);
    });

    it('forwards extendFromVideoId by resolving to a real disk path under data/videos/', async () => {
      const id = '11111111-1111-4111-8111-111111111111';
      const videoSvc = await import('../services/videoGen/local.js');
      videoSvc.loadHistory.mockResolvedValueOnce([{ id, filename: `${id}.mp4` }]);
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'continue the scene',
        mode: 'extend',
        extendFromVideoId: id,
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'video',
        params: expect.objectContaining({
          mode: 'extend',
          // The route resolves the id to an absolute path under PATHS.videos
          // (mocked to /mock/images for these tests; videos root is taken
          // from PATHS.videos which is also /mock-rooted).
          extendFromVideoPath: expect.stringContaining(`${id}.mp4`),
        }),
      }));
    });

    it('returns 404 when extendFromVideoId is not in history', async () => {
      const id = '22222222-2222-4222-8222-222222222222';
      const videoSvc = await import('../services/videoGen/local.js');
      videoSvc.loadHistory.mockResolvedValueOnce([]); // empty history
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'continue',
        mode: 'extend',
        extendFromVideoId: id,
      });
      expect(r.status).toBe(404);
      expect(r.body.error).toMatch(/not found in history/i);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    it('rejects malformed extendFromVideoId at the schema layer', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'continue',
        mode: 'extend',
        extendFromVideoId: 'not-a-uuid',
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/extendFromVideoId/i);
    });

    it('rejects an unknown mode value', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a cat',
        mode: 'bogus',
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/mode/i);
    });

    // a2v mode requires an audio upload. Without one the route fails fast
    // with VIDEO_GEN_AUDIO_REQUIRED (400) instead of queueing a job that
    // would fail late on the python helper's audio_path check.
    it('rejects a2v without an audio upload (VIDEO_GEN_AUDIO_REQUIRED)', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'beat-synced dancer',
        mode: 'a2v',
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/audioFile/i);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    // Audio upload present + mode='a2v': route stages the audio under
    // data/uploads/ and forwards the staged audioFilePath into enqueue
    // params. The python helper picks it up via --audio.
    it('stages audioFile upload and forwards audioFilePath for a2v mode', async () => {
      setPendingUpload({
        fieldname: 'audioFile',
        path: '/tmp/upload-fake.wav',
        originalname: 'beats.wav',
        mimetype: 'audio/wav',
        size: 1234,
      });
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'beat-synced dancer',
        mode: 'a2v',
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'video',
        params: expect.objectContaining({
          mode: 'a2v',
          // audio is staged into PATHS.uploads with the video-audio prefix
          audioFilePath: expect.stringMatching(/[\\/]mock[\\/]uploads[\\/]video-audio-.*\.wav$/),
          // and threaded into uploadedTempPaths (array) for worker cleanup —
          // uploadedTempPath (singular) stays reserved for the start-frame
          // upload so legacy persisted jobs replay correctly.
          uploadedTempPaths: expect.arrayContaining([
            expect.stringMatching(/[\\/]mock[\\/]uploads[\\/]video-audio-.*\.wav$/),
          ]),
        }),
      }));
    });

    it('queues LTX-2.5 image plus audio at the server-probed full duration', async () => {
      const ltx25 = {
        id: 'ltx25_mlx_q8',
        name: 'LTX-2.5 MLX Q8',
        runtime: 'ltx25',
        supportedModes: ['text', 'image', 'fflf', 'extend', 'a2v'],
        audioDurationDriven: true,
        frameStride: 8,
        maxNumFrames: 1017,
      };
      videoGenService.listVideoModels.mockReturnValueOnce([ltx25]);
      setPendingUpload({
        fieldname: 'audioFile',
        path: '/tmp/upload-forty-one-seconds.wav',
        originalname: 'forty-one-seconds.wav',
        mimetype: 'audio/wav',
        size: 4_000_000,
      });

      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'the tones awaken a dormant chamber',
        modelId: ltx25.id,
        mode: 'a2v',
        sourceImageFile: 'awakening-reference.png',
        fps: 24,
        numFrames: 121,
      });

      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'video',
        params: expect.objectContaining({
          modelId: ltx25.id,
          mode: 'a2v',
          sourceImagePath: '/mock/images/awakening-reference.png',
          numFrames: 985,
          audioFilePath: expect.stringMatching(/[\\/]mock[\\/]uploads[\\/]video-audio-.*\.wav$/),
        }),
      }));
    });

    it('queues MiniMax H3 Ref2VA only when image and audio conditioning are both present', async () => {
      const ref2va = {
        id: 'minimax_h3_ref2va_8bit',
        name: 'MiniMax H3 Ref2VA MLX 8-bit',
        runtime: 'minimax_h3_ref2va',
        supportedModes: ['a2v'],
        defaultFrames: 124,
        frameOptions: [107, 124, 141, 158],
        fpsOptions: [24],
        defaultWidth: 512,
        defaultHeight: 320,
        resolutionStep: 32,
        steps: 9,
        guidance: 0,
        samplerLocked: true,
      };
      videoGenService.listVideoModels.mockReturnValueOnce([ref2va]);
      setPendingUpload({
        fieldname: 'audioFile',
        path: '/tmp/upload-awakening.wav',
        originalname: 'awakening.wav',
        mimetype: 'audio/wav',
        size: 5_000_000,
      });

      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'the supplied tones release the chamber restraints',
        modelId: ref2va.id,
        mode: 'a2v',
        sourceImageFile: 'awakening-reference.png',
      });

      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'video',
        params: expect.objectContaining({
          modelId: ref2va.id,
          mode: 'a2v',
          sourceImagePath: '/mock/images/awakening-reference.png',
          audioFilePath: expect.stringMatching(/[\\/]mock[\\/]uploads[\\/]video-audio-.*\.wav$/),
        }),
      }));
    });

    it('rejects MiniMax H3 Ref2VA audio without a reference image', async () => {
      const ref2va = {
        id: 'minimax_h3_ref2va_8bit',
        name: 'MiniMax H3 Ref2VA MLX 8-bit',
        runtime: 'minimax_h3_ref2va',
        supportedModes: ['a2v'],
      };
      videoGenService.listVideoModels.mockReturnValueOnce([ref2va]);
      setPendingUpload({
        fieldname: 'audioFile',
        path: '/tmp/upload-awakening.wav',
        originalname: 'awakening.wav',
        mimetype: 'audio/wav',
        size: 5_000_000,
      });

      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'the supplied tones release the chamber restraints',
        modelId: ref2va.id,
        mode: 'a2v',
      });

      expect(r.status).toBe(400);
      expect(r.body.code).toBe('MINIMAX_H3_REF2VA_A2V_REQUIRES_IMAGE');
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    it.each([{ defaultFrames: undefined, numFrames: 121 }, { defaultFrames: 81, numFrames: 81 }])('stages the exact project audio window with the omitted $numFrames-frame runtime default', async ({ defaultFrames, numFrames }) => {
      videoGenService.listVideoModels.mockReturnValueOnce([{
        id: 'ltx2_unified', name: 'LTX-2 Unified', runtime: 'ltx2', supportedModes: ['text', 'image', 'fflf'], defaultFrames,
      }]);
      const endSec = 42.5 + (numFrames - 1) / 24;
      const project = {
        id: 'mv-example',
        trackId: 'track-example',
        scenes: [{ sceneId: 'scene-example', startSec: 42.5, endSec }],
      };
      getMusicVideoProject.mockResolvedValue(project);
      getTrack.mockResolvedValue({ id: 'track-example', audioFilename: 'example-song.wav' });
      const audioFilePath = join('/mock/uploads', 'mv-source-audio-00000000-0000-0000-0000-000000000001.wav');
      const audioConditioning = {
        sourceSha256: 'a'.repeat(64), clipSha256: 'b'.repeat(64),
        sampleRate: 48000, channels: 2,
        startSample: 42.5 * 48000, endSample: Math.round(endSec * 48000), sampleCount: Math.round((numFrames - 1) / 24 * 48000),
      };
      prepareSourceAudioWindow.mockResolvedValueOnce({ audioFilePath, audioConditioning });

      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'rain pulses with the percussion; no performers',
        mode: 'a2v',
        sourceImageFile: 'reference.png',
        audioStartSec: 42.5,
        disableAudio: true,
        musicVideo: { projectId: 'mv-example', sceneId: 'scene-example' },
      });

      expect(r.status).toBe(200);
      expect(prepareSourceAudioWindow).toHaveBeenCalledExactlyOnceWith({
        project, scene: { startSec: 42.5, endSec }, numFrames, fps: 24,
      });
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'video',
        params: expect.objectContaining({
          mode: 'a2v',
          numFrames,
          sourceImagePath: '/mock/images/reference.png',
          audioStartSec: 0,
          audioConditioning,
          disableAudio: true,
          audioFilePath,
          uploadedTempPaths: expect.arrayContaining([audioFilePath]),
          musicVideo: { projectId: 'mv-example', sceneId: 'scene-example' },
        }),
      }));
    });

    it('keeps long project audio on the local full-song path without claiming exact PCM provenance', async () => {
      getMusicVideoProject.mockResolvedValue({
        id: 'mv-example', trackId: 'track-example', scenes: [{ sceneId: 'scene-example' }],
      });
      getTrack.mockResolvedValue({ id: 'track-example', audioFilename: 'example-song.wav' });
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'rain pulses with the percussion; no performers',
        mode: 'a2v', sourceImageFile: 'reference.png', audioStartSec: 42.5, fps: 1, numFrames: 62,
        musicVideo: { projectId: 'mv-example', sceneId: 'scene-example' },
      });
      expect(r.status).toBe(200);
      expect(prepareSourceAudioWindow).not.toHaveBeenCalled();
      const { params } = mediaJobQueue.enqueueJob.mock.calls[0][0];
      expect(params).toMatchObject({ audioStartSec: 42.5, fps: 1, numFrames: 62,
        audioFilePath: expect.stringMatching(/[\\/]mock[\\/]uploads[\\/]video-audio-.*\.wav$/),
        uploadedTempPaths: expect.arrayContaining([params.audioFilePath]),
      });
      expect(params).not.toHaveProperty('audioConditioning');
      expect(copyFile).toHaveBeenCalledWith(join('/mock/music', 'example-song.wav'), params.audioFilePath);
    });

    // a2v on a runtime without audio conditioning would fail inside the worker.
    // The route catches it up front so
    // a typo / stale UI state doesn't pollute the persisted queue with a
    // doomed entry.
    it('rejects mode=a2v paired with a model that lacks audio conditioning', async () => {
      // Override the default ltx2-runtime model with a legacy mlx_video entry
      // for this single request.
      videoGenService.listVideoModels.mockReturnValueOnce([
        { id: 'ltx_legacy', name: 'LTX legacy', runtime: 'mlx_video' },
      ]);
      setPendingUpload({
        fieldname: 'audioFile',
        path: '/tmp/upload-fake.wav',
        originalname: 'beats.wav',
        mimetype: 'audio/wav',
        size: 1234,
      });
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'beat-synced dancer',
        mode: 'a2v',
        modelId: 'ltx_legacy',
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/audio-to-video runtime/i);
      expect(r.body.code).toBe('A2V_RUNTIME_UNSUPPORTED');
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    // Defense-in-depth: an audio upload paired with the wrong mode would
    // otherwise be silently dropped (queued as text-to-video). Reject so
    // the caller can't accidentally pay for the wrong generation path.
    it('rejects audioFile upload paired with a non-a2v mode (VIDEO_GEN_AUDIO_MODE_MISMATCH)', async () => {
      setPendingUpload({
        fieldname: 'audioFile',
        path: '/tmp/upload-fake.wav',
        originalname: 'beats.wav',
        mimetype: 'audio/wav',
        size: 1234,
      });
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a cat',
        mode: 'text',
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/a2v/i);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    // Pre-enqueue config validation: without pythonPath the queue would
    // accept the job, return 200/queued, then fail asynchronously over SSE
    // and pollute the persisted queue with a doomed entry. Skipped for
    // BYOV runtimes which bring their own venv (see the
    // BYOV_RUNTIMES allowlist mirrored in services/videoGen/local.js).
    it('rejects 400 VIDEO_GEN_NOT_CONFIGURED when pythonPath is missing and the model needs it', async () => {
      const settingsMock = await import('../services/settings.js');
      settingsMock.getSettings.mockResolvedValueOnce({ imageGen: { local: {} } });
      // Override the default `ltx2` mock with a legacy mlx_video runtime so
      // the pythonPath gate actually fires — BYOV runtimes are exempt.
      videoGenService.listVideoModels.mockReturnValueOnce([
        { id: 'legacy_mlx', name: 'legacy mlx_video', runtime: 'mlx_video' },
      ]);
      const r = await request(app).post('/api/video-gen/').send({ prompt: 'a cat', modelId: 'legacy_mlx' });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/not configured/i);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    // The matching positive case: a BYOV model bypasses the
    // pythonPath gate because buildArgs resolves its own venv.
    it('accepts a BYOV-runtime model (ltx2) when pythonPath is missing', async () => {
      const settingsMock = await import('../services/settings.js');
      settingsMock.getSettings.mockResolvedValueOnce({ imageGen: { local: {} } });
      const r = await request(app).post('/api/video-gen/').send({ prompt: 'a cat', modelId: 'ltx2_unified' });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledTimes(1);
    });

    // ── IC-LoRA remix modes (#3100) ─────────────────────────────────────────
    // The reference channel is what makes an IC render meaningful, so every
    // pairing rule fails fast at the route rather than in the worker.
    describe('IC-LoRA remix modes (#3100)', () => {
      const icUpload = {
        fieldname: 'icReference',
        path: '/tmp/upload-fake.mp4',
        originalname: 'depth.mp4',
        mimetype: 'video/mp4',
        size: 4321,
      };

      it('rejects ic-control with no reference (IC_LORA_REFERENCE_REQUIRED)', async () => {
        const r = await request(app).post('/api/video-gen/').send({
          prompt: 'follow the depth clip', mode: 'ic-control',
        });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/requires a reference video/i);
        expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      });

      it('stages an icReference upload and forwards icReferencePaths', async () => {
        setPendingUpload(icUpload);
        const r = await request(app).post('/api/video-gen/').send({
          prompt: 'follow the depth clip', mode: 'ic-control', icStrength: 0.8,
        });
        expect(r.status).toBe(200);
        expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
          params: expect.objectContaining({
            mode: 'ic-control',
            icStrength: 0.8,
            icReferencePaths: [expect.stringMatching(/[\\/]mock[\\/]uploads[\\/]video-ic-ref-.*\.mp4$/)],
            // Tracked for worker cleanup the same way the audio upload is.
            uploadedTempPaths: expect.arrayContaining([
              expect.stringMatching(/[\\/]mock[\\/]uploads[\\/]video-ic-ref-.*\.mp4$/),
            ]),
            // Chaining is meaningless for a reference-anchored render.
            chunks: 1,
          }),
        }));
      });

      it('resolves an icReferenceVideoIds history pick to its on-disk path', async () => {
        const id = '33333333-3333-4333-8333-333333333333';
        videoGenService.loadHistory.mockResolvedValueOnce([{ id, filename: `${id}.mp4` }]);
        const r = await request(app).post('/api/video-gen/').send({
          prompt: 'follow the prior render', mode: 'ic-control', icReferenceVideoIds: id,
        });
        expect(r.status).toBe(200);
        expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
          params: expect.objectContaining({
            icReferencePaths: [resolve('/mock/videos', `${id}.mp4`)],
          }),
        }));
      });

      it('rejects an icReferenceVideoIds id that is not in history', async () => {
        videoGenService.loadHistory.mockResolvedValueOnce([]);
        const r = await request(app).post('/api/video-gen/').send({
          prompt: 'follow it', mode: 'ic-control',
          icReferenceVideoIds: '44444444-4444-4444-8444-444444444444',
        });
        expect(r.status).toBe(404);
        expect(r.body.error).toMatch(/not found in history/i);
        expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      });

      it('rejects an upload combined with a history pick (IC_LORA_REFERENCE_CONFLICT)', async () => {
        setPendingUpload(icUpload);
        const r = await request(app).post('/api/video-gen/').send({
          prompt: 'follow it', mode: 'ic-control',
          icReferenceVideoIds: '55555555-5555-4555-8555-555555555555',
        });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/one reference shape per request/i);
        expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      });

      it('rejects more picks than the weight accepts (IC_LORA_REFERENCE_COUNT)', async () => {
        // Control is single-reference; the bounds come from the registry, so this
        // fires before any staging or history I/O.
        const r = await request(app).post('/api/video-gen/').send({
          prompt: 'follow them', mode: 'ic-control',
          icReferenceVideoIds: [
            '66666666-6666-4666-8666-666666666666',
            '77777777-7777-4777-8777-777777777777',
          ],
        });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/needs exactly 1 reference video/i);
        expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      });

      it('rejects an IC reference outside an IC mode (IC_LORA_MODE_MISMATCH)', async () => {
        setPendingUpload(icUpload);
        const r = await request(app).post('/api/video-gen/').send({
          prompt: 'plain render', mode: 'text',
        });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/only valid with an IC remix mode/i);
        expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      });

      it('rejects an IC mode on a non-ltx2 model (IC_LORA_REQUIRES_LTX2)', async () => {
        videoGenService.listVideoModels.mockReturnValueOnce([
          { id: 'ltx_legacy', name: 'LTX legacy', runtime: 'mlx_video' },
        ]);
        setPendingUpload(icUpload);
        const r = await request(app).post('/api/video-gen/').send({
          prompt: 'follow it', mode: 'ic-control', modelId: 'ltx_legacy',
        });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/ltx-2.3 model/i);
        expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      });

      it('rejects an IC mode on the grok backend (IC_LORA_REQUIRES_LOCAL_BACKEND)', async () => {
        // The grok short-circuit runs before IC staging, so without this guard
        // the reference clip would be silently dropped and a plain grok render
        // queued instead.
        setPendingUpload(icUpload);
        const r = await request(app).post('/api/video-gen/').send({
          prompt: 'follow it', mode: 'ic-control', backend: 'grok',
        });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/isn't available on the Grok backend/i);
        expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      });

      it('rejects an IC mode combined with chunks > 1 (IC_LORA_CHUNKS_CONFLICT)', async () => {
        setPendingUpload(icUpload);
        const r = await request(app).post('/api/video-gen/').send({
          prompt: 'follow it', mode: 'ic-control', chunks: 3,
        });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/chunks > 1/i);
        expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      });

      // ── Ingredients: 2-8 gallery STILLS (#3112) ──────────────────────────
      // A separate input surface from the clip fields above. The counts are the
      // weight's contract — a wrong one yields plausible garbage rather than an
      // error inside the pipeline, so the route asserts them before enqueue.
      describe('ic-ingredients image references (#3112)', () => {
        const stills = (n) => Array.from({ length: n }, (_, i) => `ref-${i}.png`);

        it('resolves 2-8 gallery stills to absolute paths', async () => {
          for (const n of [2, 5, 8]) {
            mediaJobQueue.enqueueJob.mockClear();
            const r = await request(app).post('/api/video-gen/').send({
              prompt: 'the owl greets the camera outside the store',
              mode: 'ic-ingredients', icReferenceImageFiles: stills(n),
            });
            expect(r.status).toBe(200);
            expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
              params: expect.objectContaining({
                mode: 'ic-ingredients',
                icReferencePaths: stills(n).map((f) => `/mock/images/${f}`),
                chunks: 1,
              }),
            }));
          }
        });

        it('rejects fewer than 2 references', async () => {
          const r = await request(app).post('/api/video-gen/').send({
            prompt: 'recompose', mode: 'ic-ingredients', icReferenceImageFiles: stills(1),
          });
          expect(r.status).toBe(400);
          expect(r.body.error).toMatch(/needs 2-8 reference image/i);
          expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
        });

        it('rejects more references than any registered weight accepts', async () => {
          // The schema ceiling is DERIVED from the registry (the largest
          // maxReferences declared), not a second hardcoded 8 that would pre-empt
          // the per-weight check with a 422 the moment a weight raised its limit.
          const ceiling = Math.max(...listIcLoraWeights().map((w) => w.maxReferences));
          const r = await request(app).post('/api/video-gen/').send({
            prompt: 'recompose', mode: 'ic-ingredients', icReferenceImageFiles: stills(ceiling + 1),
          });
          expect(r.status).toBe(400);
          expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
        });

        it('lets the registry bound speak at the ceiling rather than the schema', async () => {
          // At exactly the registry maximum the request must reach the per-mode
          // assertion (and pass), proving the coarse schema bound isn't the one
          // enforcing the weight contract.
          const ceiling = Math.max(...listIcLoraWeights().map((w) => w.maxReferences));
          const r = await request(app).post('/api/video-gen/').send({
            prompt: 'recompose', mode: 'ic-ingredients', icReferenceImageFiles: stills(ceiling),
          });
          expect(r.status).toBe(200);
        });

        it('rejects no references with an actionable message', async () => {
          const r = await request(app).post('/api/video-gen/').send({
            prompt: 'recompose', mode: 'ic-ingredients',
          });
          expect(r.status).toBe(400);
          // Names the field to use — "needs 2-8; got 0" alone doesn't say HOW.
          expect(r.body.error).toMatch(/icReferenceImageFiles/);
          expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
        });

        it('rejects a gallery miss before enqueue', async () => {
          vi.mocked(resolveGalleryImage).mockImplementation((f) => (f === 'gone.png' ? null : `/mock/images/${f}`));
          const r = await request(app).post('/api/video-gen/').send({
            prompt: 'recompose', mode: 'ic-ingredients',
            icReferenceImageFiles: ['ref-0.png', 'gone.png'],
          });
          expect(r.status).toBe(400);
          expect(r.body.error).toMatch(/icReferenceImageFiles\[1\] not found in gallery/);
          expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
          vi.mocked(resolveGalleryImage).mockImplementation((name) => `/mock/images/${name}`);
        });

        it('rejects clip inputs on an image-kind weight (IC_LORA_REFERENCE_KIND_MISMATCH)', async () => {
          // Feeding a clip to an image-kind weight does NOT error in the pipeline —
          // it produces plausible-looking garbage. So reject rather than drop.
          setPendingUpload(icUpload);
          const r = await request(app).post('/api/video-gen/').send({
            prompt: 'recompose', mode: 'ic-ingredients', icReferenceImageFiles: stills(2),
          });
          expect(r.status).toBe(400);
          expect(r.body.error).toMatch(/conditions on still images/i);
          expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
        });

        it('rejects image references on a video-kind weight (IC_LORA_REFERENCE_KIND_MISMATCH)', async () => {
          const r = await request(app).post('/api/video-gen/').send({
            prompt: 'follow the depth clip', mode: 'ic-control',
            icReferenceImageFiles: stills(2),
          });
          expect(r.status).toBe(400);
          expect(r.body.error).toMatch(/conditions on a reference clip/i);
          expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
        });

        it('rejects image references outside an IC mode', async () => {
          const r = await request(app).post('/api/video-gen/').send({
            prompt: 'plain render', mode: 'text', icReferenceImageFiles: stills(2),
          });
          expect(r.status).toBe(400);
          expect(r.body.error).toMatch(/only valid with an IC remix mode/i);
          expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
        });
      });

      it('queues a tagged LTX 2.5 reference request without optional client label metadata', async () => {
        const scene = { sceneId: 's1', shotMode: 'cutaway', startSec: 0, endSec: 5, prompt: 'A rider turns',
          referenceImageId: 'start.png', clipReferenceIds: ['rider'] };
        const project = { id: 'mv-1', scenes: [scene], visualSpec: { references: [{ id: 'rider', imageId: 'rider.png' }] } };
        getMusicVideoProject.mockResolvedValue(project);
        clipCastReferences.mockResolvedValue([{ path: '/mock/images/rider.png', label: 'Rider', promptLabel: 'Rider' }]);
        videoGenService.listVideoModels.mockReturnValueOnce([{ id: 'ltx25_mlx_q8', runtime: 'ltx25', supportedModes: ['text', 'image'], defaultFrames: 121 }]);
        try {
          const r = await request(app).post('/api/video-gen/').send({
            backend: 'local', modelId: 'ltx25_mlx_q8', mode: 'ic-ingredients-25', prompt: 'A rider turns',
            sourceImageFile: 'start.png', icReferenceImageFiles: ['rider.png'], numFrames: 121,
            musicVideo: { projectId: 'mv-1', sceneId: 's1', compose: true, promptAsTyped: true },
          });
          expect(r.status, JSON.stringify(r.body)).toBe(200);
          expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({
            prompt: 'Reference sheet: Rider.\n\nGenerated video: A rider turns', icReferencePaths: ['/mock/images/rider.png'],
          }) }));
        } finally {
          getMusicVideoProject.mockReset();
          clipCastReferences.mockReset().mockResolvedValue([]);
        }
      });
    });
  });
});
