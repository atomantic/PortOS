import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../services/apiSystem.js', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));
vi.mock('../ui/Toast');

import { getSettings, updateSettings } from '../../services/apiSystem.js';
import toast from '../ui/Toast';
import UnattendedRenderRouting from './UnattendedRenderRouting';

const capability = (overrides) => ({ ready: true, unavailableReason: null, ...overrides });

const peerWith = (overrides = {}) => ({
  id: 'peer-1',
  name: 'Render Box',
  // A standing route refuses a non-tailnet peer (ADR rule 5), so the shared
  // fixture has to be a tailnet host or nothing is offerable.
  host: 'render-box.tailnet-example.ts.net',
  mediaProvider: {
    enabled: true,
    imageModels: [{ engine: 'comfy', modelId: 'sdxl-base' }],
    videoModels: [],
  },
  mediaProviderStatus: {
    state: 'ready',
    snapshot: {
      capabilities: [capability({
        kind: 'image', engine: 'comfy', engineName: 'ComfyUI',
        modelId: 'sdxl-base', modelName: 'SDXL Base',
      })],
    },
  },
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  getSettings.mockResolvedValue({ federation: {} });
  updateSettings.mockImplementation(async (patch) => patch);
});

describe('UnattendedRenderRouting', () => {
  it('stays hidden until a peer advertises an allowlisted visual model', async () => {
    const { container } = render(<UnattendedRenderRouting peers={[]} />);
    await waitFor(() => expect(getSettings).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('offers no audio lane — free-form music prompts cannot cross the wire', async () => {
    render(<UnattendedRenderRouting peers={[peerWith()]} />);
    expect(await screen.findByLabelText('Image')).toBeInTheDocument();
    expect(screen.getByLabelText('Video')).toBeInTheDocument();
    expect(screen.queryByLabelText('Audio')).not.toBeInTheDocument();
  });

  // #4703 — this page owns `mediaRouting` and nothing else in the slice. It
  // patches that sub-key alone; the server carries the Sharing tab's sub-keys
  // forward, so a save here can no longer revert them.
  it('patches mediaRouting alone rather than rewriting the whole federation slice', async () => {
    getSettings.mockResolvedValue({
      federation: { strictPullAuthorization: true, mediaProvider: { enabled: true } },
    });
    render(<UnattendedRenderRouting peers={[peerWith()]} />);

    const select = await screen.findByLabelText('Image');
    fireEvent.change(select, { target: { value: JSON.stringify(['peer-1', 'comfy', 'sdxl-base']) } });

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      federation: {
        mediaRouting: { image: { peerId: 'peer-1', engine: 'comfy', modelId: 'sdxl-base' } },
      },
    }, { silent: true }));
  });

  it('clears a route back to local rendering', async () => {
    getSettings.mockResolvedValue({
      federation: { mediaRouting: { image: { peerId: 'peer-1', engine: 'comfy', modelId: 'sdxl-base' } } },
    });
    render(<UnattendedRenderRouting peers={[peerWith()]} />);

    const select = await screen.findByLabelText('Image');
    fireEvent.change(select, { target: { value: '' } });

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      federation: { mediaRouting: { image: null } },
    }, { silent: true }));
  });

  it('keeps a saved route selectable after the peer stops advertising its model', async () => {
    getSettings.mockResolvedValue({
      federation: { mediaRouting: { image: { peerId: 'peer-1', engine: 'comfy', modelId: 'retired-model' } } },
    });
    render(<UnattendedRenderRouting peers={[peerWith()]} />);

    const select = await screen.findByLabelText('Image');
    expect(select.value).toBe(JSON.stringify(['peer-1', 'comfy', 'retired-model']));
    expect(screen.getByText('retired-model (unavailable)')).toBeInTheDocument();
  });

  it('does not offer a model the peer advertises but the user never allowlisted', async () => {
    const peer = peerWith({
      mediaProvider: { enabled: true, imageModels: [], videoModels: [] },
    });
    const { container } = render(<UnattendedRenderRouting peers={[peer]} />);
    await waitFor(() => expect(getSettings).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});

// #4348 review follow-ups.
describe('UnattendedRenderRouting — failure and staleness handling', () => {
  it('never rebuilds the federation slice from a failed settings read', async () => {
    getSettings.mockRejectedValue(new Error('settings unavailable'));
    render(<UnattendedRenderRouting peers={[peerWith()]} />);

    // Read-only notice instead of a live control: a save from here would send a
    // federation slice reconstructed from {}, wiping mediaProvider.
    expect(await screen.findByText(/could not load this instance/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Image')).not.toBeInTheDocument();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('excludes a peer that is disabled wholesale, even with capabilities still cached', async () => {
    const { container } = render(<UnattendedRenderRouting peers={[peerWith({ enabled: false })]} />);
    await waitFor(() => expect(getSettings).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps a stale saved route clearable after its peer stops offering anything', async () => {
    getSettings.mockResolvedValue({
      federation: { mediaRouting: { image: { peerId: 'peer-1', engine: 'comfy', modelId: 'sdxl-base' } } },
    });
    // No peers at all — without the saved-route carve-out the card would hide
    // and the failing route could never be cleared.
    render(<UnattendedRenderRouting peers={[]} />);

    const select = await screen.findByLabelText('Image');
    expect(select).toBeEnabled();
    fireEvent.change(select, { target: { value: '' } });

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      federation: { mediaRouting: { image: null } },
    }, { silent: true }));
  });

  // The server refuses a route that could never run (#4348) with a named
  // reason. Reporting a generic failure instead would leave the user re-picking
  // the same unrunnable option, since the select just snaps back either way.
  it('surfaces the server\u2019s reason when a route save is refused', async () => {
    updateSettings.mockRejectedValue(Object.assign(
      new Error('Unattended image routing requires a Tailscale peer'),
      { code: 'MEDIA_ROUTING_PEER_NOT_TAILNET', status: 403 },
    ));
    render(<UnattendedRenderRouting peers={[peerWith()]} />);

    const select = await screen.findByLabelText('Image');
    fireEvent.change(select, { target: { value: JSON.stringify(['peer-1', 'comfy', 'sdxl-base']) } });

    await waitFor(() => expect(toast.error)
      .toHaveBeenCalledWith('Unattended image routing requires a Tailscale peer'));
    expect(select.value).toBe('');
  });

  it('falls back to a generic message when the failure carries none', async () => {
    updateSettings.mockRejectedValue(new Error(''));
    render(<UnattendedRenderRouting peers={[peerWith()]} />);

    const select = await screen.findByLabelText('Image');
    fireEvent.change(select, { target: { value: JSON.stringify(['peer-1', 'comfy', 'sdxl-base']) } });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to save unattended render routing'));
  });
});

describe('UnattendedRenderRouting — writes against the freshest settings', () => {
  // The server merge is per federation SUB-key, so `mediaRouting` still crosses
  // whole. The re-read is what keeps a kind routed from another tab of this same
  // page from being reverted by this one's mount-time copy.
  it('merges the chosen kind onto the freshest routing map, not the mount-time one', async () => {
    // Mounted before another tab routed video.
    getSettings.mockResolvedValueOnce({ federation: { mediaRouting: {} } });
    render(<UnattendedRenderRouting peers={[peerWith()]} />);
    const select = await screen.findByLabelText('Image');

    const videoRoute = { peerId: 'peer-1', engine: 'comfy', modelId: 'svd' };
    getSettings.mockResolvedValueOnce({ federation: { mediaRouting: { video: videoRoute } } });
    fireEvent.change(select, { target: { value: JSON.stringify(['peer-1', 'comfy', 'sdxl-base']) } });

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      federation: {
        mediaRouting: {
          // Writing the mount-time map would have cleared this.
          video: videoRoute,
          image: { peerId: 'peer-1', engine: 'comfy', modelId: 'sdxl-base' },
        },
      },
    }, { silent: true }));
  });

});

