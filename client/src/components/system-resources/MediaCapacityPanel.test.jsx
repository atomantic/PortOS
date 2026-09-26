import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const socket = vi.hoisted(() => {
  const listeners = new Map();
  return {
    emit: vi.fn(),
    on: vi.fn((event, listener) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(listener);
    }),
    off: vi.fn((event, listener) => listeners.get(event)?.delete(listener)),
    receive: (event, payload) => {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
    listenerCount: (event) => listeners.get(event)?.size ?? 0,
  };
});
vi.mock('../../services/socket', () => ({ default: socket }));

const api = vi.hoisted(() => ({ getInstances: vi.fn() }));
vi.mock('../../services/api.js', () => api);

const MediaCapacityPanel = (await import('./MediaCapacityPanel.jsx')).default;

const media = (overrides = {}) => ({
  gpu: { cudaStatus: 'available', laneBusy: true, laneKind: 'video' },
  lanes: {
    gpu: { running: 1, queued: 2, limit: 1 },
    cloud: { running: 0, queued: 0, limit: 1 },
    remote: { running: 3, queued: 0, limit: 20 },
  },
  byKind: {
    video: { running: 1, queued: 2 },
    image: { running: 0, queued: 0 },
    audio: { running: 3, queued: 0 },
    training: { running: 0, queued: 0 },
  },
  totals: { running: 4, queued: 2 },
  ...overrides,
});

const providerPeer = (overrides = {}) => ({
  id: 'peer-1',
  name: 'render-box',
  status: 'online',
  mediaProvider: { enabled: true, audioModels: [{ engine: 'minimax', modelId: 'music-3' }] },
  mediaProviderStatus: {
    checkedAt: new Date().toISOString(),
    state: 'ready',
    freshUntil: new Date(Date.now() + 60_000).toISOString(),
    snapshot: {
      queue: { running: 1, queued: 0, totalActive: 1, maxQueuedJobs: 4, accepting: true },
      capabilities: [],
    },
  },
  ...overrides,
});

const renderPanel = (props = {}) => render(
  <MemoryRouter>
    <MediaCapacityPanel media={media()} {...props} />
  </MemoryRouter>,
);

