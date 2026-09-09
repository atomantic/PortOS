import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../services/apiSystem', () => ({
  getSettings: vi.fn().mockResolvedValue({ embeddings: { provider: 'ollama', model: '' } }),
  updateSettings: vi.fn(),
}));
vi.mock('../../services/apiLocalLlm', () => ({
  getLocalLlmStatus: vi.fn().mockResolvedValue({
    ollama: { models: [{ id: 'nomic-embed-text' }] },
    lmstudio: { models: [] },
  }),
}));
vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

import EmbeddingsTab from './EmbeddingsTab.jsx';

describe('EmbeddingsTab', () => {
  it('reads installed embedding choices from the public models field', async () => {
    render(<MemoryRouter><EmbeddingsTab /></MemoryRouter>);

    await waitFor(() => expect(screen.getByRole('option', { name: 'nomic-embed-text' })).toBeInTheDocument());
  });
});
