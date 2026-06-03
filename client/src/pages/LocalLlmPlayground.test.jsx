import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../services/api', () => ({
  getLocalLlmStatus: vi.fn(),
  getLocalLlmCatalog: vi.fn(),
  testLocalLlmModel: vi.fn(),
  compareLocalLlmModels: vi.fn(),
}));

vi.mock('../components/ui/Toast', () => ({
  default: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import LocalLlmPlayground from './LocalLlmPlayground';
import { getLocalLlmCatalog, getLocalLlmStatus } from '../services/api';

const renderPlayground = () => render(
  <MemoryRouter initialEntries={['/local-llm/playground?backend=ollama&model=command-r-plus%3A104b']}>
    <LocalLlmPlayground />
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  getLocalLlmStatus.mockResolvedValue({
    backend: 'ollama',
    ollama: {
      models: [
        {
          id: 'command-r-plus:104b',
          name: 'command-r-plus:104b',
          size: 59 * 1024 ** 3,
          params: '104B',
          quantization: null,
          family: 'command-r',
        },
      ],
    },
    lmstudio: { models: [] },
  });
  getLocalLlmCatalog.mockResolvedValue({
    backend: 'ollama',
    models: [
      {
        id: 'command-r-plus:104b',
        name: 'Command R+ 104B',
        category: 'chat',
        params: '104B',
        size: '59 GB',
        family: 'command-r',
        description: 'Cohere long-context model tuned for RAG and dialogue.',
        capabilities: ['chat', 'tools', 'multilingual'],
      },
    ],
  });
});

describe('LocalLlmPlayground', () => {
  it('shows model size, memory requirements, and use-case tags in the selector', async () => {
    renderPlayground();

    await waitFor(() => expect(screen.getAllByText('command-r-plus:104b').length).toBeGreaterThan(0));

    expect(getLocalLlmCatalog).toHaveBeenCalledWith('ollama');
    expect(screen.getByText('104B · 59 GB · ~71 GB RAM')).toBeTruthy();
    expect(screen.getByText('Tool use')).toBeTruthy();
    expect(screen.getByText('Multilingual')).toBeTruthy();
  });
});
