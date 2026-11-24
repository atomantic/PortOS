import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const navigateMock = vi.hoisted(() => vi.fn());
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock('../services/apiHealth.js', () => ({
  getGenomeHealthCorrelations: vi.fn(),
}));
vi.mock('../services/apiSystem.js', () => ({
  getInsightThemes: vi.fn(),
  getInsightNarrative: vi.fn(),
  refreshInsightThemes: vi.fn(),
  refreshInsightNarrative: vi.fn(),
  getGoalScorecard: vi.fn(),
  getGoalScorecardSettings: vi.fn(),
  refreshGoalScorecardNarrative: vi.fn(),
}));

vi.mock('../components/ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../services/apiProviders.js', () => ({
  getProviders: vi.fn().mockResolvedValue([]),
}));

import toast from '../components/ui/Toast';
import TasteIdentityTab from '../components/insights/TasteIdentityTab';
import CrossDomainTab from '../components/insights/CrossDomainTab';
import GoalScorecardTab from '../components/insights/GoalScorecardTab';
import { getGenomeHealthCorrelations } from '../services/apiHealth.js';
import {
  getInsightThemes,
  getInsightNarrative,
  refreshInsightThemes,
  refreshInsightNarrative,
  getGoalScorecard,
  getGoalScorecardSettings,
  refreshGoalScorecardNarrative,
} from '../services/apiSystem.js';
import { OverviewTab, TABS } from './Insights';
import { expectPageNavTabs } from '../test/pageNavTabAssertions.js';

describe('Insights TABS ↔ nav manifest', () => {
  it('renders the insights tabGroup in page order with a presentation entry each', () => {
    expectPageNavTabs(TABS, [
      'overview:Overview', 'genome-health:Genome-Health', 'taste-identity:Taste & Identity', 'cross-domain:Cross-Domain Patterns', 'goal-scorecard:Goal Scorecard',
    ]);
  });
});

const renderOverview = () => render(
  <MemoryRouter>
    <OverviewTab />
  </MemoryRouter>,
);

describe('Insights OverviewTab cards', () => {
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

  it('falls back to the taste-profile deep link when the themes fetch fails', async () => {
    // A rejected fetch leaves `themesData` null — offering "Generate themes"
    // there would fail for anyone who has no profile yet.
    getInsightThemes.mockResolvedValue(null);
    renderOverview();
    expect(await screen.findByText('Complete taste profile')).toBeTruthy();
    expect(screen.queryByText('Generate themes')).toBeNull();
  });

  it('generates themes in place once a taste profile exists', async () => {
    getInsightThemes.mockResolvedValue({ available: false, reason: 'not_generated' });
    refreshInsightThemes.mockResolvedValue({
      available: true,
      themes: [{ title: 'Structured minimalism', strength: 'strong' }],
      generatedAt: '2026-11-24T00:00:00.000Z',
      model: 'example-model',
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
      generatedAt: '2026-11-24T00:00:00.000Z',
      previousText: null,
      previousGeneratedAt: null,
      model: 'example-model',
    });

    renderOverview();
    fireEvent.click(await screen.findByText('Analyze now'));

    await waitFor(() => expect(refreshInsightNarrative).toHaveBeenCalled());
    expect(await screen.findByText('Your sleep debt tracks your training load.')).toBeTruthy();
    expect(screen.queryByText('Analyze now')).toBeNull();
  });

  it.each([
    [['typical', 'concern'], 'Marker 2', 'Evidence 2'],
    [['concern', 'major_concern', 'major_concern'], 'Marker 2', 'Evidence 2'],
    [['beneficial', 'typical'], 'All markers reviewed', null],
  ])('summarizes genome marker statuses %j', async (statuses, summary, confidenceLabel) => {
    getGenomeHealthCorrelations.mockResolvedValue({
      available: true,
      totalMarkers: statuses.length,
      categories: statuses.map((status, index) => ({
        markers: [{
          status,
          name: `Marker ${index + 1}`,
          confidence: { level: 'moderate', label: `Evidence ${index + 1}` },
        }],
      })),
    });

    renderOverview();
    expect(await screen.findByText(summary)).toBeTruthy();
    if (confidenceLabel) expect(screen.getByText(confidenceLabel)).toBeTruthy();
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

describe('Insights generation results', () => {
  const narrative = {
    available: true,
    text: 'A cross-domain pattern.',
    generatedAt: '2026-11-24T00:00:00.000Z',
    previousText: null,
    previousGeneratedAt: null,
    model: 'example-model',
  };
  const themes = {
    available: true,
    themes: [{ title: 'A taste theme', strength: 'strong', narrative: 'A preference pattern.', evidence: [] }],
    generatedAt: narrative.generatedAt,
    model: narrative.model,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getGenomeHealthCorrelations.mockResolvedValue({ available: false });
    getInsightThemes.mockResolvedValue({ available: false, reason: 'not_generated' });
    getInsightNarrative.mockResolvedValue({ available: false, reason: 'not_generated' });
  });

  it.each([
    [TasteIdentityTab, refreshInsightThemes, themes, 'Generate Themes', 'A taste theme', 'no_taste_data',
      'Complete your taste profile before generating identity themes.'],
    [CrossDomainTab, refreshInsightNarrative, narrative, 'Generate Narrative', narrative.text, 'no_provider',
      'No AI provider is available. Configure an AI provider and try again.'],
  ])('renders a successful generation and preserves it on a failed refresh (%s)', async (
    Tab, refresh, result, generateLabel, content, reason, message
  ) => {
    refresh.mockResolvedValueOnce(result).mockResolvedValueOnce({ available: false, reason });
    render(<MemoryRouter><Tab /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: generateLabel }));
    expect(await screen.findByText(content)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledExactlyOnceWith(message));
    expect(screen.getByText(content)).toBeTruthy();
  });

  it.each([
    ['Generate themes', refreshInsightThemes, 'Provider quota exceeded', 'Provider quota exceeded'],
    ['Analyze now', refreshInsightNarrative, 'no_data', 'There is no data to analyze yet.'],
  ])('shows a generation failure on the overview and keeps %s available', async (label, refresh, reason, message) => {
    refresh.mockResolvedValueOnce({ available: false, reason });
    renderOverview();
    fireEvent.click(await screen.findByRole('button', { name: label }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledExactlyOnceWith(message));
    expect(screen.getByRole('button', { name: label }).disabled).toBe(false);
  });

  it('preserves the goal scorecard narrative and explains the empty provider result', async () => {
    getGoalScorecard.mockResolvedValue({
      available: true,
      totals: { totalSeconds: 60 },
      narrative: 'The previous weekly summary.',
    });
    getGoalScorecardSettings.mockResolvedValue({ enabled: true });
    refreshGoalScorecardNarrative.mockResolvedValueOnce({ available: false, reason: 'generation_failed' });
    render(<MemoryRouter><GoalScorecardTab /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Regenerate' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledExactlyOnceWith('The AI provider did not generate a scorecard narrative.'));
    expect(screen.getByText('The previous weekly summary.')).toBeTruthy();
  });
});
