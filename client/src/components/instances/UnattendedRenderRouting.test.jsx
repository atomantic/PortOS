import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../services/api', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), {
    success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(),
  }),
}));

import { getSettings, updateSettings } from '../../services/api';
import toast from '../ui/Toast';
import UnattendedRenderRouting from './UnattendedRenderRouting';

const capability = (overrides) => ({ ready: true, unavailableReason: null, ...overrides });

const peerWith = (overrides = {}) => ({
  id: 'peer-1',
  name: 'Render Box',
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

  it('saves a chosen route while carrying the rest of the federation slice forward', async () => {
    getSettings.mockResolvedValue({
      federation: { strictPullAuthorization: true, mediaProvider: { enabled: true } },
    });
    render(<UnattendedRenderRouting peers={[peerWith()]} />);

    const select = await screen.findByLabelText('Image');
    fireEvent.change(select, { target: { value: JSON.stringify(['peer-1', 'comfy', 'sdxl-base']) } });

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      federation: {
        strictPullAuthorization: true,
        mediaProvider: { enabled: true },
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

  it('tells the user when a route save fails instead of silently reverting', async () => {
    updateSettings.mockRejectedValue(new Error('nope'));
    render(<UnattendedRenderRouting peers={[peerWith()]} />);

    const select = await screen.findByLabelText('Image');
    fireEvent.change(select, { target: { value: JSON.stringify(['peer-1', 'comfy', 'sdxl-base']) } });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to save unattended render routing'));
    expect(select.value).toBe('');
  });
});

describe('UnattendedRenderRouting — writes against the freshest settings', () => {
  it('re-reads the federation slice at save time instead of writing a mount-time snapshot', async () => {
    // Mounted before the Sharing tab enabled the provider elsewhere.
    getSettings.mockResolvedValueOnce({ federation: { mediaProvider: { enabled: false } } });
    render(<UnattendedRenderRouting peers={[peerWith()]} />);
    const select = await screen.findByLabelText('Image');

    getSettings.mockResolvedValueOnce({
      federation: { mediaProvider: { enabled: true }, strictPullAuthorization: true },
    });
    fireEvent.change(select, { target: { value: JSON.stringify(['peer-1', 'comfy', 'sdxl-base']) } });

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      federation: {
        // The newer values survive — writing the stale snapshot would have
        // reverted mediaProvider.enabled and erased strictPullAuthorization.
        mediaProvider: { enabled: true },
        strictPullAuthorization: true,
        mediaRouting: { image: { peerId: 'peer-1', engine: 'comfy', modelId: 'sdxl-base' } },
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
