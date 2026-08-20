import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSettings = vi.fn();
const prepareRemoteMediaJob = vi.fn();

vi.mock('../settings.js', () => ({ getSettings: (...args) => getSettings(...args) }));
vi.mock('./remoteSubmission.js', () => ({
  prepareRemoteMediaJob: (...args) => prepareRemoteMediaJob(...args),
}));

const enqueueJob = vi.fn(() => ({ jobId: 'mj-test' }));
vi.mock('../mediaJobQueue/index.js', () => ({ enqueueJob: (...args) => enqueueJob(...args) }));

const {
  normalizeMediaRoutingConfig, resolveDefaultMediaRoute, routedJobParams,
  enqueueUnattendedMediaJob, hasConfiguredMediaRoute,
} = await import('./defaultRouting.js');

const route = { peerId: 'peer-1', engine: 'comfy', modelId: 'sdxl-remote' };
const withRoute = (mediaRouting) => ({ federation: { mediaRouting } });

beforeEach(() => {
  getSettings.mockReset();
  enqueueJob.mockClear();
  prepareRemoteMediaJob.mockReset();
  prepareRemoteMediaJob.mockImplementation(async ({ peerId, kind, request }) => ({
    peer: { id: peerId },
    remoteMedia: { wireVersion: 1, peerId, reconcile: false, cancelRequested: false, request },
  }));
});

describe('normalizeMediaRoutingConfig', () => {
  it('reads nothing as no routes', () => {
    expect(normalizeMediaRoutingConfig(undefined)).toEqual({ image: null, video: null });
    expect(normalizeMediaRoutingConfig({ federation: {} })).toEqual({ image: null, video: null });
  });

  it('keeps a fully specified route and trims it', () => {
    expect(normalizeMediaRoutingConfig(withRoute({ image: { peerId: ' p ', engine: ' e ', modelId: ' m ' } })).image)
      .toEqual({ peerId: 'p', engine: 'e', modelId: 'm' });
  });

  it('treats a half-written route as no route rather than peer-plus-any-model', () => {
    for (const partial of [{ peerId: 'p' }, { peerId: 'p', engine: 'e' }, { engine: 'e', modelId: 'm' }, { peerId: 'p', engine: '  ', modelId: 'm' }]) {
      expect(normalizeMediaRoutingConfig(withRoute({ image: partial })).image).toBeNull();
    }
  });

  it('drops a kind this build cannot execute so it stays local', () => {
    const config = normalizeMediaRoutingConfig(withRoute({ audio: route, image: route }));
    expect(config).not.toHaveProperty('audio');
    expect(config.image).toEqual(route);
  });
});

describe('resolveDefaultMediaRoute', () => {
  it('returns null for an unroutable kind without reading settings', async () => {
    await expect(resolveDefaultMediaRoute({ kind: 'audio', params: { prompt: 'p' } })).resolves.toBeNull();
    expect(getSettings).not.toHaveBeenCalled();
  });

  it('returns null when the kind has no configured route', async () => {
    getSettings.mockResolvedValue(withRoute({ video: route }));
    await expect(resolveDefaultMediaRoute({ kind: 'image', params: { prompt: 'p', modelId: 'local-sdxl' } }))
      .resolves.toBeNull();
    expect(prepareRemoteMediaJob).not.toHaveBeenCalled();
  });

  it('routes to the configured peer and overrides the planner model with the route model', async () => {
    getSettings.mockResolvedValue(withRoute({ image: route }));
    const resolved = await resolveDefaultMediaRoute({
      kind: 'image',
      params: { prompt: 'a lighthouse', modelId: 'local-sdxl', width: 512, height: 512 },
    });
    expect(prepareRemoteMediaJob).toHaveBeenCalledWith(expect.objectContaining({ peerId: 'peer-1', kind: 'image' }));
    expect(resolved.request).toMatchObject({ engine: 'comfy', modelId: 'sdxl-remote', prompt: 'a lighthouse' });
    expect(resolved.peer.id).toBe('peer-1');
  });

  it('fails closed instead of rendering locally when the provider rejects the preflight', async () => {
    getSettings.mockResolvedValue(withRoute({ video: route }));
    prepareRemoteMediaJob.mockRejectedValue(Object.assign(new Error('Media provider is at capacity'), { code: 'MEDIA_PROVIDER_BUSY' }));
    await expect(resolveDefaultMediaRoute({ kind: 'video', params: { prompt: 'a balloon' } }))
      .rejects.toThrow('Media provider is at capacity');
  });

  it('rejects a promptless routed job with a typed error', async () => {
    getSettings.mockResolvedValue(withRoute({ image: route }));
    await expect(resolveDefaultMediaRoute({ kind: 'image', params: { prompt: '   ' } }))
      .rejects.toMatchObject({ code: 'MEDIA_PROVIDER_PROMPT_REQUIRED' });
    expect(prepareRemoteMediaJob).not.toHaveBeenCalled();
  });
});

