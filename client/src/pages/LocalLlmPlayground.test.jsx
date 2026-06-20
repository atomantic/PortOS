import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../services/api', () => ({
  getLocalLlmStatus: vi.fn(),
  getLocalLlmCatalog: vi.fn(),
  getLoadedLlmModels: vi.fn(),
  testLocalLlmModel: vi.fn(),
  streamLocalLlmTest: vi.fn(),
  compareLocalLlmModels: vi.fn(),
}));

vi.mock('../components/ui/Toast', () => ({
  default: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import LocalLlmPlayground from './LocalLlmPlayground';
import { getLoadedLlmModels, getLocalLlmCatalog, getLocalLlmStatus, streamLocalLlmTest } from '../services/api';

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
  getLoadedLlmModels.mockResolvedValue({ ollama: [] });
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

  it('flags a model that is resident in memory with its VRAM size', async () => {
    getLoadedLlmModels.mockResolvedValue({
      ollama: [
        // Ollama's /api/ps reports the tagged name and VRAM footprint; the
        // sidebar should reconcile it to the installed row and show "In memory".
        { id: 'command-r-plus:104b', name: 'command-r-plus:104b', size: 59 * 1024 ** 3, sizeVram: 60 * 1024 ** 3, expiresAt: null },
      ],
    });

    renderPlayground();

    // The badge reports residency AND the model's VRAM footprint (60 GB), and
    // the header chip summarizes the count.
    await waitFor(() => expect(screen.getByText(/In memory · 60 GB/)).toBeTruthy());
    expect(screen.getByText(/1 in memory/)).toBeTruthy();
  });

  it('renders a live "Thinking" block for streamed reasoning, separate from the answer', async () => {
    // Drive reasoning tokens then a content token through the streaming callback,
    // mirroring a reasoning model (deepseek-r1, qwq) that emits its chain-of-thought
    // first. The reasoning must render in its own block; the answer text stays clean.
    // Hold the run open (gate) so the live streaming panel stays mounted while we
    // assert — once the promise resolves, the panel is replaced by the result.
    let releaseRun;
    const runGate = new Promise((resolve) => { releaseRun = resolve; });
    streamLocalLlmTest.mockImplementation(async (_payload, { onToken }) => {
      onToken('reasoning step one ', 'reasoning');
      onToken('reasoning step two', 'reasoning');
      onToken('Final answer.', 'content');
      await runGate;
      return { backend: 'ollama', modelId: 'command-r-plus:104b', text: 'Final answer.', runId: 'run-x', timings: {} };
    });

    renderPlayground();
    await waitFor(() => expect(screen.getAllByText('command-r-plus:104b').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByText('Run chat'));

    // The reasoning block label and its streamed text appear (flushed on the 80ms timer).
    await waitFor(() => expect(screen.getByText('Thinking')).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/reasoning step one reasoning step two/)).toBeTruthy());
    // The streaming answer renders the content channel only — reasoning isn't mixed in.
    await waitFor(() => expect(screen.getByText('Final answer.')).toBeTruthy());

    releaseRun();
  });
});
