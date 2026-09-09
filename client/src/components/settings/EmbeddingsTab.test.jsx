import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../services/apiSystem', () => ({
  getSettings: vi.fn().mockResolvedValue({ embeddings: { provider: 'ollama', model: '' } }),
  updateSettings: vi.fn(),
}));
vi.mock('../../services/apiLocalLlm', () => ({
  getLocalLlmStatus: vi.fn()
    .mockResolvedValueOnce({ ollama: { models: [{ id: 'custom-embed:latest' }] }, lmstudio: { models: [] } })
    .mockResolvedValueOnce({ ollama: { models: [] }, lmstudio: { models: [{ id: 'example/custom-embedding' }] } }),
}));
vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

import EmbeddingsTab from './EmbeddingsTab.jsx';

describe('EmbeddingsTab', () => {
  it('reads installed embedding choices from the public models field for both backends', async () => {
    render(<MemoryRouter><EmbeddingsTab /></MemoryRouter>);

    const datalist = () => document.getElementById('embeddings-model-options');
    await waitFor(() => expect(datalist().querySelector('option[value="custom-embed:latest"]')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'lmstudio' } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(datalist().querySelector('option[value="example/custom-embedding"]')).toBeTruthy());
  });
});
