import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../services/apiMeatspace.js', () => ({
  getEpigeneticInterventions: vi.fn(),
  getEpigeneticRecommendations: vi.fn(),
  getEpigeneticCompliance: vi.fn(),
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