describe('UnattendedRenderRouting — a failed read is not an empty configuration', () => {
  it('aborts the save rather than writing a known-stale slice over the server', async () => {
    getSettings.mockResolvedValueOnce({ federation: { mediaProvider: { enabled: true } } });
    render(<UnattendedRenderRouting peers={[peerWith()]} />);
    const select = await screen.findByLabelText('Image');

    getSettings.mockRejectedValueOnce(new Error('offline'));
    fireEvent.change(select, { target: { value: JSON.stringify(['peer-1', 'comfy', 'sdxl-base']) } });

    await waitFor(() => expect(toast.error)
      .toHaveBeenCalledWith('Could not read current settings — routing not saved'));
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('shows the read-only notice even when no peer advertises anything', async () => {
    getSettings.mockRejectedValue(new Error('offline'));
    render(<UnattendedRenderRouting peers={[]} />);
    expect(await screen.findByText(/could not load this instance/i)).toBeInTheDocument();
  });
});

// #4348 — item 6 asks for provider/model selection AND capacity messaging on
// the Creative Commission flow, which this card is. It reads through the same
// shared readiness lib the Instances card, System Health, and the interactive
// pickers use, so this cannot become a fourth surface with its own verdict.
describe('UnattendedRenderRouting — capacity messaging', () => {
  const routed = { federation: { mediaRouting: { image: { peerId: 'peer-1', engine: 'comfy', modelId: 'sdxl-base' } } } };

  it('reports the routed peer\u2019s readiness and queue occupancy', async () => {
    getSettings.mockResolvedValue(routed);
    const peer = peerWith({
      status: 'online',
      mediaProviderStatus: {
        state: 'ready',
        freshUntil: new Date(Date.now() + 60_000).toISOString(),
        snapshot: {
          capabilities: [capability({
            kind: 'image', engine: 'comfy', engineName: 'ComfyUI',
            modelId: 'sdxl-base', modelName: 'SDXL Base',
          })],
          queue: { totalActive: 1, maxQueuedJobs: 4, concurrency: 2, running: 0, queued: 0 },
        },
      },
    });
    render(<UnattendedRenderRouting peers={[peer]} />);

    expect(await screen.findByText(/1\/4 shared slots active/)).toBeInTheDocument();
    expect(screen.getByText(/runs 2 at a time/)).toBeInTheDocument();
  });

  // A snapshot probed as `ready` keeps SAYING ready long after the server would
  // refuse to submit against it; the shared lib re-derives that at render time.
  it('reads an expired snapshot as stale rather than repeating its own ready', async () => {
    getSettings.mockResolvedValue(routed);
    const peer = peerWith({
      status: 'online',
      mediaProviderStatus: {
        state: 'ready',
        freshUntil: new Date(Date.now() - 60_000).toISOString(),
        snapshot: { capabilities: [] },
      },
    });
    render(<UnattendedRenderRouting peers={[peer]} />);

    expect(await screen.findByText('stale')).toBeInTheDocument();
  });

  it('says so when the routed peer is no longer registered here', async () => {
    getSettings.mockResolvedValue(routed);
    render(<UnattendedRenderRouting peers={[]} />);
    expect(await screen.findByText('peer not registered')).toBeInTheDocument();
  });

  it('reports nothing for a kind that renders locally', async () => {
    getSettings.mockResolvedValue({ federation: {} });
    render(<UnattendedRenderRouting peers={[peerWith()]} />);
    await screen.findByLabelText('Image');
    expect(screen.queryByText(/shared slots active/)).not.toBeInTheDocument();
  });
});

describe('UnattendedRenderRouting — tailnet gate', () => {
  it('does not offer a peer reachable outside the tailnet', async () => {
    // The server refuses such a route on every job; offering it here would only
    // let the user save a configuration that can never run.
    const lanPeer = peerWith({ host: undefined, address: '192.0.2.10', name: 'LAN Box' });
    const { container } = render(<UnattendedRenderRouting peers={[lanPeer]} />);
    await waitFor(() => expect(getSettings).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('offers a CGNAT-addressed peer', async () => {
    const cgnatPeer = peerWith({ host: undefined, address: '100.64.0.5' });
    render(<UnattendedRenderRouting peers={[cgnatPeer]} />);
    expect(await screen.findByLabelText('Image')).toBeInTheDocument();
  });
});

describe('UnattendedRenderRouting — an absent federation slice is not a failed read', () => {
  // The whole feature is unreachable on a fresh install if this regresses: no
  // install has a `federation` key until something writes one, so treating its
  // absence as unreadable makes the FIRST route unsavable, always.
  it('creates the slice when a successful response has no federation key', async () => {
    getSettings.mockResolvedValue({});
    render(<UnattendedRenderRouting peers={[peerWith()]} />);

    const select = await screen.findByLabelText('Image');
    fireEvent.change(select, { target: { value: JSON.stringify(['peer-1', 'comfy', 'sdxl-base']) } });

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      federation: { mediaRouting: { image: { peerId: 'peer-1', engine: 'comfy', modelId: 'sdxl-base' } } },
    }, { silent: true }));
    expect(toast.error).not.toHaveBeenCalled();
  });
});
