import {
  compiledVisual,
  validateRunwayVideoInput,
  compileFableLoomVisualRequest,
  getLoom,
  clipCastReferences,
  federatedPeerId,
  setPendingUpload,
  app,
  installVideoRouteHooks,
} from './videoGen.test.fixture.js';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { request } from '../lib/testHelper.js';
import { copyFile, unlink } from 'fs/promises';
import * as videoGenService from '../services/videoGen/local.js';
import * as mediaJobQueue from '../services/mediaJobQueue/index.js';
import { prepareRemoteMediaJob } from '../services/federatedMedia/remoteSubmission.js';
import { getProject as getMusicVideoProject } from '../services/musicVideo/projects.js';
import { resolveGalleryImage } from '../lib/fileUtils.js';

describe('videoGen routes', () => {
  installVideoRouteHooks();

  describe('POST / — hosted submission contracts', () => {
    const settings = {
      imageGen: { grok: { enabled: true, grokPath: '/example/grok', aspectRatio: '16:9' } },
      videoGen: { fal: { apiKey: 'example-fal-key' }, reactor: { apiKey: 'example-reactor-key' } },
    };
    it.each([
      ['aleph2', 'runway'], ['act_two', 'runway'],
      ['aleph2', undefined], ['act_two', undefined],
    ])('stages %s inputs with backend %s and preserves the workflow in queued params', async (modelId, backend) => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce({ videoGen: { mode: 'runway', runway: { apiKey: 'example-key' } } });
      setPendingUpload({ fieldname: 'runwayVideo', path: '/tmp/performance.mp4', originalname: 'performance.mp4' });
      const mode = modelId === 'aleph2' ? 'video-edit' : 'character-performance';
      const response = await request(app).post('/api/video-gen/').send({ backend, mode, runwayModelId: modelId, prompt: '',
        ...(modelId === 'act_two' ? { sourceImageFile: 'character.png', runwayBodyControl: 'false', runwayExpressionIntensity: '4' } : { runwayTargetAspect: '9:16' }),
      });
      expect(response.status).toBe(200);
      const params = mediaJobQueue.enqueueJob.mock.calls[0][0].params;
      expect(params).toMatchObject({ mode: 'runway', videoMode: mode, modelId, runwayVideoPath: expect.stringContaining('video-runway-video-') });
      expect(params.uploadedTempPaths).toContain(params.runwayVideoPath);
      expect(validateRunwayVideoInput).toHaveBeenCalledWith(params.runwayVideoPath, expect.objectContaining({ id: modelId }));
      expect(JSON.stringify(params)).not.toContain('example-key');
    });

    it.each(['local', undefined])('refuses an empty-prompt special workflow on non-Runway backend %s', async (backend) => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce({ videoGen: { mode: 'grok' }, imageGen: { grok: { enabled: true } } });
      const response = await request(app).post('/api/video-gen/').send({ backend, mode: 'character-performance', runwayModelId: 'act_two', prompt: '' });
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/matching Runway video workflow/);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    it('rolls back the durable video if validation fails and refuses a video workflow on another backend', async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce({ videoGen: { runway: { apiKey: 'example-key' } } });
      validateRunwayVideoInput.mockRejectedValueOnce(Object.assign(new Error('Video is too long'), { status: 400 }));
      setPendingUpload({ fieldname: 'runwayVideo', path: '/tmp/source.mp4', originalname: 'source.mp4' });
      const response = await request(app).post('/api/video-gen/').send({ backend: 'runway', mode: 'video-edit', runwayModelId: 'aleph2', prompt: '' });
      expect(response.status).toBe(400);
      expect(unlink).toHaveBeenCalledWith(copyFile.mock.calls[0][1]);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      const mismatch = await request(app).post('/api/video-gen/').send({ backend: 'local', mode: 'character-performance', prompt: 'test' });
      expect(mismatch.status).toBe(400);
    });

    it('does not silently drop an unresolved Aleph guidance image', async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce({ videoGen: { runway: { apiKey: 'example-key' } } });
      resolveGalleryImage.mockReturnValueOnce(null);
      setPendingUpload({ fieldname: 'runwayVideo', path: '/tmp/source.mp4', originalname: 'source.mp4' });
      const response = await request(app).post('/api/video-gen/').send({ backend: 'runway', mode: 'video-edit', runwayModelId: 'aleph2', prompt: '', sourceImageFile: 'missing.png' });
      expect(response.status).toBe(400);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      expect(copyFile).not.toHaveBeenCalled();
    });
    const providers = [
      { backend: 'grok', input: { grokDuration: 10 },
        minimal: { grokPath: '/example/grok', aspectRatio: '16:9', width: undefined, height: undefined, duration: undefined },
        tagged: { grokPath: '/example/grok', aspectRatio: '9:16', width: 576, height: 1024, duration: 10 } },
      // The chosen model, its resolution and an explicit audio request thread
      // through to the queued job (videoGen/fal.js resolves them per model).
      { backend: 'fal', input: { falModelId: 'bytedance/seedance-2.5/image-to-video', falDuration: 6, falResolution: '1080p', falGenerateAudio: 'true' },
        minimal: { modelId: undefined, aspectRatio: undefined, width: undefined, height: undefined, duration: undefined },
        tagged: { modelId: 'bytedance/seedance-2.5/image-to-video', aspectRatio: '9:16', width: 576, height: 1024, duration: 6, resolution: '1080p', generateAudio: true } },
      { backend: 'reactor', input: { reactorClipId: 'example-clip', reactorSeconds: 6, reactorSeed: 0, reactorAspect: '9:16' },
        minimal: { continueFromClipId: undefined, seconds: undefined, seed: undefined, aspect: undefined },
        tagged: { continueFromClipId: 'example-clip', seconds: 6, seed: 0, aspect: '9:16' } },
    ];

    it.each([
      { input: 'gallery', falModelId: 'fal-ai/kling-video/v3/pro/image-to-video' },
      { input: 'upload', falModelId: 'fal-ai/kling-video/v3/pro/image-to-video' },
      { input: 'gallery', falModelId: undefined },
    ])('queues fal start/end frames from $input with model $falModelId and upload ownership intact', async ({ input, falModelId }) => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce(settings);
      if (input === 'upload') {
        setPendingUpload(
          { fieldname: 'sourceImage', path: '/tmp/fal-start.png', originalname: 'start.png' },
          { fieldname: 'lastImage', path: '/tmp/fal-end.jpg', originalname: 'end.jpg' },
        );
      }
      const musicVideo = { projectId: 'mv-example', sceneId: 'scene-example' };
      const r = await request(app).post('/api/video-gen/').send({
        backend: 'fal', falModelId, prompt: 'a fox',
        sourceImageFile: 'start.png', lastImageFile: 'end.jpg', musicVideo,
      });
      expect(r.status).toBe(200);
      const { params } = mediaJobQueue.enqueueJob.mock.calls[0][0];
      expect(params).toMatchObject({ mode: 'fal', videoMode: 'image', musicVideo });
      if (input === 'gallery') {
        expect(params).toMatchObject({ sourceImagePath: '/mock/images/start.png', lastImagePath: '/mock/images/end.jpg', uploadedTempPath: null });
        expect(params).not.toHaveProperty('uploadedTempPaths');
      } else {
        expect(params.sourceImagePath.split('\\').join('/')).toMatch(/^\/mock\/uploads\/video-source-.*\.png$/);
        expect(params.lastImagePath.split('\\').join('/')).toMatch(/^\/mock\/uploads\/video-last-.*\.jpg$/);
        expect(params.uploadedTempPath).toBe(params.sourceImagePath);
        expect(params.uploadedTempPaths).toEqual([params.lastImagePath]);
        expect(unlink).toHaveBeenCalledWith('/tmp/fal-start.png');
        expect(unlink).toHaveBeenCalledWith('/tmp/fal-end.jpg');
      }
      expect(unlink).not.toHaveBeenCalledWith('/mock/images/start.png');
      expect(unlink).not.toHaveBeenCalledWith('/mock/images/end.jpg');
    });

    it.each(['fal-ai/veo3.1/fast/image-to-video', 'fal-ai/uncatalogued-model'])('rejects an unsupported fal end frame for model %s before enqueueing', async (falModelId) => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce(settings);
      setPendingUpload({ fieldname: 'lastImage', path: '/tmp/fal-end.jpg', originalname: 'end.jpg' });
      const r = await request(app).post('/api/video-gen/').send({
        backend: 'fal', falModelId, prompt: 'a fox', sourceImageFile: 'start.png',
      });
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ code: 'VALIDATION_ERROR', error: expect.stringMatching(/end.frame/i) });
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      expect(copyFile).not.toHaveBeenCalled();
      expect(unlink).toHaveBeenCalledWith('/tmp/fal-end.jpg');
    });

    it('rejects a missing fal gallery end frame instead of silently rendering without it', async () => {
      const { getSettings } = await import('../services/settings.js');
      const { resolveGalleryImage } = await import('../lib/fileUtils.js');
      getSettings.mockResolvedValueOnce(settings);
      resolveGalleryImage.mockReturnValueOnce('/mock/images/start.png').mockReturnValueOnce(null);
      const r = await request(app).post('/api/video-gen/').send({
        backend: 'fal', falModelId: 'fal-ai/kling-video/v3/pro/image-to-video', prompt: 'a fox',
        sourceImageFile: 'start.png', lastImageFile: 'missing.jpg',
      });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('VALIDATION_ERROR');
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    it('rolls back both fal frame uploads when enqueueing fails', async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce(settings);
      mediaJobQueue.enqueueJob.mockImplementationOnce(() => { throw new Error('queue full'); });
      setPendingUpload(
        { fieldname: 'sourceImage', path: '/tmp/fal-start.png', originalname: 'start.png' },
        { fieldname: 'lastImage', path: '/tmp/fal-end.jpg', originalname: 'end.jpg' },
      );
      const r = await request(app).post('/api/video-gen/').send({
        backend: 'fal', falModelId: 'fal-ai/kling-video/v3/pro/image-to-video', prompt: 'a fox',
      });
      expect(r.status).toBe(500);
      const durablePaths = copyFile.mock.calls.map(([, path]) => path);
      expect(durablePaths).toHaveLength(2);
      for (const path of durablePaths) expect(unlink).toHaveBeenCalledWith(path);
    });

    it.each(providers)('preserves $backend text defaults and exact optional-key presence', async ({ backend, minimal }) => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce(settings);
      const r = await request(app).post('/api/video-gen/').send({ backend, prompt: 'a fox' });
      expect(r.status).toBe(200);
      expect(r.body).toStrictEqual({
        jobId: 'mock-video-job', generationId: 'mock-video-job', filename: 'mock-video-job.mp4',
        model: backend, mode: backend, status: 'queued', position: 1,
      });
      expect(mediaJobQueue.enqueueJob.mock.calls[0][0]).toStrictEqual({
        kind: 'video', params: {
          mode: backend, videoMode: 'text', prompt: 'a fox', negativePrompt: '',
          sourceImagePath: null, uploadedTempPath: null, ...minimal,
        },
      });
    });

    it.each(providers)('preserves $backend image payload and all provenance tags', async ({ backend, input, tagged }) => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce(settings);
      getLoom.mockResolvedValueOnce({ renderSettings: { formatId: 'portrait-9-16' } });
      const musicVideo = { projectId: 'mv-example', sceneId: 'scene-example' };
      const fableLoom = { loomId: 'loom-example', episodeId: 'ep-example', nodeId: 'node-example' };
      const r = await request(app).post('/api/video-gen/').send({
        backend, prompt: 'a fox', ...(backend === 'reactor' ? {} : { negativePrompt: 'blur' }), sourceImageFile: 'frame.png',
        musicVideo, fableLoom, ...input,
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob.mock.calls[0][0]).toStrictEqual({
        kind: 'video', params: {
          mode: backend, videoMode: 'image', prompt: 'a fox', negativePrompt: backend === 'reactor' ? '' : 'blur',
          sourceImagePath: '/mock/images/frame.png', uploadedTempPath: null,
          musicVideo, fableLoom,
          visualConditioning: {
            ...compiledVisual, render: {
              provider: backend, modelId: backend + '-video', modelRevision: null,
              parameters: { width: 576, height: 1024, aspectRatio: '9:16' },
            },
          },
          ...tagged,
        },
      });
      expect(unlink).not.toHaveBeenCalledWith('/mock/images/frame.png');
    });

    it.each([
      ['grok', 'GROK_IMAGEGEN_DISABLED', 'Grok Imagegen is disabled — enable it in Media Gen Settings first'],
      ['fal', 'FAL_NOT_CONFIGURED', 'No fal.ai API key configured — set it in Settings → Credentials (or the FAL_KEY env var) first'],
      ['reactor', 'REACTOR_NOT_CONFIGURED', 'No reactor.inc API key configured — set it in Settings → Credentials (or the REACTOR_API_KEY env var) first'],
    ])('preserves %s availability errors after staging a source', async (backend, code, message) => {
      const { getSettings } = await import('../services/settings.js');
      vi.stubEnv('FAL_KEY', '');
      vi.stubEnv('REACTOR_API_KEY', '');
      getSettings.mockResolvedValueOnce({});
      setPendingUpload({ fieldname: 'sourceImage', path: '/tmp/hosted-frame.png', originalname: 'frame.png' });
      const r = await request(app).post('/api/video-gen/').send({ backend, prompt: 'a fox' });
      vi.unstubAllEnvs();
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ code, error: message });
      expect(copyFile).toHaveBeenCalledTimes(1);
      expect(unlink).toHaveBeenCalledWith(copyFile.mock.calls[0][1]);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    it.each(['enqueue', 'conditioning'])('rolls back a hosted durable source on %s failure', async (failureStage) => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce(settings);
      const failure = new Error('example hosted rejection');
      if (failureStage === 'enqueue') mediaJobQueue.enqueueJob.mockImplementationOnce(() => { throw failure; });
      else compileFableLoomVisualRequest.mockRejectedValueOnce(failure);
      setPendingUpload({ fieldname: 'sourceImage', path: '/tmp/hosted-frame.png', originalname: 'frame.png' });
      const r = await request(app).post('/api/video-gen/').send({
        backend: 'fal', prompt: 'a fox',
        fableLoom: { loomId: 'loom-example', episodeId: 'ep-example', nodeId: 'node-example' },
      });
      expect(r.status).toBe(500);
      expect(r.body.error).toBe(failure.message);
      expect(copyFile).toHaveBeenCalledTimes(1);
      const durable = copyFile.mock.calls[0][1];
      expect(unlink.mock.calls.filter(([path]) => path === durable)).toHaveLength(1);
      expect(unlink).toHaveBeenCalledWith('/tmp/hosted-frame.png');
      if (failureStage === 'conditioning') expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    it.each([
      ['an explicit backend', { backend: 'reactor' }],
      ['the configured backend', {}],
      ['a tagged FableLoom scene', { backend: 'reactor', fableLoom: { loomId: 'loom-example', episodeId: 'episode-example', nodeId: 'node-example' } }],
    ])('refuses authored Reactor exclusions with %s before staging or queueing', async (_, fields) => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce({ ...settings, videoGen: { ...settings.videoGen, mode: 'reactor' } });
      const source = { fieldname: 'sourceImage', path: '/tmp/hosted-frame.png', originalname: 'frame.png' };
      setPendingUpload(source);
      const response = await request(app).post('/api/video-gen/').send({
        ...fields, prompt: 'a fox running', negativePrompt: '  fog  ',
      });
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        code: 'VIDEO_BACKEND_INPUT_UNSUPPORTED', error: expect.stringMatching(/Reactor.*exclusions in the main prompt.*compatible video backend/),
      });
      expect(copyFile).not.toHaveBeenCalled();
      expect(unlink).toHaveBeenCalledWith(source.path);
      expect(compileFableLoomVisualRequest).not.toHaveBeenCalled();
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    it.each([undefined, '', ' \t '])('submits and previews Reactor with a blank negative prompt (%j)', async (negativePrompt) => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce(settings).mockResolvedValueOnce(settings);
      const body = { backend: 'reactor', prompt: '  a fox running  ', negativePrompt };
      const response = await request(app).post('/api/video-gen/').send(body);
      expect(response.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledTimes(1);
      const [{ params }] = mediaJobQueue.enqueueJob.mock.calls[0];
      expect(params.mode).toBe('reactor');
      expect(params.negativePrompt).toBe('');

      const preview = await request(app).post('/api/video-gen/prompt-preview').send(body);
      expect(preview.status).toBe(200);
      expect(preview.body).toMatchObject({ backend: 'reactor', sentPrompt: 'a fox running' });
      expect(preview.body).not.toHaveProperty('sentNegativePrompt');
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledTimes(1);
    });

    it('refuses to preview an authored Reactor negative prompt', async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce(settings);
      const response = await request(app).post('/api/video-gen/prompt-preview').send({
        backend: 'reactor', prompt: 'a fox running', negativePrompt: 'fog',
      });
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        code: 'VIDEO_BACKEND_INPUT_UNSUPPORTED', error: expect.stringMatching(/Reactor.*exclusions in the main prompt/),
      });
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    it('hands a successful hosted upload to the worker and discards it on conditioning downgrade', async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce(settings);
      const source = { fieldname: 'sourceImage', path: '/tmp/hosted-frame.png', originalname: 'frame.png' };
      setPendingUpload(source);
      const r = await request(app).post('/api/video-gen/').send({ backend: 'reactor', prompt: 'a fox' });
      expect(r.status).toBe(200);
      const durable = copyFile.mock.calls[0][1];
      expect(mediaJobQueue.enqueueJob.mock.calls[0][0].params).toMatchObject({
        videoMode: 'image', sourceImagePath: durable, uploadedTempPath: durable,
      });
      expect(unlink).not.toHaveBeenCalledWith(durable);
      expect(unlink).toHaveBeenCalledWith(source.path);

      getSettings.mockResolvedValueOnce(settings);
      compileFableLoomVisualRequest.mockResolvedValueOnce({
        prompt: 'a fox', negativePrompt: '', sourceImagePath: null, visualConditioning: compiledVisual,
      });
      setPendingUpload(source);
      const downgraded = await request(app).post('/api/video-gen/').send({
        backend: 'reactor', prompt: 'a fox',
        fableLoom: { loomId: 'loom-example', episodeId: 'ep-example', nodeId: 'node-example' },
      });
      expect(downgraded.status).toBe(200);
      expect(mediaJobQueue.enqueueJob.mock.calls[1][0].params).toMatchObject({
        videoMode: 'text', sourceImagePath: null, uploadedTempPath: null,
      });
      expect(unlink).toHaveBeenCalledWith(copyFile.mock.calls[1][1]);
    });
  });

  describe('POST / — grok backend (#2859 phase 2)', () => {
    it('enqueues a grok video job with the saved grok config and no local-python dependency', async () => {
      const { getSettings } = await import('../services/settings.js');
      // No local pythonPath at all — grok must not trip VIDEO_GEN_NOT_CONFIGURED.
      getSettings.mockResolvedValueOnce({ imageGen: { grok: { enabled: true, grokPath: '/opt/grok', aspectRatio: '16:9' } } });
      const r = await request(app).post('/api/video-gen/').send({
        backend: 'grok',
        prompt: 'a fox running through snow',
        grokDuration: '10',
        width: 1920,
        height: 1080,
      });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('queued');
      expect(r.body.mode).toBe('grok');
      expect(r.body.model).toBe('grok');
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'video',
        params: expect.objectContaining({
          mode: 'grok',
          videoMode: 'text',
          grokPath: '/opt/grok',
          aspectRatio: '16:9',
          prompt: 'a fox running through snow',
          duration: 10,
          width: 1920,
          height: 1080,
        }),
      }));
    });

    it('rejects when the grok toggle is disabled', async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce({ imageGen: { grok: { enabled: false } } });
      const r = await request(app).post('/api/video-gen/').send({ backend: 'grok', prompt: 'a fox' });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/disabled/i);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    it('rejects an unsupported grokDuration', async () => {
      const r = await request(app).post('/api/video-gen/').send({ backend: 'grok', prompt: 'a fox', grokDuration: 7 });
      expect(r.status).toBe(400);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    it('does not touch the grok path for default local renders', async () => {
      const r = await request(app).post('/api/video-gen/').send({ prompt: 'a cat' });
      expect(r.status).toBe(200);
      const [call] = mediaJobQueue.enqueueJob.mock.calls;
      expect(call[0].params.mode).not.toBe('grok');
    });
  });

  describe('POST / — extra reference images on a Grok image-to-video request', () => {
    const upload = (fieldname, name) => ({ fieldname, path: `/tmp/upload-${name}`, originalname: name, mimetype: 'image/png', size: 1024 });
    const source = upload('sourceImage', 'frame.png');
    const refs = [upload('referenceImage1', 'subject.png'), upload('referenceImage2', 'vehicle.png'), upload('referenceImage3', 'prop.png'), upload('referenceImage4', 'extra.png')];
    const unlinkedPaths = () => unlink.mock.calls.map(([p]) => p);
    const durableUnlinks = () => unlinkedPaths().filter((p) => /^[\\/]mock[\\/]uploads[\\/]/.test(p));
    const post = (body) => request(app).post('/api/video-gen/').send({ backend: 'grok', prompt: 'the subject walks forward', mode: 'image', ...body });
    const allowGrok = async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValue({ imageGen: { grok: { enabled: true, grokPath: '/opt/grok' } } });
    };
    afterEach(async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockImplementation(async () => ({ imageGen: { local: { pythonPath: '/usr/bin/python3' } } }));
    });

    it('queues the uploads as castReferences in slot order with their labels, owned by the job', async () => {
      await allowGrok();
      setPendingUpload(source, refs[1], refs[0]);
      const r = await post({ referenceLabel1: 'the subject - front view', referenceLabel2: '  a red vehicle  ' });
      expect(r.status).toBe(200);
      const { params } = mediaJobQueue.enqueueJob.mock.calls[0][0];
      const durable = () => expect.stringMatching(/^[\\/]mock[\\/]uploads[\\/]video-reference-[^\\/]+\.png$/);
      expect(params.castReferences).toEqual([
        { path: durable(), label: 'the subject - front view' },
        { path: durable(), label: 'a red vehicle' },
      ]);
      expect(params.uploadedTempPaths).toEqual(params.castReferences.map((ref) => ref.path));
      expect(params.uploadedTempPath).toBe(params.sourceImagePath);
      // Slot 1 was staged before slot 2 regardless of the order the parts arrived in.
      expect(copyFile.mock.calls.filter(([from]) => from !== source.path).map(([from]) => from))
        .toEqual([refs[0].path, refs[1].path]);
      expect(unlinkedPaths()).toEqual(expect.arrayContaining([refs[0].path, refs[1].path]));
      expect(durableUnlinks()).toEqual([]);
    });

    it('defaults a missing label to empty', async () => {
      await allowGrok();
      setPendingUpload(source, refs[0]);
      const r = await post({});
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob.mock.calls[0][0].params.castReferences).toEqual([expect.objectContaining({ label: '' })]);
    });

    it.each([
      ['a non-grok backend', { backend: 'local' }, [source, refs[0]], 'VIDEO_REFERENCE_IMAGES_GROK_ONLY'],
      ['no source image', {}, [refs[0]], 'VIDEO_REFERENCE_IMAGES_NEED_SOURCE'],
      ['more than three references', {}, [source, ...refs], 'VIDEO_REFERENCE_IMAGES_TOO_MANY'],
      ['a label with no image', { referenceLabel2: 'orphan' }, [source, refs[0]], 'VIDEO_REFERENCE_LABEL_ORPHANED'],
    ])('rejects %s with a 400 and removes every upload the parser wrote', async (_name, extra, uploads, code) => {
      await allowGrok();
      setPendingUpload(...uploads);
      const r = await post(extra);
      expect(r.status).toBe(400);
      expect(r.body.code).toBe(code);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      expect(copyFile).not.toHaveBeenCalled();
      expect(unlinkedPaths()).toEqual(expect.arrayContaining(uploads.map((file) => file.path)));
    });

    it('removes the uploads when the body fails validation (label too long)', async () => {
      await allowGrok();
      setPendingUpload(source, refs[0]);
      const r = await post({ referenceLabel1: 'x'.repeat(121) });
      expect(r.status).toBe(400);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      expect(unlinkedPaths()).toEqual(expect.arrayContaining([source.path, refs[0].path]));
    });

    it('unlinks every staged copy when a later reference fails to stage', async () => {
      await allowGrok();
      copyFile.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => {}).mockRejectedValueOnce(new Error('ENOSPC'));
      setPendingUpload(source, refs[0], refs[1]);
      const r = await post({});
      expect(r.status).toBe(500);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      expect(new Set(durableUnlinks()).size).toBe(3);
      expect(unlinkedPaths()).toEqual(expect.arrayContaining([source.path, refs[0].path, refs[1].path]));
    });
  });

  describe('POST /prompt-preview (#11317)', () => {
    const settings = {
      imageGen: { grok: { enabled: true, grokPath: '/example/grok', aspectRatio: '16:9' } },
      videoGen: { fal: { apiKey: 'example-fal-key' } },
    };
    const style = { id: 'style-preset', label: 'Style preset', text: 'film grain' };

    it.each([['aleph2', 'video-edit'], ['act_two', 'character-performance']])('previews empty-prompt %s using the default Runway backend without staging', async (runwayModelId, mode) => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce({ videoGen: { mode: 'runway', runway: { apiKey: 'example-key' } } });
      const response = await request(app).post('/api/video-gen/prompt-preview').send({
        mode, runwayModelId, prompt: '', previewUploads: ['runwayVideo', ...(runwayModelId === 'act_two' ? ['sourceImage'] : [])],
      });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ backend: 'runway', sentPrompt: '' });
      expect(copyFile).not.toHaveBeenCalled();
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    it.each([
      { backend: 'google', providerSettings: { apiKey: 'example-google-key', projectId: 'example-project' },
        form: { googleModelId: 'veo-3.1-generate-001', googleDuration: 8, googleResolution: '1080p', googleGenerateAudio: true } },
      { backend: 'higgsfield', providerSettings: { apiKey: 'example-higgsfield-key' },
        form: { higgsfieldModelId: 'bytedance/seedance-2.5', higgsfieldDuration: 5, higgsfieldResolution: '1080p',
          higgsfieldGenerateAudio: true, sourceImageFile: 'opening.png' } },
    ])('previews the same $backend prompt record the queued render uses', async ({ backend, providerSettings, form }) => {
      const { getSettings } = await import('../services/settings.js');
      const { googleVideoSentPrompt } = await import('../services/videoGen/google.js');
      const { higgsfieldVideoSentPrompt } = await import('../services/videoGen/higgsfield.js');
      const builders = { google: googleVideoSentPrompt, higgsfield: higgsfieldVideoSentPrompt };
      const providerConfig = { videoGen: { [backend]: providerSettings } };
      getSettings.mockResolvedValueOnce(providerConfig).mockResolvedValueOnce(providerConfig);
      const body = {
        backend, ...form, prompt: 'A fox runs through film grain', negativePrompt: 'motion blur',
        referenceImageFiles: ['fox.png', 'forest.png'], promptAdditions: [style],
      };

      const preview = await request(app).post('/api/video-gen/prompt-preview').send(body);
      expect(preview.status).toBe(200);
      expect(copyFile).not.toHaveBeenCalled();
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();

      const submitted = await request(app).post('/api/video-gen/').send(body);
      expect(submitted.status).toBe(200);
      const { params } = mediaJobQueue.enqueueJob.mock.calls[0][0];
      const { record } = builders[backend]({
        ...params, seconds: params.duration, hasImage: !!params.sourceImagePath,
        referenceCount: params.referenceImagePaths.length,
      });
      expect(preview.body).toEqual({ backend, ...record });
    });

    it('refuses an express-mode Google key in preview and submission', async () => {
      vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
      try {
        const { getSettings } = await import('../services/settings.js');
        const expressSettings = { videoGen: { google: { apiKey: 'example-google-key' } } };
        getSettings.mockResolvedValueOnce(expressSettings).mockResolvedValueOnce(expressSettings);
        const body = { backend: 'google', prompt: 'A fox runs' };

        const preview = await request(app).post('/api/video-gen/prompt-preview').send(body);
        const submitted = await request(app).post('/api/video-gen/').send(body);
        expect(preview.status).toBe(400);
        expect(submitted.status).toBe(400);
        expect(preview.body).toMatchObject({ code: 'GOOGLE_PROJECT_REQUIRED', error: expect.stringMatching(/express mode/) });
        expect(submitted.body).toMatchObject({ code: preview.body.code, error: preview.body.error });
        expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('shows the grok agent prompt, its instructions chip and the form\'s chips without queueing', async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce(settings);
      const r = await request(app).post('/api/video-gen/prompt-preview').send({
        backend: 'grok', prompt: 'a fox running, film grain', grokDuration: '10', promptAdditions: [style],
      });
      expect(r.status).toBe(200);
      expect(r.body.sentPrompt).toContain('a fox running, film grain');
      expect(r.body.sentPrompt).toContain('for 10 seconds');
      expect(r.body.promptAdditions).toEqual([style, expect.objectContaining({ label: 'Grok video tool instructions' })]);
      expect(r.body.promptAdditions[1].text).toContain('[prompt]');
      expect(r.body.promptAdditions[1].text).not.toContain('a fox running');
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    it('previews the reference_to_video prompt for held reference images and refuses them off Grok', async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValue(settings);
      const held = { backend: 'grok', prompt: 'the subject turns', previewUploads: ['sourceImage', 'referenceImage1'], referenceLabel1: 'the subject - front view' };
      const ok = await request(app).post('/api/video-gen/prompt-preview').send(held);
      expect(ok.status).toBe(200);
      expect(ok.body.sentPrompt).toContain('reference_to_video');
      expect(ok.body.sentPrompt).toContain('<IMAGE_1> shows how the subject looks');
      const refused = await request(app).post('/api/video-gen/prompt-preview').send({ ...held, backend: 'local' });
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('VIDEO_REFERENCE_IMAGES_GROK_ONLY');
      getSettings.mockImplementation(async () => ({ imageGen: { local: { pythonPath: '/usr/bin/python3' } } }));
    });

    it('previews the Grok shot prompt and cast inputs that the queued render sends', async () => {
      const { getSettings } = await import('../services/settings.js');
      const { grokVideoSentPrompt } = await import('../services/videoGen/grok.js');
      const scene = { sceneId: 's1', startSec: 0, endSec: 6, prompt: 'A person waves', camera: { move: 'slow-dolly-in' } };
      const project = { id: 'mv-1', scenes: [scene] };
      const refs = [{ path: '/mock/inputs/person.png', label: 'Person · young' }];
      getSettings.mockResolvedValueOnce(settings).mockResolvedValueOnce(settings);
      getMusicVideoProject.mockResolvedValueOnce(project).mockResolvedValueOnce(project).mockResolvedValueOnce(project).mockResolvedValueOnce(project).mockResolvedValueOnce(project).mockResolvedValueOnce(project);
      clipCastReferences.mockResolvedValueOnce(refs).mockResolvedValueOnce(refs);
      const body = { backend: 'grok', mode: 'image', prompt: 'A person waves', sourceImageFile: 'still.png', grokDuration: 6,
        musicVideo: { projectId: 'mv-1', sceneId: 's1', compose: true, promptAsTyped: true, expectedClipReferenceFiles: ['person.png'] } };
      const preview = await request(app).post('/api/video-gen/prompt-preview').send(body);
      expect(preview.status).toBe(200);
      expect(preview.body.sentPrompt).toContain('<IMAGE_1> shows how Person looks');
      expect(preview.body.sentPrompt).toContain('Set images to this character reference: input-2.png');
      expect(preview.body.sentPrompt).not.toContain('/mock/');
      expect(preview.body.promptAdditions).toContainEqual(expect.objectContaining({ id: 'agent-instructions' }));
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();

      const submitted = await request(app).post('/api/video-gen/').send(body);
      expect(submitted.status).toBe(200);
      const params = mediaJobQueue.enqueueJob.mock.calls[0][0].params;
      expect(preview.body.sentPrompt).toBe(grokVideoSentPrompt(params).record.sentPrompt);
      expect(params.castReferences).toEqual(refs);
    });

    it('resolves the project default and keeps an unconditioned Grok shot on image_to_video', async () => {
      const { getSettings } = await import('../services/settings.js');
      const project = { id: 'mv-1', scenes: [{ sceneId: 's1', prompt: 'A person waves' }] };
      getMusicVideoProject.mockResolvedValueOnce(project).mockResolvedValueOnce(project).mockResolvedValueOnce(project);
      getSettings.mockResolvedValueOnce({ ...settings, videoGen: { mode: 'grok' } }).mockResolvedValueOnce({ videoGen: { mode: 'local' } });
      const body = { mode: 'image', prompt: 'A person waves', sourceImageFile: 'still.png',
        musicVideo: { projectId: 'mv-1', sceneId: 's1', compose: true, promptAsTyped: true } };
      const grok = await request(app).post('/api/video-gen/prompt-preview').send(body);
      expect(grok.status).toBe(200);
      expect(grok.body.sentPrompt).toContain('image_to_video tool');
      expect(grok.body.sentPrompt).not.toContain('reference_to_video');
      const local = await request(app).post('/api/video-gen/prompt-preview').send(body);
      expect(local.body).toEqual({ backend: 'local', shotPreviewUnavailable: true });
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    it('refuses a fal prompt over the model cap with the same count the render gives', async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce(settings);
      const r = await request(app).post('/api/video-gen/prompt-preview').send({ backend: 'fal', prompt: 'x'.repeat(2001) });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/2,001 characters/);
    });

    it('refuses a LoRA the local render would refuse', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValueOnce(false);
      const r = await request(app).post('/api/video-gen/prompt-preview').send({ prompt: 'a fox', loraFilenames: ['missing-example.safetensors'] });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('LORA_NOT_FOUND');
    });

    it('refuses a backend that is switched off, as Generate does', async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce({ imageGen: { grok: { enabled: false } } });
      const r = await request(app).post('/api/video-gen/prompt-preview').send({ backend: 'grok', prompt: 'a fox' });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/disabled/i);
    });
  });

  describe('POST / — clip from a storyboard panel', () => {
    const settings = {
      imageGen: { grok: { enabled: true, grokPath: '/example/grok' } },
      videoGen: { fal: { apiKey: 'example-fal-key' } },
    };
    const guided = { prompt: 'she laces her skates', guidanceImageFile: 'panel.png', referenceImageFiles: ['cast.png', 'set.png'] };

    it('sends the panel as guidance and the references as the look on Grok, never as a start frame', async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce(settings);
      const r = await request(app).post('/api/video-gen/').send({ backend: 'grok', ...guided });
      expect(r.status).toBe(200);
      const { params } = mediaJobQueue.enqueueJob.mock.calls[0][0];
      expect(params).toMatchObject({ mode: 'grok', videoMode: 'text', sourceImagePath: null,
        guidanceImagePath: expect.stringMatching(/panel\.png$/), referenceImagePaths: [expect.stringMatching(/cast\.png$/), expect.stringMatching(/set\.png$/)] });
    });

    it('renders a fal guided clip on the Seedance reference model and refuses a start-frame model', async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValue(settings);
      const ok = await request(app).post('/api/video-gen/').send({ backend: 'fal', ...guided });
      expect(ok.status).toBe(200);
      expect(mediaJobQueue.enqueueJob.mock.calls[0][0].params).toMatchObject({
        modelId: 'bytedance/seedance-2.5/reference-to-video', guidanceImagePath: expect.stringMatching(/panel\.png$/) });
      const refused = await request(app).post('/api/video-gen/').send({ backend: 'fal', falModelId: 'bytedance/seedance-2.5/image-to-video', ...guided });
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('STORYBOARD_GUIDANCE_UNSUPPORTED');
      getSettings.mockReset();
    });

    it.each([
      ['a local render', { backend: 'local' }, 'STORYBOARD_GUIDANCE_UNSUPPORTED'],
      ['a start frame beside the panel', { backend: 'grok', sourceImageFile: 'frame.png' }, 'STORYBOARD_GUIDANCE_INVALID'],
    ])('refuses %s before enqueueing', async (_label, extra, code) => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce(settings);
      const r = await request(app).post('/api/video-gen/').send({ ...guided, ...extra });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe(code);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    it('previews the guidance chip with the prompt Grok receives', async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce(settings);
      const r = await request(app).post('/api/video-gen/prompt-preview').send({ backend: 'grok', ...guided });
      expect(r.status).toBe(200);
      const chip = r.body.promptAdditions.find((a) => a.id === 'storyboard-guidance');
      expect(chip.text).toMatch(/input-1\.png is a storyboard panel.*It is not the first frame/s);
      expect(r.body.sentPrompt).toContain(chip.text);
      expect(r.body.sentPrompt).toContain('image_edit');
    });
  });

  // Every throw path in POST / runs cleanupAllStaged()/cleanupTempUploads()
  // before it rethrows, and stageUploadDurable rolls its own half-written
  // destination back when copyFile rejects. None of that was asserted anywhere
  // — a regression that dropped the cleanup entirely would still return the
  // same status/body while leaking a 100MB durable copy under data/uploads on
  // every rejected request (#3289).
  describe('POST / — upload staging rollback (#3289)', () => {
    const sourceUpload = {
      fieldname: 'sourceImage',
      path: '/tmp/upload-frame.png',
      originalname: 'frame.png',
      mimetype: 'image/png',
      size: 2048,
    };
    const lastImageUpload = {
      fieldname: 'lastImage',
      path: '/tmp/upload-end-frame.png',
      originalname: 'end-frame.png',
      mimetype: 'image/png',
      size: 3072,
    };
    const audioUpload = {
      fieldname: 'audioFile',
      path: '/tmp/upload-beats.wav',
      originalname: 'beats.wav',
      mimetype: 'audio/wav',
      size: 1234,
    };
    const icUpload = {
      fieldname: 'icReference',
      path: '/tmp/upload-depth.mp4',
      originalname: 'depth.mp4',
      mimetype: 'video/mp4',
      size: 4321,
    };
    const unlinkedPaths = () => unlink.mock.calls.map(([p]) => p);
    // Durable copies live under PATHS.uploads (mocked to /mock/uploads); the
    // multipart temp files live under /tmp. Splitting them keeps the
    // "durable survives" assertion below from being satisfied by a temp unlink.
    const durableUnlinks = () => unlinkedPaths().filter((p) => /^[\\/]mock[\\/]uploads[\\/]/.test(p));

    it('drops multipart temp files when FableLoom render settings cannot be loaded', async () => {
      getLoom.mockRejectedValueOnce(new Error('record store unavailable'));
      setPendingUpload(sourceUpload);

      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'the threshold opens',
        mode: 'image',
        fableLoom: JSON.stringify({ loomId: 'loom-1', episodeId: 'ep-1', nodeId: 'node-1' }),
      });

      expect(r.status).toBe(500);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      expect(unlinkedPaths()).toContain(sourceUpload.path);
      expect(durableUnlinks()).toEqual([]);
    });

    it('unlinks the half-written destination AND every earlier staged copy when copyFile rejects', async () => {
      // sourceImage stages fine, audioFile's copy blows up — the failure has
      // to take BOTH the destination it was writing and the already-staged
      // sourceImage copy with it, since the job is never enqueued and the
      // worker's cleanup therefore never runs.
      copyFile
        .mockImplementationOnce(async () => {})
        .mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));
      setPendingUpload(sourceUpload, audioUpload);
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'beat-synced dancer',
        mode: 'a2v',
      });
      expect(r.status).toBe(500);
      expect(r.body.code).toBe('VIDEO_GEN_UPLOAD_STAGE_FAILED');
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      const unlinked = unlinkedPaths();
      expect(unlinked).toEqual(expect.arrayContaining([
        // the destination the failed copy may have partially written
        expect.stringMatching(/^[\\/]mock[\\/]uploads[\\/]video-audio-[^\\/]+\.wav$/),
        // …and the durable copy staged before it (stagedDurablePaths)
        expect.stringMatching(/^[\\/]mock[\\/]uploads[\\/]video-source-[^\\/]+\.png$/),
        // …and both multipart temp files
        sourceUpload.path,
        audioUpload.path,
      ]));
    });

    it('unlinks the pre-staged reference frame when the music-video scene lookup 404s', async () => {
      // Late-stage throw: the scene lookup runs AFTER the source frame has
      // already been copied into data/uploads.
      getMusicVideoProject.mockResolvedValueOnce(null);
      setPendingUpload(sourceUpload);
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'rain pulses with the percussion',
        mode: 'a2v',
        musicVideo: { projectId: 'mv-example', sceneId: 'scene-missing' },
      });
      expect(r.status).toBe(404);
      expect(r.body.code).toBe('NOT_FOUND');
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      expect(unlinkedPaths()).toEqual(expect.arrayContaining([
        expect.stringMatching(/^[\\/]mock[\\/]uploads[\\/]video-source-[^\\/]+\.png$/),
        sourceUpload.path,
      ]));
    });

    it('unlinks the pre-staged IC reference and source frame when a later validation throws', async () => {
      // keyframes are rejected for any non-fflf mode — by then both the source
      // frame and the IC reference clip are staged under data/uploads.
      setPendingUpload(sourceUpload, icUpload);
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'follow the depth clip',
        mode: 'ic-control',
        keyframes: [{ file: 'a.png', index: 0 }, { file: 'b.png', index: 24 }],
      });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('KEYFRAMES_MODE_MISMATCH');
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      expect(unlinkedPaths()).toEqual(expect.arrayContaining([
        expect.stringMatching(/^[\\/]mock[\\/]uploads[\\/]video-source-[^\\/]+\.png$/),
        expect.stringMatching(/^[\\/]mock[\\/]uploads[\\/]video-ic-ref-[^\\/]+\.mp4$/),
        sourceUpload.path,
        icUpload.path,
      ]));
    });

    it('unlinks both staged frames when an FFLF request mixes legacy inputs with keyframes', async () => {
      // lastImage is the one upload field with no rollback coverage above —
      // it stages between the source frame and the audio/IC fields, so a
      // durable copy that never made it into stagedDurablePaths would leak
      // here alone while every other case stayed green.
      setPendingUpload(sourceUpload, lastImageUpload);
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'morph between the anchors',
        mode: 'fflf',
        keyframes: [{ file: 'a.png', index: 0 }, { file: 'b.png', index: 24 }],
      });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('KEYFRAMES_LEGACY_INPUTS_CONFLICT');
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      expect(unlinkedPaths()).toEqual(expect.arrayContaining([
        expect.stringMatching(/^[\\/]mock[\\/]uploads[\\/]video-source-[^\\/]+\.png$/),
        expect.stringMatching(/^[\\/]mock[\\/]uploads[\\/]video-last-[^\\/]+\.png$/),
        sourceUpload.path,
        lastImageUpload.path,
      ]));
    });

    it('drops only the OS temp file on the happy path — the durable copy survives for the worker', async () => {
      setPendingUpload(sourceUpload);
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a fox running through snow',
        mode: 'image',
      });
      expect(r.status).toBe(200);
      // Pin the durable copy as actually having happened, and to the exact
      // destination the job was handed. Asserting only "nothing under
      // /mock/uploads was unlinked" would pass just as well if staging were
      // skipped altogether — there'd be no durable path to unlink.
      expect(copyFile).toHaveBeenCalledWith(
        sourceUpload.path,
        expect.stringMatching(/^[\\/]mock[\\/]uploads[\\/]video-source-[^\\/]+\.png$/),
      );
      const [, durableDest] = copyFile.mock.calls[0];
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        params: expect.objectContaining({
          sourceImagePath: durableDest,
          uploadedTempPath: durableDest,
        }),
      }));
      expect(unlinkedPaths()).toContain(sourceUpload.path);
      // The queue worker owns the durable copy's lifetime — unlinking it here
      // would hand the worker a path that no longer exists.
      expect(durableUnlinks()).toEqual([]);
    });
  });

  describe('POST / — federated media provider', () => {
    it('submits to the selected peer and keeps the prompt inside the versioned marker', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a slow pan across a harbour',
        modelId: 'ltx2',
        numFrames: 121,
        fps: 24,
        mediaProviderPeerId: federatedPeerId,
      });

      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        jobId: 'mock-video-job',
        // No local backend renders this, so `mode` must not name one.
        mode: null,
        model: 'ltx2',
        mediaProviderPeerId: federatedPeerId,
      });
      expect(prepareRemoteMediaJob).toHaveBeenCalledWith({
        peerId: federatedPeerId,
        kind: 'video',
        request: {
          kind: 'video',
          engine: 'local',
          modelId: 'ltx2',
          prompt: 'a slow pan across a harbour',
          numFrames: 121,
          fps: 24,
        },
        // A text-to-video render carries none, but the field is always passed —
        // an empty list and an absent one must read the same to the submitter.
        inputAssets: [],
      });

      const [{ params }] = mediaJobQueue.enqueueJob.mock.calls[0];
      // Prompt and dials ride only inside the versioned marker; no local render
      // input is carried over at all. enqueueJob owns blanking the rest (#4683)
      // — its own suites cover that, and enqueueJob is mocked here.
      expect(params).toEqual({ remoteMedia: expect.objectContaining({ peerId: federatedPeerId }) });
      expect(params.remoteMedia.request.prompt).toBe('a slow pan across a harbour');
      expect(params.remoteMedia.request.modelId).toBe('ltx2');
    });

    it('requires an explicit provider model instead of falling back to a local default', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a slow pan across a harbour',
        mediaProviderPeerId: federatedPeerId,
      });

      expect(r.status).toBe(400);
      expect(r.body.code).toBe('MEDIA_PROVIDER_MODEL_REQUIRED');
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    // A start frame is single-render conditioning and now crosses (ADR
    // docs/decisions/2026-08-22-federated-media-input-assets.md rule 1) — as a
    // LOCAL path handed to the submitter, which uploads it through the
    // provider's digest-verified asset endpoint immediately before submitting.
    it('routes a start frame to the peer as conditioning rather than refusing it', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a slow pan across a harbour',
        modelId: 'ltx2',
        sourceImageFile: 'frame.png',
        mediaProviderPeerId: federatedPeerId,
      });

      expect(r.status).toBe(200);
      expect(prepareRemoteMediaJob).toHaveBeenCalledWith(expect.objectContaining({
        inputAssets: [{ role: 'sourceImage', path: 'frame.png' }],
      }));
    });

    // Both frames reach the submitter as LOCAL paths for it to stage. The
    // "an end frame needs a start frame" rule is NOT asserted here: it moved
    // into the shared inputAssetRejection, which every lane funnels through and
    // which this suite mocks out — see remoteSubmission.test.js for its guard.
    it('hands a first-last-frame pair to the submitter as local paths', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a slow pan across a harbour',
        modelId: 'ltx2',
        mode: 'fflf',
        sourceImageFile: 'start.png',
        lastImageFile: 'end.png',
        mediaProviderPeerId: federatedPeerId,
      });

      expect(r.status).toBe(200);
      expect(prepareRemoteMediaJob).toHaveBeenCalledWith(expect.objectContaining({
        inputAssets: [
          { role: 'sourceImage', path: 'start.png' },
          { role: 'lastImage', path: 'end.png' },
        ],
      }));
    });

    // A LoRA is a MODEL, not conditioning, and remote model installation is out
    // of scope for federation (rule 3). This one stays a refusal on purpose.
    it('refuses a federated render that carries LoRA weights', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a slow pan across a harbour',
        modelId: 'ltx2',
        loraFilenames: ['style.safetensors'],
        mediaProviderPeerId: federatedPeerId,
      });

      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/LoRA weights/);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      expect(prepareRemoteMediaJob).not.toHaveBeenCalled();
    });

    // A loose reference (#4874) is a per-runtime capability this side cannot
    // verify on the peer — and an older peer's wire schema strips the field
    // outright. Shipping it would return an anchored clip under an Inspire
    // label, so the request is refused rather than silently downgraded.
    it('refuses a federated render that asks for a loose reference mode', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a slow pan across a harbour',
        modelId: 'ltx2',
        mode: 'image',
        sourceImageFile: 'frame.png',
        i2vReferenceMode: 'inspire',
        mediaProviderPeerId: federatedPeerId,
      });

      expect(r.status).toBe(400);
      expect(r.body.code).toBe('MEDIA_PROVIDER_INPUT_UNSUPPORTED');
      expect(r.body.error).toMatch(/loose reference mode/);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      expect(prepareRemoteMediaJob).not.toHaveBeenCalled();
    });

    // The default is not a capability claim, so it must NOT block a federated
    // render — an over-broad guard here would refuse every ordinary i2v submit.
    it('still routes a federated i2v render that leaves the reference mode at the default', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a slow pan across a harbour',
        modelId: 'ltx2',
        mode: 'image',
        sourceImageFile: 'frame.png',
        i2vReferenceMode: 'anchor',
        mediaProviderPeerId: federatedPeerId,
      });

      expect(r.status).toBe(200);
      expect(prepareRemoteMediaJob).toHaveBeenCalled();
    });

    it('refuses a federated chained render rather than shipping one unchained clip', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a slow pan across a harbour',
        modelId: 'ltx2',
        chunks: 3,
        mediaProviderPeerId: federatedPeerId,
      });

      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/chained chunks/);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });
  });

  describe('warm video batch submission', () => {
    it('queues one coerced batch with seed zero and rejects unsupported or overflowing requests', async () => {
      const models = vi.mocked(videoGenService.listVideoModels);
      models.mockReturnValue([
        { id: 'example-h3', name: 'Example H3', runtime: 'minimax_h3', defaultFrames: 124, frameOptions: [124], fpsOptions: [24] },
        { id: 'example-ltx', runtime: 'ltx2' },
      ]);
      const response = await request(app).post('/api/video-gen/').send({
        prompt: 'Example shot', modelId: 'example-h3', batchSize: '3', seed: '0',
      });
      expect(response.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledTimes(1);
      expect(mediaJobQueue.enqueueJob.mock.calls[0][0].params).toMatchObject({ batchSize: 3, seed: 0 });
      for (const overrides of [{ batchSize: 1.5 }, { batchSize: 21 }, { seed: 2 ** 32 - 1 }, { modelId: 'example-ltx' }, { backend: 'fal' }, { chunks: 2 }, { mediaProviderPeerId: 'peer' }]) {
        const rejected = await request(app).post('/api/video-gen/').send({ prompt: 'Example shot', modelId: 'example-h3', batchSize: 3, ...overrides });
        expect(rejected.status).toBe(400);
      }
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledTimes(1);
    });
  });
});
