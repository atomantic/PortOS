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
    .mockResolvedValueOnce({ ollama: { models: [] }, lmstudio: { models: [] } })
    .mockResolvedValueOnce({ ollama: { models: [] }, lmstudio: { models: [{ id: 'example/custom-embedding' }] } }),
}));
vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

import EmbeddingsTab from './EmbeddingsTab.jsx';
import { getSettings, updateSettings } from '../../services/apiSystem';
import { getLocalLlmStatus } from '../../services/apiLocalLlm';

describe('EmbeddingsTab', () => {
  it('reads installed embedding choices from the public models field for both backends', async () => {
    render(<MemoryRouter><EmbeddingsTab /></MemoryRouter>);

    const datalist = () => document.getElementById('embeddings-model-options');
    await waitFor(() => expect(datalist().querySelector('option[value="custom-embed:latest"]')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(datalist().querySelector('option[value="custom-embed:latest"]')).toBeFalsy());
    expect(datalist().querySelector('option[value="nomic-embed-text"]')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'manual-embedding-model' } });
    expect(screen.getByLabelText('Model')).toHaveValue('manual-embedding-model');

    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'lmstudio' } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(datalist().querySelector('option[value="example/custom-embedding"]')).toBeTruthy());
  });

  it('blocks the form instead of showing "Disabled" when the settings read fails', async () => {
    getSettings.mockRejectedValueOnce(new Error('Server unavailable'));
    getLocalLlmStatus.mockResolvedValue({ ollama: { models: [] }, lmstudio: { models: [] } });
    render(<MemoryRouter><EmbeddingsTab /></MemoryRouter>);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load embeddings settings');
    expect(screen.queryByText(/Saved: Disabled/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(updateSettings).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('Provider')).toHaveValue('ollama');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a failed installed-model read as a retryable error', async () => {
    getLocalLlmStatus.mockRejectedValueOnce(new Error('Ollama unreachable'))
      .mockResolvedValueOnce({ ollama: { models: [{ id: 'custom-embed:latest' }] }, lmstudio: { models: [] } });
    render(<MemoryRouter><EmbeddingsTab /></MemoryRouter>);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load installed models — Ollama unreachable');

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(document.querySelector('option[value="custom-embed:latest"]')).toBeTruthy());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('keeps the last installed models and reports a backend whose model list failed', async () => {
    getLocalLlmStatus.mockResolvedValueOnce({ ollama: { models: [{ id: 'custom-embed:latest' }], modelsError: null }, lmstudio: { models: [] } })
      .mockResolvedValueOnce({ ollama: { models: [], modelsError: 'Ollama model list (/api/tags) returned no data' }, lmstudio: { models: [] } });
    render(<MemoryRouter><EmbeddingsTab /></MemoryRouter>);
    await waitFor(() => expect(document.querySelector('option[value="custom-embed:latest"]')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load installed models — Ollama model list (/api/tags) returned no data');
    expect(document.querySelector('option[value="custom-embed:latest"]')).toBeTruthy();
  });
  it('treats a stopped backend as an unlisted one, not as having no models', async () => {
    getSettings.mockResolvedValueOnce({ embeddings: { provider: 'lmstudio', model: '' } });
    getLocalLlmStatus.mockResolvedValueOnce({ ollama: { models: [] }, lmstudio: { available: true, models: [{ id: 'example/custom-embedding' }], modelsError: null } })
      .mockResolvedValueOnce({ ollama: { models: [] }, lmstudio: { available: false, models: [], modelsError: null } });
    render(<MemoryRouter><EmbeddingsTab /></MemoryRouter>);
    await waitFor(() => expect(document.querySelector('option[value="example/custom-embedding"]')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load installed models — LM Studio is not running');
    expect(document.querySelector('option[value="example/custom-embedding"]')).toBeTruthy();
  });
});
