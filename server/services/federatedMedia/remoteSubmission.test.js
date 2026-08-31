import { beforeEach, describe, expect, it, vi } from 'vitest';
import { negotiateVideoConstraints, prepareRemoteMediaJob } from './remoteSubmission.js';

const mockGetPeers = vi.fn();
const mockResolveFederatedMediaProvider = vi.fn();

vi.mock('../instances.js', () => ({
  getPeers: (...args) => mockGetPeers(...args),
}));

vi.mock('../federatedMediaConsumer.js', () => ({
  resolveFederatedMediaProvider: (...args) => mockResolveFederatedMediaProvider(...args),
}));

beforeEach(() => {
  mockGetPeers.mockReset();
  mockResolveFederatedMediaProvider.mockReset();
});

describe('negotiateVideoConstraints', () => {
  it('snaps numFrames down to the nearest n*stride + 1', () => {
    const capability = {
      modelId: 'wan22_t2v_a14b',
      frameStride: 8,
    };

    expect(negotiateVideoConstraints({ numFrames: 33 }, capability).numFrames).toBe(33);
    expect(negotiateVideoConstraints({ numFrames: 40 }, capability).numFrames).toBe(33);
    expect(negotiateVideoConstraints({ numFrames: 41 }, capability).numFrames).toBe(41);
  });

  it('clamps numFrames to maxNumFrames respecting stride', () => {
    const capability = {
      modelId: 'wan22_t2v_a14b',
      frameStride: 4,
      maxNumFrames: 33,
    };

    expect(negotiateVideoConstraints({ numFrames: 40 }, capability).numFrames).toBe(33);
  });

  it('leaves numFrames untouched when capability has null or absent frameStride and maxNumFrames', () => {
    expect(negotiateVideoConstraints({ numFrames: 40 }, { frameStride: null, maxNumFrames: null }).numFrames).toBe(40);
    expect(negotiateVideoConstraints({ numFrames: 40 }, { frameStride: null }).numFrames).toBe(40);
    expect(negotiateVideoConstraints({ numFrames: 40 }, {}).numFrames).toBe(40);
  });

  it('snaps numFrames to the nearest discrete option when frameOptions is present', () => {
    const capability = {
      modelId: 'minimax_h3',
      frameOptions: [107, 124, 141, 158],
    };

    expect(negotiateVideoConstraints({ numFrames: 50 }, capability).numFrames).toBe(107);
    expect(negotiateVideoConstraints({ numFrames: 121 }, capability).numFrames).toBe(124);
    expect(negotiateVideoConstraints({ numFrames: 124 }, capability).numFrames).toBe(124);
    expect(negotiateVideoConstraints({ numFrames: 130 }, capability).numFrames).toBe(124);
    expect(negotiateVideoConstraints({ numFrames: 200 }, capability).numFrames).toBe(158);
  });

  it('rejects when maxNumFrames filters out all frameOptions', () => {
    const capability = {
      modelId: 'minimax_h3',
      frameOptions: [107, 124, 141, 158],
      maxNumFrames: 100,
    };

    expect(() => negotiateVideoConstraints({ numFrames: 50 }, capability))
      .toThrow(/cannot be satisfied/);
  });

  it('rejects when maxNumFrames pushes stride count below minLegal', () => {
    const capability = {
      modelId: 'wan22',
      frameStride: 8,
      maxNumFrames: 5,
    };

    expect(() => negotiateVideoConstraints({ numFrames: 40 }, capability))
      .toThrow(/cannot be satisfied.*minimum 9/);
  });

  it('snaps width and height to closest aspect ratio when resolutionOptions is present', () => {
    const capability = {
      modelId: 'minimax_h3',
      resolutionOptions: [
        { label: '16:9', w: 1344, h: 768 },
        { label: '9:16', w: 768, h: 1344 },
      ],
    };

    const snapped = negotiateVideoConstraints({ width: 1280, height: 720 }, capability);
    expect(snapped.width).toBe(1344);
    expect(snapped.height).toBe(768);
  });

  it('snaps width and height when only one dimension is supplied', () => {
    const capability = {
      modelId: 'minimax_h3',
      resolutionOptions: [
        { label: '21:9', w: 1536, h: 672 },
        { label: '16:9', w: 1344, h: 768 },
        { label: '9:16', w: 768, h: 1344 },
      ],
    };

    const snappedHeight = negotiateVideoConstraints({ height: 750 }, capability);
    expect(snappedHeight.width).toBe(1344);
    expect(snappedHeight.height).toBe(768);

    const snappedWidth = negotiateVideoConstraints({ width: 800 }, capability);
    expect(snappedWidth.width).toBe(768);
    expect(snappedWidth.height).toBe(1344);
  });

  it('clamps rescaled frame count to the capability maximum', () => {
    const capability = {
      modelId: 'wan22',
      frameStride: 4,
      fpsOptions: [24],
      maxNumFrames: 300,
    };

    // 250 frames at 16 fps -> rescaled to (250/16)*24 = 375 -> clamped to maxNumFrames 300 -> snapped to stride 297
    const result = negotiateVideoConstraints({ numFrames: 250, fps: 16 }, capability);
    expect(result.fps).toBe(24);
    expect(result.numFrames).toBe(297);
  });

  it('preserves the 1017-frame LTX-2.5 capability through fps negotiation', () => {
    const capability = {
      modelId: 'ltx25_mlx_q8',
      frameStride: 8,
      fpsOptions: [24],
      maxNumFrames: 1017,
    };

    expect(negotiateVideoConstraints({ numFrames: 1017, fps: 24 }, capability).numFrames).toBe(1017);
    // 800 frames at 16 fps would rescale past the provider ceiling; clamp to
    // 1017, which is already legal on the 8n+1 grid.
    expect(negotiateVideoConstraints({ numFrames: 800, fps: 16 }, capability).numFrames).toBe(1017);
  });

  it('tie-breaks equal aspect ratios by closest area and ignores out-of-bounds options', () => {
    const capability = {
      modelId: 'custom',
      resolutionOptions: [
        { label: '4k-out-of-bounds', w: 3840, h: 2160 },
        { label: '1080p', w: 1920, h: 1080 },
        { label: '720p', w: 1280, h: 720 },
      ],
    };

    const snapped720 = negotiateVideoConstraints({ width: 1024, height: 576 }, capability);
    expect(snapped720.width).toBe(1280);
    expect(snapped720.height).toBe(720);

    const snapped1080 = negotiateVideoConstraints({ width: 1800, height: 1012 }, capability);
    expect(snapped1080.width).toBe(1920);
    expect(snapped1080.height).toBe(1080);
  });

  it('snaps fps to the nearest option and rescales frame count to preserve clip duration', () => {
    const capability = {
      modelId: 'minimax_h3',
      fpsOptions: [24],
      frameOptions: [107, 124, 141, 158, 175, 192, 209, 226, 243],
    };

    // 241 frames at 30 fps ≈ 8.03s -> rescaled to (241/30)*24 ≈ 193 frames -> snapped to nearest frameOption 192 (8.0s)
    const result = negotiateVideoConstraints({ numFrames: 241, fps: 30 }, capability);
    expect(result.fps).toBe(24);
    expect(result.numFrames).toBe(192);
  });

  it('snaps requested numFrames up to minLegal when below stride floor', () => {
    const capability = {
      modelId: 'wan22_t2v_a14b',
      frameStride: 4,
    };

    expect(negotiateVideoConstraints({ numFrames: 3 }, capability).numFrames).toBe(5);
  });

  it('rejects when requested numFrames is invalid (< 1)', () => {
    const capability = {
      modelId: 'wan22',
      frameStride: 8,
    };

    expect(() => negotiateVideoConstraints({ numFrames: -5 }, capability))
      .toThrow(/invalid/);
  });
});

