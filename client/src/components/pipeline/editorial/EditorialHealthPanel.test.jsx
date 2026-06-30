import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import EditorialHealthPanel from './EditorialHealthPanel';

const getEditorialHealth = vi.fn();
const setEditorialReadinessGate = vi.fn();
vi.mock('../../../services/api', () => ({
  getEditorialHealth: (...a) => getEditorialHealth(...a),
  setEditorialReadinessGate: (...a) => setEditorialReadinessGate(...a),
}));
vi.mock('../../ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

// Surfaces the live URL query string so a click that deep-links a triage filter
// (#1606) is assertable.
function Probe() {
  const [sp] = useSearchParams();
  return <div data-testid="search-params">{sp.toString()}</div>;
}
const wrap = (props, route = '/') => (
  <MemoryRouter initialEntries={[route]}>
    <EditorialHealthPanel {...props} />
    <Probe />
  </MemoryRouter>
);
const renderPanel = (props = {}, route) => render(wrap(props, route));
const params = () => screen.getByTestId('search-params').textContent;

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
  // jsdom doesn't implement scrollIntoView; stub it so the deep-link scroll is a no-op.
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

describe('EditorialHealthPanel', () => {
  it('renders nothing without a series', () => {
    const { container } = renderPanel({ seriesId: '' });
    // The router + probe still render; the panel itself renders null.
    expect(screen.queryByText('Editorial Health')).toBeNull();
    expect(getEditorialHealth).not.toHaveBeenCalled();
    expect(container).toBeTruthy();
  });

  it('shows the score, readiness, severity breakdown and trend delta', async () => {
    getEditorialHealth.mockResolvedValue(health());
    renderPanel({ seriesId: 'ser-1' });
    expect(await screen.findByText('83')).toBeTruthy();
    expect(screen.getByText('Not ready')).toBeTruthy();
    expect(screen.getByText('+13')).toBeTruthy();
    expect(screen.getByText(/1 high/)).toBeTruthy();
  });

  it('flags a category that regressed', async () => {
    getEditorialHealth.mockResolvedValue(health({
      trend: { points: [{ score: 90 }, { score: 70 }], regressions: [{ category: 'continuity', from: 1, to: 2 }], delta: -20 },
    }));
    renderPanel({ seriesId: 'ser-1' });
    expect(await screen.findByText('1→2')).toBeTruthy();
  });

  it('marks ready when the gate is satisfied', async () => {
    getEditorialHealth.mockResolvedValue(health({ ready: true, score: 100, openBySeverity: { high: 0, medium: 0, low: 0 }, open: 0 }));
    renderPanel({ seriesId: 'ser-1' });
    expect(await screen.findByText('Ready')).toBeTruthy();
    expect(screen.getByText('No open findings')).toBeTruthy();
  });

  it('persists a readiness-gate change and refetches', async () => {
    getEditorialHealth.mockResolvedValue(health());
    setEditorialReadinessGate.mockResolvedValue({ readinessGate: 'noOpenHighOrMedium' });
    renderPanel({ seriesId: 'ser-1' });
    await screen.findByText('83');
    fireEvent.change(screen.getByLabelText('Ready when:'), { target: { value: 'noOpenHighOrMedium' } });
    await waitFor(() => expect(setEditorialReadinessGate).toHaveBeenCalledWith('noOpenHighOrMedium', { silent: true }));
    // Refetch fired after the save (initial mount + post-save = 2 reads).
    await waitFor(() => expect(getEditorialHealth).toHaveBeenCalledTimes(2));
  });

  it('refetches when refreshKey changes', async () => {
    getEditorialHealth.mockResolvedValue(health());
    const { rerender } = renderPanel({ seriesId: 'ser-1', refreshKey: 0 });
    await screen.findByText('83');
    rerender(wrap({ seriesId: 'ser-1', refreshKey: 1 }));
    await waitFor(() => expect(getEditorialHealth).toHaveBeenCalledTimes(2));
  });

  it('hides the delta when there is only one trend point (nothing to compare)', async () => {
    getEditorialHealth.mockResolvedValue(health({
      trend: { points: [{ score: 83 }], regressions: [], delta: 0 },
    }));
    renderPanel({ seriesId: 'ser-1' });
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
    renderPanel({ seriesId: 'ser-1', checksById });
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
    renderPanel({ seriesId: 'ser-1' });
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
    renderPanel({ seriesId: 'ser-1' });
    await screen.findByText('83');
    // Two issues carry open findings (issue 3 is clean → excluded); expand.
    const toggle = screen.getByText(/By issue \(2\)/);
    fireEvent.click(toggle);
    expect(await screen.findByText('Issue 2')).toBeTruthy();
    expect(screen.getByText('Issue 1')).toBeTruthy();
    expect(screen.queryByText('Issue 3')).toBeNull();
  });

  it('deep-links the triage category filter when a category row is clicked (#1606)', async () => {
    getEditorialHealth.mockResolvedValue(health());
    renderPanel({ seriesId: 'ser-1' }, '/?series=ser-1');
    await screen.findByText('83');
    fireEvent.click(screen.getByTitle('Filter findings to continuity'));
    await waitFor(() => expect(params()).toContain('fcat=continuity'));
    // The page's own params are preserved (filter is additive, not a replace).
    expect(params()).toContain('series=ser-1');
  });

  it('toggles the category filter off when its active row is clicked again (#1606)', async () => {
    getEditorialHealth.mockResolvedValue(health());
    renderPanel({ seriesId: 'ser-1' }, '/?fcat=continuity');
    await screen.findByText('83');
    // The active row offers a clear affordance.
    fireEvent.click(screen.getByTitle('Clear the continuity filter'));
    await waitFor(() => expect(params()).not.toContain('fcat=continuity'));
  });

  it('deep-links the triage check filter when a check row is clicked (#1606)', async () => {
    getEditorialHealth.mockResolvedValue(health({
      openByCheck: { 'roster.economy': 1 },
      trend: { points: [{ score: 83, openByCheck: { 'roster.economy': 1 } }], regressions: [], checkRegressions: [], delta: 0 },
    }));
    renderPanel({ seriesId: 'ser-1', checksById: { 'roster.economy': { label: 'Cast economy' } } });
    await screen.findByText('83');
    fireEvent.click(screen.getByTitle('Filter findings to Cast economy'));
    await waitFor(() => expect(params()).toContain('fcheck=roster.economy'));
  });

  it('renders a non-triage-filterable check row as static text, not a deep-link (#1606)', async () => {
    // The synthetic `completeness` bucket counts null-checkId findings the triage
    // drops, so it isn't in the filterable set — its row must not link to an empty list.
    getEditorialHealth.mockResolvedValue(health({
      openByCheck: { completeness: 2 },
      trend: { points: [{ score: 83, openByCheck: { completeness: 2 } }], regressions: [], checkRegressions: [], delta: 0 },
    }));
    renderPanel({ seriesId: 'ser-1', filterableCheckIds: new Set(), filterableCategories: new Set() });
    await screen.findByText('83');
    const row = screen.getByTitle(/completeness findings aren't in the triage filter/i);
    expect(row.tagName).toBe('SPAN');
    expect(screen.queryByTitle('Filter findings to completeness')).toBeNull();
  });

  it('renders a non-triage-filterable category row as static text (#1606)', async () => {
    getEditorialHealth.mockResolvedValue(health({ openByCategory: { plot: 2 } }));
    renderPanel({ seriesId: 'ser-1', filterableCheckIds: new Set(), filterableCategories: new Set() });
    await screen.findByText('83');
    const row = screen.getByTitle(/plot findings aren't in the triage filter/i);
    expect(row.tagName).toBe('SPAN');
    expect(screen.queryByTitle('Filter findings to plot')).toBeNull();
  });

  it('keeps a filterable check row clickable when filterable sets are provided (#1606)', async () => {
    getEditorialHealth.mockResolvedValue(health({
      openByCheck: { 'roster.economy': 1 },
      trend: { points: [{ score: 83, openByCheck: { 'roster.economy': 1 } }], regressions: [], checkRegressions: [], delta: 0 },
    }));
    renderPanel({
      seriesId: 'ser-1',
      checksById: { 'roster.economy': { label: 'Cast economy' } },
      filterableCheckIds: new Set(['roster.economy']),
      filterableCategories: new Set(),
    });
    await screen.findByText('83');
    fireEvent.click(screen.getByTitle('Filter findings to Cast economy'));
    await waitFor(() => expect(params()).toContain('fcheck=roster.economy'));
  });

  // Snapshot drill-down (#1630): clicking a sparkline point shows that revision's
  // open-finding breakdown + a diff vs the previous revision.
  const trendHealth = (over = {}) => health({
    trend: {
      points: [
        { score: 70, open: 5, at: '2026-06-01T00:00:00Z', openBySeverity: { high: 1, medium: 1, low: 3 }, openByCategory: { continuity: 3, pacing: 2 }, openByCheck: { 'continuity.x': 3 } },
        { score: 83, open: 3, at: '2026-06-02T00:00:00Z', openBySeverity: { high: 0, medium: 1, low: 2 }, openByCategory: { continuity: 1, pacing: 2 }, openByCheck: { 'continuity.x': 1 } },
      ],
      regressions: [],
      checkRegressions: [],
      delta: 13,
    },
    ...over,
  });

  it('drills into a snapshot when a sparkline point is clicked (#1630)', async () => {
    getEditorialHealth.mockResolvedValue(trendHealth());
    renderPanel({ seriesId: 'ser-1', checksById: { 'continuity.x': { label: 'Continuity X' } } });
    await screen.findByText('83');
    // No drill-down until a point is selected.
    expect(screen.queryByText('Changed since previous revision')).toBeNull();
    // Select the latest revision (revision 2 of 2).
    fireEvent.click(screen.getByRole('button', { name: /Revision 2 of 2, score 83/ }));
    expect(await screen.findByText('Changed since previous revision')).toBeTruthy();
    expect(screen.getByText('Open findings this revision')).toBeTruthy();
    // continuity dropped 3→1 since the prior revision — shown in both the
    // category and the per-check diff rows.
    expect(screen.getAllByText('3→1').length).toBeGreaterThanOrEqual(1);
    // The resolved check label appears in the By-check diff.
    expect(screen.getByText('Continuity X')).toBeTruthy();
  });

  it('notes the first revision has nothing to compare against (#1630)', async () => {
    getEditorialHealth.mockResolvedValue(trendHealth());
    renderPanel({ seriesId: 'ser-1' });
    await screen.findByText('83');
    fireEvent.click(screen.getByRole('button', { name: /Revision 1 of 2, score 70/ }));
    expect(await screen.findByText(/First recorded revision/)).toBeTruthy();
  });

  it('closes the snapshot drill-down (#1630)', async () => {
    getEditorialHealth.mockResolvedValue(trendHealth());
    renderPanel({ seriesId: 'ser-1' });
    await screen.findByText('83');
    fireEvent.click(screen.getByRole('button', { name: /Revision 2 of 2/ }));
    await screen.findByText('Changed since previous revision');
    fireEvent.click(screen.getByRole('button', { name: 'Close snapshot detail' }));
    await waitFor(() => expect(screen.queryByText('Changed since previous revision')).toBeNull());
  });
});
