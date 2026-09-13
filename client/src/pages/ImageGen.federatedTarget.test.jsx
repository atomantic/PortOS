import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';

import {
  imageGenPeer,
  loadImageGenPage,
  renderImageGenPage,
  resetImageGenMockState,
  state,
} from '../test/imageGenPageMocks.jsx';

await loadImageGenPage();

// Mounts and types the default prompt, exactly as the suite always did: these
// tests assert over the submitted payload, so the form must be filled first.
const mount = async (promptText = 'a lighthouse at dusk') => {
  await renderImageGenPage();
  fireEvent.change(await screen.findByLabelText('Prompt'), { target: { value: promptText } });
};

describe('ImageGen federated render target', () => {
  beforeEach(() => {
    resetImageGenMockState();
    // A peer opted in as an image provider, advertising one allowlisted model
    // with a verifiable freshness window — the shape `GET /api/instances`
    // returns that makes the generation-target picker appear.
    state.peers = [imageGenPeer()];
    state.settings = {
      imageGen: { mode: 'local', local: { pythonPath: '/usr/bin/python3' }, grok: { enabled: true } },
    };
  });

  // The whole point of the picker: a peer's model reaches the generate route as
  // an explicit (peer, engine, model) selection, and nothing that only describes
  // a LOCAL dispatch rides along with it.
  it('submits the peer, its engine and its model — and no local-only fields', async () => {
    await mount();
    fireEvent.change(await screen.findByRole('combobox', { name: /generation target/i }), { target: { value: 'peer-example' } });

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Generate$/ })); });

    await waitFor(() => expect(state.generateImage).toHaveBeenCalled());
    expect(state.generateImage.mock.calls[0][0]).toMatchObject({
      prompt: 'a lighthouse at dusk',
      mediaProviderPeerId: 'peer-example',
      mediaProviderEngine: 'local',
      modelId: 'peer-flux',
    });
    // `mode` picks a local dispatcher lane, `quantize` and the cleaners describe
    // work on this machine's bytes — none of them mean anything on a peer.
    for (const field of ['mode', 'quantize', 'cleanC2PA', 'denoise', 'loraFilenames', 'cloudModel']) {
      expect(state.generateImage.mock.calls[0][0]).not.toHaveProperty(field);
    }
  });

  it('adds the selected universe positive and negative style tokens to the image payload', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Use universe style' }));

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Generate$/ })); });

    await waitFor(() => expect(state.generateImage).toHaveBeenCalled());
    expect(state.generateImage.mock.calls[0][0]).toMatchObject({
      prompt: 'inky linework. a lighthouse at dusk',
      negativePrompt: expect.stringContaining('glossy'),
    });
  });

  it('hides the generation target field when Grok is selected', async () => {
    await mount();
    fireEvent.click(await screen.findByRole('button', { name: /Grok/i }));

    await waitFor(() => expect(screen.queryByRole('combobox', { name: /generation target/i })).not.toBeInTheDocument());
  });

  // A stale snapshot still records `state: 'ready'`; gating on it would leave
  // Generate live against a peer the server is about to refuse.
  it('disables Generate and explains why when the peer’s capacity window lapsed', async () => {
    const { getInstances } = await import('../services/api');
    getInstances.mockResolvedValueOnce({
      peers: [{
        ...imageGenPeer(),
        mediaProviderStatus: { ...imageGenPeer().mediaProviderStatus, freshUntil: new Date(Date.now() - 60_000).toISOString() },
      }],
    });
    await mount();
    fireEvent.change(await screen.findByRole('combobox', { name: /generation target/i }), { target: { value: 'peer-example' } });

    expect(screen.getByText(/capacity snapshot expired/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Generate$/ })).toBeDisabled();
    expect(state.generateImage).not.toHaveBeenCalled();
  });
});