describe('routedJobParams', () => {
  const resolved = {
    request: { modelId: 'sdxl-remote' },
    remoteMedia: { peerId: 'peer-1' },
  };

  it('blanks the prompt so a build that cannot read the marker fails closed', () => {
    expect(routedJobParams({ prompt: 'a lighthouse' }, resolved).prompt).toBe('');
  });

  it('drops local-only dispatch params that no local backend will run', () => {
    const params = routedJobParams({
      prompt: 'p', mode: 'local', backend: 'comfy', pythonPath: '/x/py',
      cloudModel: 'grok', mediaProviderPeerId: 'other', mediaProviderEngine: 'local',
    }, resolved);
    for (const key of ['mode', 'backend', 'pythonPath', 'cloudModel', 'mediaProviderPeerId', 'mediaProviderEngine']) {
      expect(params).not.toHaveProperty(key);
    }
  });

  it('preserves destination tags so completion hooks still fire', () => {
    const params = routedJobParams({
      prompt: 'p',
      creativeDirectorSceneImage: { projectId: 'proj-1', sceneId: 'scene-2' },
      catalogAttach: { id: 'ing-1' },
    }, resolved);
    expect(params.creativeDirectorSceneImage).toEqual({ projectId: 'proj-1', sceneId: 'scene-2' });
    expect(params.catalogAttach).toEqual({ id: 'ing-1' });
    expect(params.remoteMedia).toEqual({ peerId: 'peer-1' });
    expect(params.modelId).toBe('sdxl-remote');
  });
});

// #4348 review follow-ups.
describe('routed conditioning guard', () => {
  const route = { peerId: 'peer-1', engine: 'comfy', modelId: 'sdxl-remote' };

  beforeEach(() => {
    getSettings.mockResolvedValue({ federation: { mediaRouting: { image: route, video: route } } });
  });

  // The interactive routes reject these rather than dropping them, because a
  // render that silently ignores its source image comes back plausible and
  // wrong. Unattended work has nobody watching, so the guard matters more here.
  it.each([
    ['initImagePath', { initImagePath: '/x/a.png' }, 'an init image'],
    ['sourceImagePath', { sourceImagePath: '/x/a.png' }, 'a source image'],
    ['referenceImagePaths', { referenceImagePaths: ['/x/a.png'] }, 'reference images'],
    ['loraFilenames', { loraFilenames: ['style.safetensors'] }, 'LoRA weights'],
    ['keyframes', { keyframes: [{ at: 0 }] }, 'keyframes'],
  ])('refuses a routed image job carrying %s', async (_name, extra, label) => {
    await expect(resolveDefaultMediaRoute({ kind: 'image', params: { prompt: 'p', ...extra } }))
      .rejects.toMatchObject({ code: 'MEDIA_PROVIDER_INPUT_UNSUPPORTED' });
    await expect(resolveDefaultMediaRoute({ kind: 'image', params: { prompt: 'p', ...extra } }))
      .rejects.toThrow(new RegExp(label));
    expect(prepareRemoteMediaJob).not.toHaveBeenCalled();
  });

  it('refuses a chained multi-chunk video, which the provider cannot continue', async () => {
    await expect(resolveDefaultMediaRoute({ kind: 'video', params: { prompt: 'p', chunks: 3 } }))
      .rejects.toThrow(/chained chunks/);
  });

  it('allows an empty or single-chunk value through', async () => {
    await expect(resolveDefaultMediaRoute({
      kind: 'video',
      params: { prompt: 'p', chunks: 1, referenceImagePaths: [], loraFilenames: [] },
    })).resolves.toMatchObject({ peer: { id: 'peer-1' } });
  });
});

describe('enqueueUnattendedMediaJob', () => {
  const route = { peerId: 'peer-1', engine: 'comfy', modelId: 'sdxl-remote' };

  // Every autonomous render path funnels through this helper. If one call site
  // kept calling enqueueJob directly, a configured route would apply to some of
  // a project's shots and not others, with no indication why they don't match.
  it('enqueues locally, untouched, when the kind has no route', async () => {
    getSettings.mockResolvedValue({});
    await enqueueUnattendedMediaJob({ kind: 'image', params: { prompt: 'p' }, owner: 'cd:1' });
    expect(enqueueJob).toHaveBeenCalledWith({ kind: 'image', params: { prompt: 'p' }, owner: 'cd:1' });
  });

  it('enqueues the routed marker when the kind has a route', async () => {
    getSettings.mockResolvedValue({ federation: { mediaRouting: { image: route } } });
    await enqueueUnattendedMediaJob({ kind: 'image', params: { prompt: 'p' }, owner: 'cd:1' });
    const { params } = enqueueJob.mock.calls.at(-1)[0];
    expect(params.prompt).toBe('');
    expect(params.remoteMedia.request.prompt).toBe('p');
  });

  it('omits owner entirely when the caller passed none', async () => {
    getSettings.mockResolvedValue({});
    await enqueueUnattendedMediaJob({ kind: 'audio', params: { prompt: 'p' } });
    expect(enqueueJob.mock.calls.at(-1)[0]).not.toHaveProperty('owner');
  });

  it('propagates a provider rejection instead of falling back to a local enqueue', async () => {
    getSettings.mockResolvedValue({ federation: { mediaRouting: { video: route } } });
    prepareRemoteMediaJob.mockRejectedValue(new Error('Media provider is at capacity'));
    await expect(enqueueUnattendedMediaJob({ kind: 'video', params: { prompt: 'p' } }))
      .rejects.toThrow('Media provider is at capacity');
    expect(enqueueJob).not.toHaveBeenCalled();
  });
});

