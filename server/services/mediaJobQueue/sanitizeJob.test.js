import { describe, expect, it } from 'vitest';
import { sanitizeJob } from './sanitizeJob.js';

describe('sanitizeJob', () => {
  it('projects only validated image execution provenance from a completed result', () => {
    const sanitized = sanitizeJob({
      id: 'image-job',
      kind: 'image',
      status: 'completed',
      result: {
        filename: 'image.png',
        executionProvenance: {
          version: 1,
          state: 'confirmed',
          requestedDevice: 'auto',
          effectiveDevice: 'cuda',
          placement: 'cuda+offload',
          cpuFallback: false,
          runtime: { runtime: 'diffusers-image', versions: { torch: '2.7.0', prompt: 'private' } },
        },
      },
    });
    expect(sanitized.result.executionProvenance).toEqual({
      version: 1,
      state: 'confirmed',
      requestedDevice: 'auto',
      effectiveDevice: 'cuda',
      placement: 'cuda+offload',
      cpuFallback: false,
      runtime: { runtime: 'diffusers-image', versions: { torch: '2.7.0' } },
    });
  });

  it('does not leak an invalid execution marker into the public queue result', () => {
    const sanitized = sanitizeJob({ id: 'image-job', kind: 'image', status: 'completed', result: { executionProvenance: { state: 'confirmed', prompt: 'private' } } });
    expect(sanitized.result).not.toHaveProperty('executionProvenance');
  });

  it('exposes safe video retry configuration fields', () => {
    const sanitized = sanitizeJob({
      id: 'video-job',
      kind: 'video',
      status: 'failed',
      params: {
        modelId: 'example-video-model',
        textEncoderId: 'example-encoder',
        speedProfileId: 'fast',
        draftDecode: 'draft',
        chunks: 2,
        chunkPrompts: ['opening', 'climax'],
        contextFrames: 12,
        loras: [{ filename: 'example-style.safetensors', scale: 0.8 }],
        pythonPath: '/private/internal/python',
      },
    });

    expect(sanitized.params).toEqual({
      modelId: 'example-video-model',
      textEncoderId: 'example-encoder',
      // #4875 — a profile OUTRANKS steps/CFG, so a queue row that hid it would
      // display an unused `steps` value and the retry editor would have no way
      // to see (or drop) the schedule actually driving the render.
      speedProfileId: 'fast',
      // #5449 — the requeue editor seeds its decode picker from this. Hidden,
      // every requeue would silently snap back to Full instead of re-submitting
      // the preview-fidelity decode the job actually asked for.
      draftDecode: 'draft',
      chunks: 2,
      chunkPrompts: ['opening', 'climax'],
      contextFrames: 12,
      loras: [{ filename: 'example-style.safetensors', scale: 0.8 }],
    });
  });

  it('projects the resolved render geometry on the envelope, distinct from the requested params', () => {
    // #4588: `params.width/height` is what was ASKED for; `render` is what the
    // gen module resolved to after snapping to the model grid. A preview stage
    // has to size itself by the latter.
    const sanitized = sanitizeJob({
      id: 'video-job',
      kind: 'video',
      status: 'running',
      render: { width: 704, height: 480 },
      params: { width: 720, height: 484 },
    });
    expect(sanitized.render).toEqual({ width: 704, height: 480 });
    expect(sanitized.params).toEqual({ width: 720, height: 484 });
  });

  it('leaves render absent — not zeroed — when the run never reported a geometry', () => {
    expect(sanitizeJob({ id: 'j', kind: 'video', status: 'queued' }).render).toBeUndefined();
  });
  it('exposes instrumental mode without leaking authored Music Studio text', () => {
    const job = sanitizeJob({
      id: 'job-1',
      kind: 'audio',
      status: 'running',
      params: {
        prompt: 'safe conditioning prompt',
        lyrics: 'private lyric draft',
        musicStudio: {
          trackId: 'track-1',
          authoredPrompt: 'private source prompt',
          authoredLyrics: 'private lyric draft',
          instrumentalOnly: true,
        },
      },
    });

    expect(job.params.musicStudio).toEqual({ trackId: 'track-1', instrumentalOnly: true });
    expect(job.params).not.toHaveProperty('lyrics');
  });

  it('restores the public prompt without exposing private peer routing fields', () => {
    const sanitized = sanitizeJob({
      id: 'job-example',
      kind: 'audio',
      status: 'queued',
      params: {
        // Blank/nulled by routedJobParams, exactly as the queue persists it —
        // if the fixture carried the model id here too, the marker rebuild
        // below could stop working and this test would still pass.
        prompt: '',
        modelId: null,
        remoteMedia: {
          wireVersion: 1,
          peerId: '00000000-0000-4000-8000-000000000001',
          profile: {
            style: 'orchestral',
            mood: 'triumphant',
            tempo: 'moderate',
            energy: 'high',
            instruments: ['brass', 'strings'],
          },
          request: {
            engine: 'remote-audio',
            modelId: 'example/model',
          },
        },
      },
    });

    expect(sanitized.params).toEqual({
      prompt: 'Instrumental orchestral music with a triumphant mood, moderate tempo, high energy, featuring brass and strings. No vocals or spoken words.',
      modelId: 'example/model',
    });
    expect(sanitized.renderer).toBe('remote');
    expect(sanitized.params).not.toHaveProperty('remoteMedia');
  });

  it('restores an image/video remote job prompt and model from its marker, not from params', () => {
    const sanitized = sanitizeJob({
      id: 'job-image',
      kind: 'image',
      status: 'running',
      params: {
        // Blank/nulled on purpose: the prompt and the model live only inside
        // the versioned marker so an older build that cannot route it fails
        // closed instead of rendering (#4683).
        prompt: '',
        modelId: null,
        width: 512,
        height: 512,
        remoteMedia: {
          wireVersion: 1,
          peerId: '00000000-0000-4000-8000-000000000001',
          request: {
            kind: 'image',
            engine: 'local',
            modelId: 'dev',
            prompt: 'a lighthouse at dusk',
            width: 512,
            height: 512,
          },
        },
      },
    });

    expect(sanitized.params).toEqual({
      prompt: 'a lighthouse at dusk',
      modelId: 'dev',
      width: 512,
      height: 512,
    });
    expect(sanitized.params).not.toHaveProperty('remoteMedia');
    // Job metadata, not a render input — the Render Queue badges this
    // 'remote / dev' rather than claiming a local render produced it.
    expect(sanitized.renderer).toBe('remote');
    expect(sanitized.params).not.toHaveProperty('renderer');
  });

  it('reports a local job as locally rendered', () => {
    const sanitized = sanitizeJob({
      id: 'job-local',
      kind: 'image',
      status: 'running',
      params: { prompt: 'a lighthouse at dusk', modelId: 'dev' },
    });

    expect(sanitized.params).toEqual({ prompt: 'a lighthouse at dusk', modelId: 'dev' });
    expect(sanitized.renderer).toBe('local');
  });

  it('reports a training job carrying a stray marker as local — training has no federated contract', () => {
    const sanitized = sanitizeJob({
      id: 'job-training',
      kind: 'training',
      status: 'running',
      params: {
        runId: 'run-1',
        runtime: 'mflux',
        modelId: 'dev',
        remoteMedia: { wireVersion: 1, request: { modelId: 'peer-model' } },
      },
    });

    expect(sanitized.renderer).toBe('local');
    // The marker must not rewrite a local training job's model either.
    expect(sanitized.params.modelId).toBe('dev');
  });
});
