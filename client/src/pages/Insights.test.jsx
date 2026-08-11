import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const navigateMock = vi.hoisted(() => vi.fn());
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock('../services/api', () => ({
  getGenomeHealthCorrelations: vi.fn(),
  getInsightThemes: vi.fn(),
  getInsightNarrative: vi.fn(),
  refreshInsightThemes: vi.fn(),
  refreshInsightNarrative: vi.fn(),
}));

vi.mock('../components/ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import {
  getGenomeHealthCorrelations,
  getInsightThemes,
  getInsightNarrative,
  refreshInsightThemes,
  refreshInsightNarrative,
} from '../services/api';
import { OverviewTab } from './Insights';

const renderOverview = () => render(
  <MemoryRouter>
    <OverviewTab />
  </MemoryRouter>,
);

describe('Insights OverviewTab empty cards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getGenomeHealthCorrelations.mockResolvedValue({ available: false });
    getInsightThemes.mockResolvedValue({ available: false, reason: 'no_taste_data' });
    getInsightNarrative.mockResolvedValue({ available: false });
  });

  it('never tells the user to click a Refresh control that is not on this screen', async () => {
    renderOverview();
    await screen.findByText('Analyze now');
    expect(screen.queryByText(/click refresh/i)).toBeNull();
  });

  it('routes the empty genome card to the genome upload screen', async () => {
    renderOverview();
    fireEvent.click(await screen.findByText('Upload genome'));
    expect(navigateMock).toHaveBeenCalledWith('/meatspace/genome');
  });

  it('deep-links the taste card to the taste profile when the prerequisite is missing', async () => {
    renderOverview();
    fireEvent.click(await screen.findByText('Complete taste profile'));
    expect(navigateMock).toHaveBeenCalledWith('/digital-twin/taste');
  });

  it('generates themes in place once a taste profile exists', async () => {
    getInsightThemes.mockResolvedValue({ available: false, reason: 'not_generated' });
    refreshInsightThemes.mockResolvedValue({
      available: true,
      themes: [{ title: 'Structured minimalism', strength: 'strong' }],
    });

    renderOverview();
    fireEvent.click(await screen.findByText('Generate themes'));

    await waitFor(() => expect(refreshInsightThemes).toHaveBeenCalled());
    expect(await screen.findByText('Structured minimalism')).toBeTruthy();
    expect(screen.queryByText('Generate themes')).toBeNull();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('analyzes cross-domain patterns from the card and shows the result', async () => {
    refreshInsightNarrative.mockResolvedValue({
      available: true,
      text: 'Your sleep debt tracks your training load. It compounds weekly.',
      generatedAt: new Date().toISOString(),
    });

    renderOverview();
    fireEvent.click(await screen.findByText('Analyze now'));

    await waitFor(() => expect(refreshInsightNarrative).toHaveBeenCalled());
    expect(await screen.findByText('Your sleep debt tracks your training load.')).toBeTruthy();
    expect(screen.queryByText('Analyze now')).toBeNull();
  });

  it('drops the action button once a card has content', async () => {
    getGenomeHealthCorrelations.mockResolvedValue({
      available: true,
      totalMarkers: 12,
      categories: [],
      sources: [],
    });

    renderOverview();
    expect(await screen.findByText('12 markers analyzed')).toBeTruthy();
    expect(screen.queryByText('Upload genome')).toBeNull();
  });
});
