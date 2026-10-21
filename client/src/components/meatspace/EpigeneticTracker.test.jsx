import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../services/api', () => ({
  getEpigeneticInterventions: vi.fn(),
  getEpigeneticRecommendations: vi.fn(),
  getEpigeneticCompliance: vi.fn(),
}));

import * as api from '../../services/api';
import EpigeneticTracker from './EpigeneticTracker';

const CATEGORIES = [];
const REC = { id: 'omega3', name: 'Omega-3', category: 'supplement', evidence: 'strong' };

beforeEach(() => {
  api.getEpigeneticInterventions.mockResolvedValue({ interventions: {} });
  api.getEpigeneticCompliance.mockResolvedValue(null);
});
afterEach(cleanup);

describe('EpigeneticTracker recommendations load', () => {
  it('shows a retryable error — not an absent section — when recommendations fail, then lists them', async () => {
    api.getEpigeneticRecommendations.mockRejectedValueOnce(new Error('boom'));
    render(<EpigeneticTracker markerCategories={CATEGORIES} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load recommended interventions');
    expect(screen.queryByText(/Recommended Interventions/)).toBeNull();

    api.getEpigeneticRecommendations.mockResolvedValue({ recommendations: [REC] });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('Recommended Interventions (1)')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
