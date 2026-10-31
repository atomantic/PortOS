import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../../services/api', () => ({
  getDigitalTwinEnrichProgress: vi.fn(),
  getDigitalTwinEnrichQuestion: vi.fn(),
  getProviders: vi.fn(),
  analyzeWritingSamples: vi.fn(),
}));
vi.mock('../../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../TwinProviderPicker.jsx', () => ({
  default: ({ providers }) => <div data-testid="picker">{providers.map((p) => p.id).join(',')}</div>,
}));
vi.mock('../ListEnrichment', () => ({ default: () => null }));

import * as api from '../../../services/api';
import EnrichTab from './EnrichTab';

describe('EnrichTab provider list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getDigitalTwinEnrichProgress.mockResolvedValue({ categories: {} });
  });

  it('shows an error with Retry instead of an empty picker when the provider list fails', async () => {
    api.getProviders
      .mockRejectedValueOnce(new Error('providers down'))
      .mockResolvedValueOnce({ providers: [{ id: 'example', enabled: true, defaultModel: 'm' }] });
    render(<MemoryRouter><EnrichTab /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: /Analyze Your Writing/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not load AI providers/i);
    expect(screen.queryByTestId('picker')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByTestId('picker')).toHaveTextContent('example'));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('EnrichTab progress load', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getProviders.mockResolvedValue({ providers: [] });
  });

  it('shows an error with Retry instead of "0/10 categories complete" when the progress read fails', async () => {
    api.getDigitalTwinEnrichProgress
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ completedCount: 2, totalCategories: 10, categories: {} });
    render(<MemoryRouter><EnrichTab /></MemoryRouter>);

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not load enrichment progress.*offline/);
    expect(screen.queryByText(/categories complete/)).toBeNull();
    expect(screen.queryByText(/questions answered/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('2/10 categories complete')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('EnrichTab question load', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getProviders.mockResolvedValue({ providers: [] });
    api.getDigitalTwinEnrichProgress.mockResolvedValue({ categories: {} });
  });

  it('offers Retry instead of "All questions ... answered" when the question read fails', async () => {
    api.getDigitalTwinEnrichQuestion
      .mockRejectedValueOnce(new Error('provider down'))
      .mockResolvedValueOnce({ questionId: 'q1', question: 'Describe a formative memory.', questionIndex: 0, totalQuestions: 3 });
    render(<MemoryRouter><EnrichTab /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: /Core Memories/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not load the next question.*provider down/);
    expect(screen.queryByText(/All questions for this category have been answered/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    // While the retry is in flight the session stays open; the category grid is not shown.
    expect(screen.queryByRole('button', { name: /Favorite Books/ })).toBeNull();
    expect(await screen.findByText('Describe a formative memory.')).toBeInTheDocument();
    expect(api.getDigitalTwinEnrichQuestion).toHaveBeenLastCalledWith('core_memories', undefined, undefined, undefined, { silent: true });
  });

  it('still reports a finished category when the server has no more questions', async () => {
    api.getDigitalTwinEnrichQuestion.mockResolvedValue(null);
    render(<MemoryRouter><EnrichTab /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: /Core Memories/ }));
    expect(await screen.findByText(/All questions for this category have been answered/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('drops a question that lands after the user left for another category', async () => {
    let resolveSkip;
    api.getDigitalTwinEnrichQuestion
      .mockResolvedValueOnce({ questionId: 'q1', question: 'Describe a formative memory.', questionIndex: 0 })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSkip = resolve; }))
      .mockResolvedValueOnce({ questionId: 'q3', question: 'How do you prefer to communicate?', questionIndex: 0 });
    render(<MemoryRouter><EnrichTab /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: /Core Memories/ }));
    await screen.findByText('Describe a formative memory.');
    fireEvent.click(screen.getByRole('button', { name: /Skip/ }));
    fireEvent.click(screen.getByRole('button', { name: /Back to categories/ }));
    fireEvent.click(await screen.findByRole('button', { name: /^Communication/ }));
    expect(await screen.findByText('How do you prefer to communicate?')).toBeInTheDocument();

    resolveSkip({ questionId: 'q2', question: 'A stale memory question.', questionIndex: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('A stale memory question.')).toBeNull();
    expect(screen.getByText('How do you prefer to communicate?')).toBeInTheDocument();
  });
});

