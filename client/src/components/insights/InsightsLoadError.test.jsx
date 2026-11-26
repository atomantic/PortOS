import { MemoryRouter } from 'react-router';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  getInsightNarrative, getInsightThemes, getGoalScorecard, refreshInsightThemes,
} from '../../services/apiSystem.js';
import { getGenomeHealthCorrelations } from '../../services/apiHealth.js';
import CrossDomainTab from './CrossDomainTab.jsx';
import TasteIdentityTab from './TasteIdentityTab.jsx';
import GenomeHealthTab from './GenomeHealthTab.jsx';
import GoalScorecardTab from './GoalScorecardTab.jsx';
import { OverviewTab } from '../../pages/Insights.jsx';

import toast from '../ui/Toast';

vi.mock('../ui/Toast', () => ({ default: { error: vi.fn() } }));

vi.mock('../../services/apiSystem.js', () => ({
  getInsightNarrative: vi.fn(), getInsightThemes: vi.fn(), getGoalScorecard: vi.fn(),
  getGoalScorecardSettings: vi.fn().mockResolvedValue({}),
  getGoalScorecardRules: vi.fn(), saveGoalScorecardRules: vi.fn(),
  refreshInsightNarrative: vi.fn(), refreshInsightThemes: vi.fn(),
  computeGoalScorecard: vi.fn(), refreshGoalScorecardNarrative: vi.fn(),
  updateGoalScorecardSettings: vi.fn(),
}));
vi.mock('../../services/apiHealth.js', () => ({ getGenomeHealthCorrelations: vi.fn() }));
vi.mock('../../services/apiProviders.js', () => ({ getProviders: vi.fn().mockResolvedValue([]) }));

const GENERATE = /generate|compute|upload|analyze now/i;
const surfaces = [
  ['cross-domain', CrossDomainTab, getInsightNarrative, 'No cross-domain narrative generated yet.'],
  ['taste-identity', TasteIdentityTab, getInsightThemes, 'No taste identity themes generated yet.'],
  ['genome-health', GenomeHealthTab, getGenomeHealthCorrelations, /upload a raw genome file/],
  ['goal-scorecard', GoalScorecardTab, getGoalScorecard, 'No goal scorecard computed yet.'],
];

beforeEach(() => vi.clearAllMocks());

it.each(surfaces)('%s shows a load error with Retry, then the empty state once the read says unavailable', async (_n, Tab, read, empty) => {
  read.mockRejectedValueOnce(new Error('Server down')).mockResolvedValueOnce({ available: false });
  render(<MemoryRouter><Tab /></MemoryRouter>);

  expect(await screen.findByRole('alert')).toHaveTextContent('Server down');
  expect(screen.queryByRole('button', { name: GENERATE })).toBeNull();
  expect(screen.queryByRole('link', { name: GENERATE })).toBeNull();
  expect(read).toHaveBeenCalledWith(expect.objectContaining({ silent: true }));

  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText(empty)).toBeTruthy();
});

it('overview isolates a failed read to its own card and hides that card\'s action', async () => {
  getGenomeHealthCorrelations.mockRejectedValue(new Error('Genome down'));
  getInsightThemes.mockResolvedValue({ available: false, reason: 'not_generated' });
  getInsightNarrative.mockResolvedValue({ available: false });
  render(<MemoryRouter><OverviewTab /></MemoryRouter>);

  expect(await screen.findByRole('alert')).toHaveTextContent('Genome down');
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Upload genome' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Generate themes' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Analyze now' })).toBeTruthy();
});

it('keeps the displayed taste themes when refresh returns an invalid response', async () => {
  getInsightThemes.mockResolvedValue({
    available: true,
    themes: [{ title: 'Sparse arrangements', strength: 'tentative', narrative: '', evidence: [] }],
  });
  refreshInsightThemes.mockResolvedValue({ available: false, reason: 'invalid_response' });
  render(<MemoryRouter><TasteIdentityTab /></MemoryRouter>);

  expect(await screen.findByText('Sparse arrangements')).toBeVisible();
  expect(screen.getByText('Tentative pattern')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

  await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
    'The AI provider returned themes in a format PortOS could not read. Try again or pick another model.',
  ));
  expect(screen.getByText('Sparse arrangements')).toBeVisible();
});
