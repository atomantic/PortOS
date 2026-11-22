import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../services/apiMeatspace.js', () => ({
  getEpigeneticInterventions: vi.fn(),
  getEpigeneticRecommendations: vi.fn(),
  getEpigeneticCompliance: vi.fn(),
  updateEpigeneticIntervention: vi.fn().mockResolvedValue({}),
}));

import {
  getEpigeneticInterventions,
  getEpigeneticCompliance,
  getEpigeneticRecommendations,
} from '../../services/apiMeatspace.js';
import EpigeneticTracker from './EpigeneticTracker';

const CATEGORIES = [];
const REC = { id: 'omega3', name: 'Omega-3', category: 'supplement', evidence: 'strong' };

beforeEach(() => {
  getEpigeneticInterventions.mockResolvedValue({ interventions: {} });
  getEpigeneticCompliance.mockResolvedValue(null);
});
afterEach(cleanup);

describe('EpigeneticTracker recommendations load', () => {
  it('shows a retryable error — not an absent section — when recommendations fail, then lists them', async () => {
    getEpigeneticRecommendations.mockRejectedValueOnce(new Error('boom'));
    render(<EpigeneticTracker markerCategories={CATEGORIES} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load recommended interventions');
    expect(screen.queryByText(/Recommended Interventions/)).toBeNull();

    getEpigeneticRecommendations.mockResolvedValue({ recommendations: [REC] });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('Recommended Interventions (1)')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('EpigeneticTracker tracked-list load (#17353)', () => {
  const TRACKED = { omega3: { id: 'omega3', name: 'Omega-3', category: 'supplement', active: true, logs: [] } };

  it('shows a retryable alert and no Start Tracking when the tracked read fails, then recovers', async () => {
    getEpigeneticRecommendations.mockResolvedValue({ recommendations: [REC] });
    getEpigeneticInterventions.mockRejectedValueOnce(new Error('down'));
    render(<EpigeneticTracker markerCategories={CATEGORIES} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load tracked interventions');
    expect(screen.queryByText(/Recommended Interventions/)).toBeNull();

    getEpigeneticInterventions.mockResolvedValue({ interventions: TRACKED });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('Tracking (1)')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps a previously shown tracked row when a later read fails', async () => {
    getEpigeneticRecommendations.mockResolvedValue({ recommendations: [] });
    getEpigeneticInterventions.mockResolvedValueOnce({ interventions: TRACKED });
    render(<EpigeneticTracker markerCategories={CATEGORIES} />);
    await screen.findByText('Tracking (1)');

    getEpigeneticInterventions.mockRejectedValue(new Error('down'));
    fireEvent.click(screen.getByRole('button', { name: /Omega-3/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load tracked interventions');
    expect(screen.getByText('Tracking (1)')).toBeTruthy();
  });

  it('shows no alert for a successful empty list', async () => {
    getEpigeneticRecommendations.mockResolvedValue({ recommendations: [] });
    render(<EpigeneticTracker markerCategories={CATEGORIES} />);
    await waitFor(() => expect(screen.getByText(/These recommendations are informational/)).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