describe('semantic controls the wire cannot carry', () => {
  const route = { peerId: 'peer-1', engine: 'comfy', modelId: 'wan-remote' };

  beforeEach(() => {
    getSettings.mockResolvedValue({ federation: { mediaRouting: { video: route, image: route } } });
  });

  // Not conditioning, but still the opposite of what was asked for: the wire
  // can't say "no audio", so the provider renders a clip WITH audio.
  it('refuses a routed video that asked for a silent render', async () => {
    await expect(resolveDefaultMediaRoute({ kind: 'video', params: { prompt: 'p', disableAudio: true } }))
      .rejects.toMatchObject({ code: 'MEDIA_PROVIDER_INPUT_UNSUPPORTED' });
  });

  it('allows the common disableAudio:false, which matches the provider default anyway', async () => {
    await expect(resolveDefaultMediaRoute({ kind: 'video', params: { prompt: 'p', disableAudio: false } }))
      .resolves.toMatchObject({ peer: { id: 'peer-1' } });
  });

  // Post-processing over the produced FILE, not the render: dropping it still
  // returns the requested image, so it is logged rather than refused.
  it('drops post-processing passes the remote executor will not run', () => {
    const params = routedJobParams(
      { prompt: 'p', cleanC2PA: true, denoise: true },
      { request: { modelId: 'm' }, remoteMedia: {} },
    );
    expect(params).not.toHaveProperty('cleanC2PA');
    expect(params).not.toHaveProperty('denoise');
  });
});

describe('hasConfiguredMediaRoute', () => {
  // Local readiness gates ("no Python, skip the render") run BEFORE the enqueue.
  // On a machine that routes because it CAN'T render locally, that gate would
  // skip exactly the work the peer was going to do.
  it('reports a configured kind without probing the peer', async () => {
    getSettings.mockResolvedValue({
      federation: { mediaRouting: { image: { peerId: 'p', engine: 'e', modelId: 'm' } } },
    });
    await expect(hasConfiguredMediaRoute('image')).resolves.toBe(true);
    await expect(hasConfiguredMediaRoute('video')).resolves.toBe(false);
    expect(prepareRemoteMediaJob).not.toHaveBeenCalled();
  });

  it('reports false for an unroutable kind and for an unreadable settings file', async () => {
    getSettings.mockResolvedValue({ federation: { mediaRouting: { audio: { peerId: 'p', engine: 'e', modelId: 'm' } } } });
    await expect(hasConfiguredMediaRoute('audio')).resolves.toBe(false);
    getSettings.mockRejectedValue(new Error('unreadable'));
    await expect(hasConfiguredMediaRoute('image')).resolves.toBe(false);
  });
});

describe('non-text video pipelines', () => {
  const route = { peerId: 'peer-1', engine: 'comfy', modelId: 'wan-remote' };

  beforeEach(() => {
    getSettings.mockResolvedValue({ federation: { mediaRouting: { video: route } } });
  });

  // routedJobParams DROPS `mode`, so an unguarded first-last-frame or
  // audio-to-video job would come back as a plain text-to-video clip — a
  // valid-looking render of an entirely different pipeline.
  it.each(['fflf', 'a2v', 'image'])('refuses a routed video in %s mode', async (mode) => {
    await expect(resolveDefaultMediaRoute({ kind: 'video', params: { prompt: 'p', mode } }))
      .rejects.toMatchObject({ code: 'MEDIA_PROVIDER_INPUT_UNSUPPORTED' });
  });

  it('allows an explicit text mode and an absent one', async () => {
    await expect(resolveDefaultMediaRoute({ kind: 'video', params: { prompt: 'p', mode: 'text' } }))
      .resolves.toMatchObject({ peer: { id: 'peer-1' } });
    await expect(resolveDefaultMediaRoute({ kind: 'video', params: { prompt: 'p' } }))
      .resolves.toMatchObject({ peer: { id: 'peer-1' } });
  });

  // For images `mode` names the BACKEND (local/codex/grok), not a pipeline, so
  // it is dropped rather than refused — same as the interactive image route.
  it('does not apply the video mode guard to images', async () => {
    getSettings.mockResolvedValue({ federation: { mediaRouting: { image: route } } });
    await expect(resolveDefaultMediaRoute({ kind: 'image', params: { prompt: 'p', mode: 'codex' } }))
      .resolves.toMatchObject({ peer: { id: 'peer-1' } });
  });
});
