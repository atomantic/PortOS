import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import EditorialHealthPanel from './EditorialHealthPanel';

const getEditorialHealth = vi.fn();
const setEditorialReadinessGate = vi.fn();
vi.mock('../../../services/api', () => ({
  getEditorialHealth: (...a) => getEditorialHealth(...a),
  setEditorialReadinessGate: (...a) => setEditorialReadinessGate(...a),
}));
vi.mock('../../ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

const health = (over = {}) => ({
  seriesId: 'ser-1',
  score: 83,
  ready: false,
  open: 3,
  openBySeverity: { high: 1, medium: 1, low: 1 },
  openByCategory: { continuity: 2, pacing: 1 },
  gate: 'noOpenHigh',
  weights: { high: 12, medium: 5, low: 1 },
  perIssue: [],
  trend: {
    points: [{ score: 70, open: 6 }, { score: 83, open: 3 }],
    regressions: [],
    delta: 13,
  },
  ...over,
});

beforeEach(() => {
  getEditorialHealth.mockReset();
  setEditorialReadinessGate.mockReset();
});

describe('EditorialHealthPanel', () => {
  it('renders nothing without a series', () => {
    const { container } = render(<EditorialHealthPanel seriesId="" />);
    expect(container.firstChild).toBeNull();
    expect(getEditorialHealth).not.toHaveBeenCalled();
  });

  it('shows the score, readiness, severity breakdown and trend delta', async () => {
    getEditorialHealth.mockResolvedValue(health());
    render(<EditorialHealthPanel seriesId="ser-1" />);
    expect(await screen.findByText('83')).toBeTruthy();
    expect(screen.getByText('Not ready')).toBeTruthy();
    expect(screen.getByText('+13')).toBeTruthy();
    expect(screen.getByText(/1 high/)).toBeTruthy();
  });

  it('flags a category that regressed', async () => {
    getEditorialHealth.mockResolvedValue(health({
      trend: { points: [{ score: 90 }, { score: 70 }], regressions: [{ category: 'continuity', from: 1, to: 2 }], delta: -20 },
    }));
    render(<EditorialHealthPanel seriesId="ser-1" />);
    expect(await screen.findByText('1→2')).toBeTruthy();
  });

  it('marks ready when the gate is satisfied', async () => {
    getEditorialHealth.mockResolvedValue(health({ ready: true, score: 100, openBySeverity: { high: 0, medium: 0, low: 0 }, open: 0 }));
    render(<EditorialHealthPanel seriesId="ser-1" />);
    expect(await screen.findByText('Ready')).toBeTruthy();
    expect(screen.getByText('No open findings')).toBeTruthy();
  });

  it('persists a readiness-gate change and refetches', async () => {
    getEditorialHealth.mockResolvedValue(health());
    setEditorialReadinessGate.mockResolvedValue({ readinessGate: 'noOpenHighOrMedium' });
    render(<EditorialHealthPanel seriesId="ser-1" />);
    await screen.findByText('83');
    fireEvent.change(screen.getByLabelText('Ready when:'), { target: { value: 'noOpenHighOrMedium' } });
    await waitFor(() => expect(setEditorialReadinessGate).toHaveBeenCalledWith('noOpenHighOrMedium', { silent: true }));
    // Refetch fired after the save (initial mount + post-save = 2 reads).
    await waitFor(() => expect(getEditorialHealth).toHaveBeenCalledTimes(2));
  });

  it('refetches when refreshKey changes', async () => {
    getEditorialHealth.mockResolvedValue(health());
    const { rerender } = render(<EditorialHealthPanel seriesId="ser-1" refreshKey={0} />);
    await screen.findByText('83');
    rerender(<EditorialHealthPanel seriesId="ser-1" refreshKey={1} />);
    await waitFor(() => expect(getEditorialHealth).toHaveBeenCalledTimes(2));
  });
});