describe('MediaCapacityPanel', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    api.getInstances.mockResolvedValue({ peers: [] });
  });

  it('shows each lane’s occupancy against its configured limit', async () => {
    renderPanel();
    expect(await screen.findByText('Local GPU')).toBeInTheDocument();
    expect(screen.getByText('1/1')).toBeInTheDocument();
    expect(screen.getByText('3/20')).toBeInTheDocument();
    expect(screen.getByText('4 running · 2 queued')).toBeInTheDocument();
  });

  it('reports queue depth per kind, skipping idle kinds', async () => {
    renderPanel();
    expect(await screen.findByText('video: 1/2')).toBeInTheDocument();
    expect(screen.getByText('audio: 3/0')).toBeInTheDocument();
    expect(screen.queryByText(/^image:/)).not.toBeInTheDocument();
  });

  // available / absent / unknown are three distinct claims — a failed probe must
  // never be rendered as "this machine has no GPU".
  it.each([
    ['available', 'CUDA available'],
    ['absent', 'no CUDA device'],
    ['unknown', 'CUDA unknown'],
  ])('renders the %s CUDA state as its own label', async (cudaStatus, label) => {
    renderPanel({ media: media({ gpu: { cudaStatus, laneBusy: false, laneKind: null } }) });
    expect(await screen.findByText(label)).toBeInTheDocument();
  });

  it('renders an unknown state rather than an idle one when the report is missing', async () => {
    renderPanel({ media: null });
    expect(await screen.findByText(/Media-lane capacity is unavailable/)).toBeInTheDocument();
    expect(screen.getByText('CUDA unknown')).toBeInTheDocument();
    expect(screen.queryByText('Local GPU')).not.toBeInTheDocument();
  });

  it('lists an opted-in peer provider with its readiness and queue', async () => {
    api.getInstances.mockResolvedValue({ peers: [providerPeer()] });
    renderPanel();
    expect(await screen.findByText('render-box')).toBeInTheDocument();
    expect(screen.getByText('ready')).toBeInTheDocument();
    expect(screen.getByText('1/4 shared slots active · federated 1 running')).toBeInTheDocument();
  });

  // The local lanes above already show running/limit; a peer row that could only
  // report depth left the two halves of this card answering different questions.
  it('reports a peer’s drain rate and busy kinds beside its queue depth', async () => {
    api.getInstances.mockResolvedValue({ peers: [providerPeer({
      mediaProviderStatus: {
        checkedAt: new Date().toISOString(),
        state: 'ready',
        freshUntil: new Date(Date.now() + 60_000).toISOString(),
        snapshot: {
          queue: {
            running: 1, queued: 0, totalActive: 1, maxQueuedJobs: 4, accepting: true,
            concurrency: 4,
            byKind: { audio: { running: 1, queued: 0 } },
          },
          capabilities: [],
        },
      },
    })] });
    renderPanel();
    expect(await screen.findByText(/runs 4 at a time · audio 1 running · federated 1 running/)).toBeInTheDocument();
  });

  // An older provider sends neither field. The row drops the segments rather
  // than reporting lanes as idle that the peer never told us about.
  it('omits the drain rate for a peer on a build that does not report one', async () => {
    api.getInstances.mockResolvedValue({ peers: [providerPeer()] });
    renderPanel();
    expect(await screen.findByText('render-box')).toBeInTheDocument();
    expect(screen.queryByText(/\d+ at a time/)).not.toBeInTheDocument();
  });

  it('shows an expired snapshot as stale with its remedy, not as ready', async () => {
    api.getInstances.mockResolvedValue({
      peers: [providerPeer({
        mediaProviderStatus: {
          checkedAt: new Date(Date.now() - 600_000).toISOString(),
          state: 'ready',
          freshUntil: new Date(Date.now() - 300_000).toISOString(),
          snapshot: { queue: { running: 0, queued: 0, totalActive: 0, maxQueuedJobs: 4, accepting: true }, capabilities: [] },
        },
      })],
    });
    renderPanel();
    expect(await screen.findByText('stale')).toBeInTheDocument();
    expect(screen.queryByText('ready')).not.toBeInTheDocument();
    expect(screen.getByText(/last capacity snapshot expired/i)).toBeInTheDocument();
  });

  it('omits a peer that is not enabled as a media provider', async () => {
    api.getInstances.mockResolvedValue({
      peers: [providerPeer({ id: 'p2', name: 'laptop', mediaProvider: { enabled: false } })],
    });
    renderPanel();
    expect(await screen.findByText(/No peer is enabled as a media provider/)).toBeInTheDocument();
    expect(screen.queryByText('laptop')).not.toBeInTheDocument();
  });

  // A failed read and a genuinely peerless install must not render identically.
  it('distinguishes a failed first peer read from having no providers', async () => {
    api.getInstances.mockRejectedValue(new Error('offline'));
    renderPanel();
    expect(await screen.findByText(/provider readiness is unknown/i)).toBeInTheDocument();
    expect(screen.queryByText(/No peer is enabled as a media provider/)).not.toBeInTheDocument();
  });

  // A body we could not parse is "we do not know", not "there are none" —
  // coercing it to [] would state the opposite off a response we never read.
  it.each([{}, { peers: null }, { peers: 'nope' }])(
    'treats the malformed body %p as a failed read, not an empty one',
    async (body) => {
      api.getInstances.mockResolvedValue(body);
      renderPanel();
      expect(await screen.findByText(/provider readiness is unknown/i)).toBeInTheDocument();
      expect(screen.queryByText(/No peer is enabled as a media provider/)).not.toBeInTheDocument();
    },
  );

  it('shows a disabled peer connection as disabled, not as ready', async () => {
    api.getInstances.mockResolvedValue({ peers: [providerPeer({ enabled: false })] });
    renderPanel();
    expect(await screen.findByText('peer disabled')).toBeInTheDocument();
    expect(screen.queryByText('ready')).not.toBeInTheDocument();
  });

  it('applies pushed peer snapshots without polling and releases its subscription on unmount', async () => {
    vi.useFakeTimers();
    const view = renderPanel();
    await act(async () => {});
    expect(api.getInstances).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenCalledWith('instances:subscribe');
    expect(screen.getByText(/No peer is enabled as a media provider/)).toBeInTheDocument();

    await act(async () => { socket.receive('instances:peers:updated', [providerPeer()]); });
    expect(screen.getByText('render-box')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(api.getInstances).toHaveBeenCalledTimes(1);

    await act(async () => { socket.receive('instances:peers:updated', []); });
    expect(screen.queryByText('render-box')).not.toBeInTheDocument();
    view.unmount();
    expect(socket.emit).toHaveBeenCalledWith('instances:unsubscribe');
    expect(socket.listenerCount('instances:peers:updated')).toBe(0);
    expect(socket.listenerCount('connect')).toBe(0);
    await act(async () => {
      socket.receive('connect');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(api.getInstances).toHaveBeenCalledTimes(1);
  });

  it('reconciles once per reconnect or tab re-show and preserves peers when that read fails', async () => {
    api.getInstances.mockResolvedValue({ peers: [providerPeer()] });
    renderPanel();
    expect(await screen.findByText('render-box')).toBeInTheDocument();

    api.getInstances.mockRejectedValue(new Error('offline'));
    await act(async () => { socket.receive('connect'); });
    expect(api.getInstances).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Showing the last known snapshot/i)).toBeInTheDocument();
    expect(screen.getByText('render-box')).toBeInTheDocument();

    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    visibility.mockReturnValue('hidden');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(api.getInstances).toHaveBeenCalledTimes(2);

    api.getInstances.mockResolvedValue({ peers: [] });
    visibility.mockReturnValue('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(api.getInstances).toHaveBeenCalledTimes(3);
    expect(screen.queryByText('render-box')).not.toBeInTheDocument();
    expect(screen.queryByText(/Showing the last known snapshot/i)).not.toBeInTheDocument();
  });

  it('does not let an older HTTP response replace a pushed snapshot', async () => {
    let finish;
    api.getInstances.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    renderPanel();
    await act(async () => { socket.receive('instances:peers:updated', [providerPeer()]); });
    expect(screen.getByText('render-box')).toBeInTheDocument();
    await act(async () => { finish({ peers: [] }); });
    expect(screen.getByText('render-box')).toBeInTheDocument();
  });

  it('ignores malformed pushes and recovers a failed initial read from a valid snapshot', async () => {
    api.getInstances.mockRejectedValue(new Error('offline'));
    renderPanel();
    expect(await screen.findByText(/provider readiness is unknown/i)).toBeInTheDocument();
    await act(async () => { socket.receive('instances:peers:updated', { peers: [] }); });
    expect(screen.getByText(/provider readiness is unknown/i)).toBeInTheDocument();
    await act(async () => { socket.receive('instances:peers:updated', [providerPeer()]); });
    expect(screen.getByText('render-box')).toBeInTheDocument();
    expect(screen.queryByText(/provider readiness is unknown/i)).not.toBeInTheDocument();
  });
});
