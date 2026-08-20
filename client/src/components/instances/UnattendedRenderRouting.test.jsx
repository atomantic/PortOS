import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../services/api', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

import { getSettings, updateSettings } from '../../services/api';
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
