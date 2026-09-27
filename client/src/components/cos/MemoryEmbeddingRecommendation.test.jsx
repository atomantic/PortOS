import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import MemoryEmbeddingRecommendation from './MemoryEmbeddingRecommendation';
import { installLocalLlmModel } from '../../services/apiLocalLlm';
import toast from '../ui/Toast';

vi.mock('../../services/apiLocalLlm', () => ({ installLocalLlmModel: vi.fn() }));
vi.mock('../ui/Toast', () => ({ default: { error: vi.fn() } }));
beforeEach(() => vi.clearAllMocks());

it('downloads only on request and saves the recommendation only after explicit selection', async () => {
  let finish;
  installLocalLlmModel.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const onSelect = vi.fn().mockResolvedValue({});
  render(<MemoryRouter><MemoryEmbeddingRecommendation onSelect={onSelect} /></MemoryRouter>);
  expect(installLocalLlmModel).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Download nomic-embed-text' }));
  expect(screen.getByRole('button', { name: /Downloading/ })).toBeDisabled();
  expect(installLocalLlmModel).toHaveBeenCalledWith('ollama', 'nomic-embed-text', { silent: true });
  finish({ success: true });
  fireEvent.click(await screen.findByRole('button', { name: 'Use for memory embeddings' }));
  await waitFor(() => expect(onSelect).toHaveBeenCalledWith('ollama', 'nomic-embed-text'));
});

it('keeps failed downloads retryable without changing the saved selection', async () => {
  installLocalLlmModel.mockRejectedValue(new Error('Ollama is unavailable'));
  const onSelect = vi.fn();
  render(<MemoryRouter><MemoryEmbeddingRecommendation onSelect={onSelect} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Download nomic-embed-text' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Ollama is unavailable'));
  expect(screen.getByRole('button', { name: 'Download nomic-embed-text' })).toBeEnabled();
  expect(onSelect).not.toHaveBeenCalled();
});
