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

  it('hides the delta when there is only one trend point (nothing to compare)', async () => {
    getEditorialHealth.mockResolvedValue(health({
      trend: { points: [{ score: 83 }], regressions: [], delta: 0 },
    }));
    render(<EditorialHealthPanel seriesId="ser-1" />);
    await screen.findByText('83');
    // The "+0/0" delta chip should not render for a single revision.
    expect(screen.queryByTitle('Change since the previous revision')).toBeNull();
  });

  it('renders the per-check breakdown with resolved labels, counts and a regression flag (#1597)', async () => {
    getEditorialHealth.mockResolvedValue(health({
      openByCheck: { 'naming.dissimilar-names': 2, 'roster.economy': 1 },
      trend: {
        points: [
          { score: 70, openByCheck: { 'naming.dissimilar-names': 1 } },
          { score: 83, openByCheck: { 'naming.dissimilar-names': 2, 'roster.economy': 1 } },
        ],
        regressions: [],
        checkRegressions: [{ checkId: 'naming.dissimilar-names', from: 1, to: 2 }],
        delta: 13,
      },
    }));
    const checksById = {
      'naming.dissimilar-names': { label: 'Name dissimilarity' },
      'roster.economy': { label: 'Cast economy' },
    };
    render(<EditorialHealthPanel seriesId="ser-1" checksById={checksById} />);
    await screen.findByText('83');
    expect(screen.getByText('Open by check')).toBeTruthy();
    // Labels resolved from the catalog, sorted by count desc.
    expect(screen.getByText('Name dissimilarity')).toBeTruthy();
    expect(screen.getByText('Cast economy')).toBeTruthy();
    // The regressed check shows its from→to flag.
    expect(screen.getByText('1→2')).toBeTruthy();
  });

  it('falls back to the raw checkId when the catalog has no label for it', async () => {
    getEditorialHealth.mockResolvedValue(health({
      openByCheck: { 'custom.orphan': 1 },
      trend: { points: [{ score: 83, openByCheck: { 'custom.orphan': 1 } }], regressions: [], checkRegressions: [], delta: 0 },
    }));
    render(<EditorialHealthPanel seriesId="ser-1" />);
    await screen.findByText('83');
    expect(screen.getByText('custom.orphan')).toBeTruthy();
  });

  it('renders the per-issue drill-down (issues with open findings, worst first)', async () => {
    getEditorialHealth.mockResolvedValue(health({
      perIssue: [
        { issueNumber: 1, score: 95, open: 1, openBySeverity: { high: 0, medium: 0, low: 1 } },
        { issueNumber: 2, score: 60, open: 2, openBySeverity: { high: 1, medium: 0, low: 0 } },
        { issueNumber: 3, score: 100, open: 0, openBySeverity: { high: 0, medium: 0, low: 0 } },
      ],
    }));
    render(<EditorialHealthPanel seriesId="ser-1" />);
    await screen.findByText('83');
    // Two issues carry open findings (issue 3 is clean → excluded); expand.
    const toggle = screen.getByText(/By issue \(2\)/);
    fireEvent.click(toggle);
    expect(await screen.findByText('Issue 2')).toBeTruthy();
    expect(screen.getByText('Issue 1')).toBeTruthy();
    expect(screen.queryByText('Issue 3')).toBeNull();
  });
});
