import { resolveContinuityRequest } from '../../lib/videoContinuity.js';
import { describe, expect, it } from 'vitest';
import { sanitizeJob } from './sanitizeJob.js';

describe('sanitizeJob', () => {
  it('projects bounded continuation evidence without worker paths or unsupported nested values', () => {
    const continuation = resolveContinuityRequest({ model: { runtime: 'minimax_h3' }, continuityStrategy: 'frame' });
    const projected = sanitizeJob({ kind: 'video', params: { continuityStrategy: 'frame', continuation: {
      ...continuation, sourceVideoPath: '/private/original.mp4', scratch: '/private/scratch.mp4',
    } } });
    expect(projected.params).toMatchObject({ continuityStrategy: 'frame', continuation });
    expect(JSON.stringify(projected)).not.toContain('/private');
    const malformed = sanitizeJob({ kind: 'video', params: { continuityStrategy: { sourcePath: '/private/input.mp4' }, continuation: {
      ...continuation, actualHistoryFrames: 999999,
    } } });
    expect(malformed.params).not.toHaveProperty('continuation');
    expect(malformed.params).not.toHaveProperty('continuityStrategy');
    const historical = sanitizeJob({ kind: 'video', params: { continuation: {
      ...continuation, backendPin: 'diffusers==0.41.0', unavailableReason: 'The prior adapter lacked a verified history contract.',
    } } });
    expect(historical.params.continuation).toMatchObject({ backendPin: 'diffusers==0.41.0', unavailableReason: 'The prior adapter lacked a verified history contract.' });
    const unsafe = sanitizeJob({ kind: 'video', params: { continuation: {
      ...continuation, backendPin: '/private/runtime', unavailableReason: 'Source missing: /tmp/private-input.mp4',
    } } });
    expect(unsafe.params.continuation).toMatchObject({ backendPin: null, unavailableReason: null });
  });

  it('exposes requested reference filenames without leaking local paths or inferring missing history', () => {
    const params = { initImagePath: '/private/gallery/source.png', referenceImagePaths: [
      'C:\\private\\refs\\character.png', '/private/refs/character.png', null, '/private/secret.txt',
    ] };
    const local = sanitizeJob({ kind: 'image', params });
    expect(local.requestedInputImages).toEqual([
      { role: 'initImage', filename: 'source.png' },
      { role: 'referenceImages', filename: 'character.png' },
      { role: 'referenceImages', filename: 'character.png' },
    ]);
    expect(local.params).not.toHaveProperty('initImagePath');
    expect(local.params).not.toHaveProperty('referenceImagePaths');
    expect(sanitizeJob({ kind: 'image', params: {} })).not.toHaveProperty('requestedInputImages');
    const remote = sanitizeJob({ kind: 'image', params: { remoteMedia: {
      wireVersion: 1, peerId: 'example-peer', request: { kind: 'image' },
      inputAssets: [{ role: 'referenceImages', path: '/private/gallery/reference.webp' }],
    } } });
    expect(remote.requestedInputImages).toEqual([{ role: 'referenceImages', filename: 'reference.webp' }]);
    expect(JSON.stringify(remote)).not.toContain('/private');
  });

  it('projects cancellation only while the job is still active', () => {
    const projectCancellation = (status) => sanitizeJob({
      id: 'job-cancel-example',
      kind: 'image',
      status,
      cancelRequested: true,
    }).cancelRequested;

    expect(projectCancellation('running')).toBe(true);
    // Remote cancellation recovery can restore an active job in the queue.
    expect(projectCancellation('queued')).toBe(true);
    expect(projectCancellation('completed')).toBe(false);
    expect(projectCancellation('canceled')).toBe(false);
    expect(projectCancellation('failed')).toBe(false);
  });

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
  it('projects the scheduler execution lane for every video backend, with remote winning', () => {
    const laneOf = (job) => sanitizeJob({ id: 'job', status: 'running', ...job }).executionLane;

    // Local video's mode is a semantic pipeline value, not a backend name.
    expect(laneOf({ kind: 'video', params: { mode: 'text' } })).toBe('gpu');
    expect(laneOf({ kind: 'video', params: { mode: 'grok' } })).toBe('cloud');
    // fal/Reactor were the drift: shipped cloud backends the UI filed as local.
    expect(laneOf({ kind: 'video', params: { mode: 'fal' } })).toBe('cloud');
    expect(laneOf({ kind: 'video', params: { mode: 'reactor' } })).toBe('cloud');
    expect(laneOf({ kind: 'image', params: { mode: 'codex' } })).toBe('cloud');
    expect(laneOf({ kind: 'image', params: { mode: 'local' } })).toBe('gpu');
    // A routed job runs on a peer whatever backend it names.
    expect(laneOf({
      kind: 'video',
      params: { mode: 'fal', remoteMedia: { wireVersion: 1, request: { modelId: 'peer-model' } } },
    })).toBe('remote');
  });

  it('keeps the renderer field alongside the new lane so an older client still reads it', () => {
    const sanitized = sanitizeJob({ id: 'job-fal', kind: 'video', status: 'running', params: { mode: 'fal', modelId: 'provider/video' } });

    expect(sanitized.renderer).toBe('local');
    expect(sanitized.executionLane).toBe('cloud');
  });

  it('explains a queued job held behind an unsettled earlier peer job, and only while queued', () => {
    const peerHold = { reason: 'peer-settling', blockingJobId: 'job-earlier-example', internal: 'x' };
    const held = sanitizeJob({ id: 'job-held-example', kind: 'video', status: 'queued', statusMsg: 'Queued', peerHold });
    expect(held.peerHold).toEqual({ reason: 'peer-settling', blockingJobId: 'job-earlier-example' });
    expect(held.statusMsg).toBe('Waiting for peer to settle an earlier job');
    const running = sanitizeJob({ id: 'job-held-example', kind: 'video', status: 'running', statusMsg: 'Starting', peerHold });
    expect(running).not.toHaveProperty('peerHold');
    expect(running.statusMsg).toBe('Starting');
  });
});
