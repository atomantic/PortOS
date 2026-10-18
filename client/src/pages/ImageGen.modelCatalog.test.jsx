/**
 * The local model catalog read (#12040): a failed load shows an error row with
 * Retry and a genuinely empty catalog its own copy — neither renders as the
 * other, and the Model select only appears once a catalog has landed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { state, resetImageGenMockState, imageGenModel, loadImageGenPage, renderImageGenPage } from '../test/imageGenPageMocks.jsx';

await loadImageGenPage();

const DEV = imageGenModel('dev', { name: 'FLUX.1 Dev' });

describe('ImageGen local model catalog load state (#12040)', () => {
  beforeEach(() => {
    resetImageGenMockState();
  });

  it('shows a failed catalog read with Retry, then the Model select once the retry lands', async () => {
    state.models = [DEV];
    state.listImageModels.mockRejectedValueOnce(new Error('catalog down'));
    await renderImageGenPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load the local model catalog — catalog down');
    expect(screen.queryByLabelText('Model')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByLabelText('Model')).toBeInTheDocument());
    expect(screen.getByRole('option', { name: 'FLUX.1 Dev' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the empty copy for a genuinely empty catalog, not an error', async () => {
    state.models = [];
    await renderImageGenPage();
    expect(await screen.findByRole('status', { name: '' })).toHaveTextContent('No local image models are compatible with this machine.');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Model')).not.toBeInTheDocument();
  });
});
