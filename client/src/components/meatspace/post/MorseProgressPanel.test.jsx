import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('../../../services/api', () => ({
  getMorseProgress: vi.fn(),
}));

import MorseProgressPanel from './MorseProgressPanel';
import { getMorseProgress } from '../../../services/api';

const EMPTY = {
  days: 30, kochLevel: 2, kochLevelSet: false, settings: null, totalRounds: 0,
  series: { copy: [], 'head-copy': [], send: [] }, confusionMatrix: {}, confusionPairs: [], charAccuracy: [],
};

beforeEach(() => {
  getMorseProgress.mockReset();
});

describe('MorseProgressPanel', () => {
  it('fetches the 30-day window on mount and shows the empty state', async () => {
    getMorseProgress.mockResolvedValue(EMPTY);
    render(<MorseProgressPanel />);
    await waitFor(() => expect(getMorseProgress).toHaveBeenCalledWith(30, expect.objectContaining({ silent: true })));
    expect(await screen.findByText(/Complete a round to see accuracy trends/)).toBeInTheDocument();
  });

  it('renders the confusion pairs and worst-first character mastery when data exists', async () => {
    getMorseProgress.mockResolvedValue({
      ...EMPTY,
      totalRounds: 2,
      series: { copy: [{ id: 'r1', date: '2026-07-01', accuracy: 80, effectiveWpm: 12 }, { id: 'r2', date: '2026-07-02', accuracy: 90, effectiveWpm: 12 }], 'head-copy': [], send: [] },
      confusionMatrix: { M: { R: 2 } },
      confusionPairs: [{ sent: 'M', guessed: 'R', count: 2 }],
      charAccuracy: [{ char: 'M', correct: 0, attempts: 2, accuracy: 0 }, { char: 'K', correct: 2, attempts: 2, accuracy: 100 }],
    });
    render(<MorseProgressPanel />);
    expect(await screen.findByText('Most-confused pairs')).toBeInTheDocument();
    expect(screen.getByText(/Drill these next/)).toBeInTheDocument();
    // Worst-first character (M, 0%) and its confusion counts surface.
    expect(screen.getAllByText('M').length).toBeGreaterThan(0);
    expect(screen.getAllByText('2×').length).toBeGreaterThan(0);
    // The 0%-accuracy weakest character is labeled.
    expect(screen.getByText('0%')).toBeInTheDocument();
  });

  it('refetches when refreshKey changes', async () => {
    getMorseProgress.mockResolvedValue(EMPTY);
    const { rerender } = render(<MorseProgressPanel refreshKey={0} />);
    await waitFor(() => expect(getMorseProgress).toHaveBeenCalledTimes(1));
    rerender(<MorseProgressPanel refreshKey={1} />);
    await waitFor(() => expect(getMorseProgress).toHaveBeenCalledTimes(2));
  });
});
