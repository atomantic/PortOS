import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';

import {
  loadVideoGenPage,
  renderVideoGenPage,
  resetVideoGenMockState,
  state,
  videoGenModel,
  videoGenStatus,
  videoGenTermsGate,
} from '../test/videoGenPageMocks.jsx';

const TERMS_ID = 'minimax-h3-license-v1';
const MODEL = videoGenModel('h3-one', { termsGate: videoGenTermsGate(TERMS_ID) });

// A peer opted in as a video provider, advertising one allowlisted model with a
// verifiable freshness window — the shape `GET /api/instances` returns.
const PEER = {
  id: 'peer-example',
  name: 'Example GPU',
  status: 'online',
  enabled: true,
  mediaProvider: { enabled: true, videoModels: [{ engine: 'local', modelId: 'peer-wan' }] },
  mediaProviderStatus: {
    state: 'ready',
    checkedAt: new Date().toISOString(),
    freshUntil: new Date(Date.now() + 60_000).toISOString(),
    snapshot: {
      queue: { accepting: true, running: 0, queued: 0, totalActive: 0, maxQueuedJobs: 4 },
      capabilities: [{
        kind: 'video', engine: 'local', engineName: 'Local video', modelId: 'peer-wan',
        modelName: 'Wan 2.2 T2V', ready: true, unavailableReason: null,
        runtimeReady: true, platformSupported: true, cudaRequired: false, cudaState: 'available',
      }],
    },
  },
};

await loadVideoGenPage();

const startRender = async (promptText = 'a fox watches the rain') => {
  await renderVideoGenPage();
  fireEvent.change(await screen.findByLabelText('Prompt'), { target: { value: promptText } });
};

describe('VideoGen federated render target', () => {
  beforeEach(() => {
    resetVideoGenMockState();
    state.peers = [PEER];
    state.getVideoGenStatus.mockResolvedValue(videoGenStatus([MODEL]));
    state.modelStatuses = { [MODEL.id]: { id: MODEL.id, repo: MODEL.repo, cached: true, sizeBytes: 100 } };
    state.generateVideo.mockReturnValue(new Promise(() => {}));
    state.attach.mockReturnValue(new Promise(() => {}));
  });

  // The whole point of the picker: a peer's model reaches the generate route as
  // an explicit (peer, engine, model) selection, and nothing that only describes
  // a LOCAL dispatch rides along with it.
  it('submits the peer, its engine and its model — and no local-only fields', async () => {
    await startRender();
    fireEvent.change(await screen.findByRole('combobox', { name: /generation target/i }), { target: { value: 'peer-example' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Generate$/ })).toBeEnabled());

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Generate$/ })); });

    await waitFor(() => expect(state.generateVideo).toHaveBeenCalled());
    const payload = state.generateVideo.mock.calls[0][0];
    expect(payload).toMatchObject({
      backend: 'local',
      mode: 'text',
      prompt: 'a fox watches the rain',
      mediaProviderPeerId: 'peer-example',
      mediaProviderEngine: 'local',
      modelId: 'peer-wan',
    });
    // Every one of these means "run this on my hardware" and the provider route
    // refuses a body carrying them.
    for (const field of ['sourceImageFile', 'lastImageFile', 'keyframes', 'extendFromVideoId', 'audioFile', 'loraFilenames', 'textEncoderId', 'tiling', 'chunks']) {
      expect(payload).not.toHaveProperty(field);
    }
  });

  // The local model dropdown lists models the peer does not have. Leaving it
  // visible would let a stale selection read as the model that rendered the clip.
  it('replaces the local model dropdown with the peer’s advertised models', async () => {
    await startRender();
    expect(screen.getByRole('option', { name: /MiniMax h3-one/ })).toBeInTheDocument();

    fireEvent.change(await screen.findByRole('combobox', { name: /generation target/i }), { target: { value: 'peer-example' } });

    expect(screen.queryByRole('option', { name: /MiniMax h3-one/ })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Wan 2\.2 T2V/ })).toBeInTheDocument();
  });
  // Image-to-video is no longer refused outright (ADR
  // docs/decisions/2026-08-22-federated-media-input-assets.md rule 1): the
  // FRAME is what has to cross, and whether it can is a per-model question
  // answered at the moment one is picked. Selecting the mode with no frame yet
  // conditions nothing, so blocking there would refuse a render that is still
  // a plain text-to-video job.
  it('lets image mode be selected on a peer, since a mode alone conditions nothing', async () => {
    await startRender();
    fireEvent.change(await screen.findByRole('combobox', { name: /generation target/i }), { target: { value: 'peer-example' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Generate$/ })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: /^Image$/ }));

    expect(screen.queryByText(/cannot take/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Generate$/ })).toBeEnabled();
  });

  // Extend and audio-to-video are multi-step CHAIN STATE and an input the wire
  // has no field for (rule 4) — still refused, and refused at the MODE rather
  // than only at the input, since the mode can be set before its input is
  // filled. Blocking must beat dropping: an a2v render that reached the peer as
  // plain text-to-video is a valid-looking clip of a different thing.
  it.each([['Extend'], ['Audio']])('blocks %s mode, which cannot cross at all', async (label) => {
    await startRender();
    fireEvent.change(await screen.findByRole('combobox', { name: /generation target/i }), { target: { value: 'peer-example' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Generate$/ })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${label}$`) }));

    expect(screen.getByText(/cannot take/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Generate$/ })).toBeDisabled();
  });
});