describe('prepareRemoteMediaJob', () => {
  it('negotiates video constraints and attaches the negotiated request to remoteMedia', async () => {
    mockGetPeers.mockResolvedValue([{ id: 'peer-1', name: 'Render Box' }]);
    mockResolveFederatedMediaProvider.mockResolvedValue({
      capability: {
        kind: 'video',
        engine: 'local',
        modelId: 'wan22_t2v_a14b',
        ready: true,
        frameStride: 8,
      },
    });

    const result = await prepareRemoteMediaJob({
      peerId: 'peer-1',
      kind: 'video',
      request: {
        kind: 'video',
        engine: 'local',
        modelId: 'wan22_t2v_a14b',
        prompt: 'a scenic drive',
        numFrames: 40,
      },
    });

    expect(result.request.numFrames).toBe(33);
    expect(result.remoteMedia.request.numFrames).toBe(33);
  });
});

// Every lane — Image Gen, Video Gen, and the unattended router — funnels through
// prepareRemoteMediaJob, so the conditioning gate lives HERE rather than being
// written per route. It previously was written per route, and the unattended
// lane (the one with nobody watching) had no copy at all.
describe('prepareRemoteMediaJob — conditioning gate', () => {
  const PEER_ID = '00000000-0000-4000-8000-000000000001';
  const peer = { id: PEER_ID, enabled: true };
  const capability = (inputAssets, kind = 'video') => ({
    kind, engine: 'local', modelId: 'ltx2', modelName: 'LTX-2', inputAssets,
  });
  const roles = (...names) => ({
    roles: names, required: false, maxCount: 8, maxBytes: 1, mimeTypes: ['image/png'],
  });

  const prepare = (kind, request, inputAssets, cap, status) => {
    mockGetPeers.mockResolvedValue([peer]);
    mockResolveFederatedMediaProvider.mockResolvedValue({ peer, capability: cap, status });
    return prepareRemoteMediaJob({ peerId: PEER_ID, kind, request, inputAssets });
  };

  it('refuses an end frame with no start frame, on every lane at once', async () => {
    await expect(prepare(
      'video',
      { kind: 'video', engine: 'local', modelId: 'ltx2', prompt: 'a harbour' },
      [{ role: 'lastImage', path: 'end.png' }],
      capability(roles('sourceImage', 'lastImage')),
    )).rejects.toMatchObject({ status: 400, code: 'MEDIA_PROVIDER_INPUT_UNSUPPORTED' });
  });

  it('accepts the pair, and persists the local paths on the marker', async () => {
    const assets = [
      { role: 'sourceImage', path: 'start.png' },
      { role: 'lastImage', path: 'end.png' },
    ];
    const result = await prepare(
      'video',
      { kind: 'video', engine: 'local', modelId: 'ltx2', prompt: 'a harbour' },
      assets,
      capability(roles('sourceImage', 'lastImage')),
    );
    // Local paths, never provider asset ids — those name slots in a TTL-swept
    // area and would reconcile into a reference to bytes that are gone.
    expect(result.remoteMedia.inputAssets).toEqual(assets);
  });

  // The remedy has to name the kind the caller is actually rendering; pointing a
  // blocked VIDEO render at "a text-to-image model" names a control that is not
  // on their screen.
  it('names the caller’s own kind when a model needs conditioning it did not get', async () => {
    await expect(prepare(
      'video',
      { kind: 'video', engine: 'local', modelId: 'ltx2', prompt: 'a harbour' },
      [],
      capability({ ...roles('sourceImage'), required: true }),
    )).rejects.toThrow(/text-to-video/);

    await expect(prepare(
      'image',
      { kind: 'image', engine: 'local', modelId: 'flux', prompt: 'a lighthouse', width: 512, height: 512 },
      [],
      capability({ ...roles('initImage'), required: true }, 'image'),
    )).rejects.toThrow(/text-to-image/);
  });

  // The conflation the status-root feature list exists to undo (#4826): before
  // it, "this peer's build predates conditioning" and "this peer speaks
  // conditioning but the model you picked takes none" were the same absent
  // block, so both got the same remedy and one of them was wrong.
  it('tells a peer too old to carry conditioning apart from a model that takes none', async () => {
    const textOnly = { ...capability(roles('initImage'), 'image'), inputAssets: null };
    const submit = (status) => prepare(
      'image',
      { kind: 'image', engine: 'local', modelId: 'flux', prompt: 'a lighthouse', width: 512, height: 512 },
      [{ role: 'initImage', path: 'init.png' }],
      textOnly,
      status,
    );
    await expect(submit({ features: ['lyrics', 'inputAssets'] })).rejects.toThrow(/pick a peer model that does/);
    await expect(submit({ features: ['lyrics'] })).rejects.toThrow(/Update the peer/);
    // No status at all keeps the older merged message rather than accusing a
    // peer of being out of date on no evidence.
    await expect(submit(undefined)).rejects.toThrow(/pick a peer model that does/);
  });

  it('refuses a role the peer model never advertised', async () => {
    await expect(prepare(
      'image',
      { kind: 'image', engine: 'local', modelId: 'flux', prompt: 'a lighthouse', width: 512, height: 512 },
      [{ role: 'referenceImages', path: 'ref.png' }],
      capability(roles('initImage'), 'image'),
    )).rejects.toMatchObject({ status: 400, code: 'MEDIA_PROVIDER_INPUT_UNSUPPORTED' });
  });
});
