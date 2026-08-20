import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSettings = vi.fn();
const prepareRemoteMediaJob = vi.fn();

vi.mock('../settings.js', () => ({ getSettings: (...args) => getSettings(...args) }));
vi.mock('./remoteSubmission.js', () => ({
  prepareRemoteMediaJob: (...args) => prepareRemoteMediaJob(...args),
}));

const { normalizeMediaRoutingConfig, resolveDefaultMediaRoute, routedJobParams } =
  await import('./defaultRouting.js');

const route = { peerId: 'peer-1', engine: 'comfy', modelId: 'sdxl-remote' };
const withRoute = (mediaRouting) => ({ federation: { mediaRouting } });

beforeEach(() => {
  getSettings.mockReset();
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
