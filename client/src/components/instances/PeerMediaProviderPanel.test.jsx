import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../services/api', () => ({
  probePeer: vi.fn(),
  updatePeer: vi.fn(),
}));

import { probePeer, updatePeer } from '../../services/api';
import PeerMediaProviderPanel from './PeerMediaProviderPanel';

const basePeer = {
  id: 'peer-example',
  name: 'Example Provider',
  enabled: true,
  status: 'online',
};

const capability = (overrides) => ({
  ready: true,
  unavailableReason: null,
  ...overrides,
});

const readyStatus = {
  state: 'ready',
  reason: null,
  checkedAt: '2026-08-17T12:00:00.000Z',
  freshUntil: '2026-08-17T12:01:00.000Z',
  snapshot: {
    queue: { running: 1, queued: 2, totalActive: 3, maxQueuedJobs: 4, accepting: true },
    capabilities: [capability({
      kind: 'audio',
      engine: 'minimax-music3',
      engineName: 'MiniMax Music 3',
      modelId: 'minimax-music3',
      modelName: 'MiniMax Music 3',
    })],
  },
};

// Every write sends the full per-kind shape, so the expected payload is verbose
// by design — a patch that omitted a list would only read as "unchanged" by luck.
const emptyLists = { audioModels: [], imageModels: [], videoModels: [] };

beforeEach(() => {
  vi.clearAllMocks();
  updatePeer.mockResolvedValue({ id: basePeer.id });
  probePeer.mockResolvedValue({ id: basePeer.id });
});

describe('PeerMediaProviderPanel', () => {
  it('opts in explicitly and probes before refreshing the card', async () => {
    const onRefresh = vi.fn();
    render(<PeerMediaProviderPanel peer={basePeer} onRefresh={onRefresh} />);

    fireEvent.click(screen.getByRole('button', { name: /Remote media provider/i }));
    fireEvent.click(screen.getByLabelText(/Use this peer for remote media/i));

    await waitFor(() => expect(updatePeer).toHaveBeenCalledWith('peer-example', {
      mediaProvider: { enabled: true, ...emptyLists },
    }));
    await waitFor(() => expect(probePeer).toHaveBeenCalledWith('peer-example'));
    expect(onRefresh).toHaveBeenCalled();
  });

  it('shows queue capacity and persists an allowlisted model without dropping future config fields', async () => {
    const onRefresh = vi.fn();
    const peer = {
      ...basePeer,
      mediaProvider: { enabled: true, audioModels: [], futureField: 'keep' },
      mediaProviderStatus: readyStatus,
    };
    render(<PeerMediaProviderPanel peer={peer} onRefresh={onRefresh} />);

    fireEvent.click(screen.getByRole('button', { name: /Remote media provider/i }));
    expect(screen.getByText(/1 running · 2 queued · 3\/4 shared slots active/i)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Allow audio model MiniMax Music 3'));

    await waitFor(() => expect(updatePeer).toHaveBeenCalledWith('peer-example', {
      mediaProvider: {
        enabled: true,
        futureField: 'keep',
        ...emptyLists,
        audioModels: [{ engine: 'minimax-music3', modelId: 'minimax-music3' }],
      },
    }));
    expect(probePeer).not.toHaveBeenCalled();
  });

  // #4348 — image and video landed on the wire before they had any surface to
  // be allowlisted from, which left federated renders unreachable from the UI.
  it('allowlists an image model into its own list, leaving the audio list alone', async () => {
    const peer = {
      ...basePeer,
      mediaProvider: {
        enabled: true,
        audioModels: [{ engine: 'minimax-music3', modelId: 'minimax-music3' }],
      },
      mediaProviderStatus: {
        ...readyStatus,
        snapshot: {
          ...readyStatus.snapshot,
          capabilities: [
            ...readyStatus.snapshot.capabilities,
            capability({
              kind: 'image', engine: 'comfy', engineName: 'ComfyUI',
              modelId: 'sdxl-base', modelName: 'SDXL Base',
            }),
          ],
        },
      },
    };
    render(<PeerMediaProviderPanel peer={peer} onRefresh={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Remote media provider/i }));
    fireEvent.click(screen.getByLabelText('Allow image model SDXL Base'));

    await waitFor(() => expect(updatePeer).toHaveBeenCalledWith('peer-example', {
      mediaProvider: {
        enabled: true,
        audioModels: [{ engine: 'minimax-music3', modelId: 'minimax-music3' }],
        imageModels: [{ engine: 'comfy', modelId: 'sdxl-base' }],
        videoModels: [],
      },
    }));
  });

  it('keeps a selected model visible after the peer stops advertising it, so it can be removed', () => {
    render(<PeerMediaProviderPanel peer={{
      ...basePeer,
      mediaProvider: { enabled: true, videoModels: [{ engine: 'wan', modelId: 'wan-2.2' }] },
      mediaProviderStatus: readyStatus,
    }} onRefresh={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Remote media provider/i }));
    expect(screen.getByLabelText('Allow video model wan-2.2')).toBeChecked();
    expect(screen.getByText(/not-advertised/)).toBeInTheDocument();
  });

  it('explains that stale capacity blocks new work', () => {
    render(<PeerMediaProviderPanel peer={{
      ...basePeer,
      mediaProvider: { enabled: true, audioModels: [] },
      mediaProviderStatus: { ...readyStatus, state: 'stale', reason: 'stale' },
    }} onRefresh={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Remote media provider/i }));
    expect(screen.getByText(/capacity snapshot expired/i)).toBeInTheDocument();
  });
});
