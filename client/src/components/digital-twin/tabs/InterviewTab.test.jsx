import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../../services/api', () => ({
  getDigitalTwinGaps: vi.fn(),
  getDigitalTwinEnrichProgress: vi.fn(),
  analyzeAssessment: vi.fn(),
}));
vi.mock('../../../hooks/useProviderModels', () => ({
  default: () => ({
    providers: [], selectedProviderId: '', selectedModel: '', availableModels: [],
    setSelectedProviderId: vi.fn(), setSelectedModel: vi.fn(), loading: false,
  }),
}));
vi.mock('../../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import * as api from '../../../services/api';
import InterviewTab from './InterviewTab';

const renderTab = () => render(<MemoryRouter><InterviewTab /></MemoryRouter>);

describe('InterviewTab gaps load', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getDigitalTwinEnrichProgress.mockResolvedValue({ categories: {} });
  });

  it('shows an error with Retry, not "No gap data available", when the gaps read fails', async () => {
    api.getDigitalTwinGaps
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ gaps: [{ dimension: 'openness', confidence: 0.2, suggestedCategory: null }] });
    renderTab();

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not load enrichment gaps.*offline/i);
    expect(screen.queryByText(/No gap data available/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('openness')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the empty copy for a genuinely empty gap list', async () => {
    api.getDigitalTwinGaps.mockResolvedValue({ gaps: [] });
    renderTab();
    expect(await screen.findByText(/No gap data available/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});

describe('InterviewTab enrichment progress load', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getDigitalTwinGaps.mockResolvedValue({ gaps: [] });
  });

  it('shows an error with Retry instead of every category at 0% when the progress read fails', async () => {
    api.getDigitalTwinEnrichProgress
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ categories: { core_memories: { percentage: 40 } } });
    renderTab();

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not load enrichment progress.*offline/);
    expect(screen.queryByText('0%')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('40%')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
