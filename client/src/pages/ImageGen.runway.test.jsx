import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { loadImageGenPage, renderImageGenPage, resetImageGenMockState, state } from '../test/imageGenPageMocks.jsx';

vi.mock('../hooks/useRunwayCatalog.js', () => ({
  useRunwayCatalog: () => ({ imageModels: [
    { id: 'gen4_image', label: 'Runway Gen-4 Image' },
    { id: 'gen4_image_turbo', label: 'Runway Gen-4 Image Turbo' },
  ] }),
}));

await loadImageGenPage();

describe('ImageGen Runway default model', () => {
  beforeEach(() => {
    resetImageGenMockState();
    state.settings = { imageGen: { mode: 'runway', runway: { enabled: true, model: 'gen4_image_turbo' } } };
  });

  it('generates with the available Settings model without turning inheritance into a per-render override', async () => {
    await renderImageGenPage();
    const model = await screen.findByLabelText('Runway model');
    await waitFor(() => expect(model).toHaveValue(''));
    expect(screen.getByRole('option', { name: 'Settings default (gen4_image_turbo)' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /unavailable/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'A lighthouse at dusk' } });
    const generate = screen.getByRole('button', { name: /^Generate$/ });
    await waitFor(() => expect(generate).toBeEnabled());
    await act(async () => { fireEvent.click(generate); });
    await waitFor(() => expect(state.generateImage).toHaveBeenCalled());
    expect(state.generateImage.mock.calls[0][0]).toMatchObject({ mode: 'runway', prompt: 'A lighthouse at dusk' });
    expect(state.generateImage.mock.calls[0][0]).not.toHaveProperty('cloudModel');
  });
});
