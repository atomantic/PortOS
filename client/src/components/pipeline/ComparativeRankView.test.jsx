import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('../../services/apiPipeline', () => ({
  getComparativeRank: vi.fn(),
  runComparativeRank: vi.fn(),
}));

vi.mock('../../hooks/useAsyncAction', () => ({
  useAsyncAction: (action) => [action, false],
}));

import { getComparativeRank } from '../../services/apiPipeline';
import ComparativeRankView from './ComparativeRankView';

beforeEach(() => vi.clearAllMocks());

describe('ComparativeRankView partial rankings', () => {
  it('labels budget-stopped data as non-authoritative and hides revision priority claims', async () => {
    getComparativeRank.mockResolvedValue({
      status: 'partial',
      budgetStopped: true,
      entrants: 4,
      matches: [],
      ranking: [
        { issueId: 'iss-1', label: 'E1', title: 'Example issue', rating: 1000, wins: 0, losses: 0 },
      ],
      weakest: [],
    });

    render(<ComparativeRankView seriesId="ser-1" hasContent />);

    await waitFor(() => expect(screen.getByText('Partial ranking — not complete comparative evidence')).toBeTruthy());
    expect(screen.getByText(/These standings are not used to choose an autopilot revision priority/)).toBeTruthy();
    expect(screen.queryByText('revision priority')).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Elo' })).toBeNull();
  });
});
