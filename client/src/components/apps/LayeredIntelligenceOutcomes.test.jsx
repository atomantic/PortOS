import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import LayeredIntelligenceOutcomes from './LayeredIntelligenceOutcomes';

vi.mock('../../services/api', () => ({
  getAppLayeredIntelligenceOutcomes: vi.fn()
}));

import { getAppLayeredIntelligenceOutcomes } from '../../services/api';

const ready = (overrides = {}) => ({
  read: true,
  stats: { total: 4, merged: 1, rejected: 1, abandoned: 1, pending: 1, resolved: 3, mergeRate: 100 / 3 },
  rejections: { entries: [{ reason: 'user-rejected', count: 1 }], unknown: 1, unclassified: 0, diagnosed: 1, total: 2 },
  recent: [
    { slug: 'add-metrics', scope: 'app-improvement', outcome: 'merged', rejectionReason: null, filedAt: '2026-07-04T00:00:00.000Z', outcomeAt: '2026-07-05T00:00:00.000Z' },
    { slug: 'drop-feature', scope: 'app-improvement', outcome: 'rejected', rejectionReason: 'user-rejected', filedAt: '2026-07-03T00:00:00.000Z', outcomeAt: '2026-07-04T00:00:00.000Z' }
  ],
  ...overrides
});

describe('LayeredIntelligenceOutcomes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders nothing and never fetches without an appId', () => {
    const { container } = render(<LayeredIntelligenceOutcomes />);
    expect(container).toBeEmptyDOMElement();
    expect(getAppLayeredIntelligenceOutcomes).not.toHaveBeenCalled();
  });

  it('shows the rounded merge rate, counts, rejection tally, and recent rows', async () => {
    getAppLayeredIntelligenceOutcomes.mockResolvedValue(ready());
    render(<LayeredIntelligenceOutcomes appId="app-001" />);

    expect(await screen.findByText('33%')).toBeInTheDocument();
    expect(screen.getByText(/1 of 3 resolved merged/)).toBeInTheDocument();
    // Real diagnosis is glossed (in both the tally and the matching recent row);
    // the undiagnosed row shows as a distinct gap line.
    expect(screen.getAllByText(/the user declined it/).length).toBeGreaterThan(0);
    expect(screen.getByText(/closed with no recorded reason/)).toBeInTheDocument();
    expect(screen.getByText('add-metrics')).toBeInTheDocument();
    expect(screen.getByText('drop-feature')).toBeInTheDocument();
    expect(getAppLayeredIntelligenceOutcomes).toHaveBeenCalledWith('app-001');
  });

  it('shows a dash for the merge rate when nothing has resolved yet', async () => {
    getAppLayeredIntelligenceOutcomes.mockResolvedValue(ready({
      stats: { total: 1, merged: 0, rejected: 0, abandoned: 0, pending: 1, resolved: 0, mergeRate: null },
      rejections: { entries: [], unknown: 0, unclassified: 0, diagnosed: 0, total: 0 },
      recent: [{ slug: 'open-one', scope: 'app-improvement', outcome: null, rejectionReason: null, filedAt: '2026-07-01T00:00:00.000Z', outcomeAt: null }]
    }));
    render(<LayeredIntelligenceOutcomes appId="app-001" />);

    expect(await screen.findByText('—')).toBeInTheDocument();
    expect(screen.getByText(/none resolved yet/)).toBeInTheDocument();
  });

  it('shows the empty state when no proposals have been filed', async () => {
    getAppLayeredIntelligenceOutcomes.mockResolvedValue(ready({
      stats: { total: 0, merged: 0, rejected: 0, abandoned: 0, pending: 0, resolved: 0, mergeRate: null },
      rejections: { entries: [], unknown: 0, unclassified: 0, diagnosed: 0, total: 0 },
      recent: []
    }));
    render(<LayeredIntelligenceOutcomes appId="app-001" />);

    expect(await screen.findByText(/No proposals filed yet/)).toBeInTheDocument();
  });

  it('surfaces an error (and retries) when the store is unreadable', async () => {
    getAppLayeredIntelligenceOutcomes.mockResolvedValue({ read: false, stats: null, rejections: null, recent: [] });
    render(<LayeredIntelligenceOutcomes appId="app-001" />);

    expect(await screen.findByText(/Couldn.t load proposal outcomes/)).toBeInTheDocument();

    getAppLayeredIntelligenceOutcomes.mockResolvedValue(ready());
    fireEvent.click(screen.getByText('Retry'));
    expect(await screen.findByText('33%')).toBeInTheDocument();
    expect(getAppLayeredIntelligenceOutcomes).toHaveBeenCalledTimes(2);
  });

  it('surfaces an error when the request throws', async () => {
    getAppLayeredIntelligenceOutcomes.mockRejectedValue(new Error('network'));
    render(<LayeredIntelligenceOutcomes appId="app-001" />);
    expect(await screen.findByText(/Couldn.t load proposal outcomes/)).toBeInTheDocument();
  });

  it('collapses the remainder to a count against the full population, not the fetched slice', async () => {
    // 9 rows fetched, 30 filed total: the "+N older" must count the true remainder
    // (30 - 6 rendered = 24), not just what was hidden within the returned slice.
    const many = Array.from({ length: 9 }, (_, i) => ({
      slug: `item-${i}`, scope: 'app-improvement', outcome: 'merged', rejectionReason: null,
      filedAt: `2026-07-0${(i % 9) + 1}T00:00:00.000Z`, outcomeAt: `2026-07-0${(i % 9) + 1}T00:00:00.000Z`
    }));
    getAppLayeredIntelligenceOutcomes.mockResolvedValue(ready({
      stats: { total: 30, merged: 30, rejected: 0, abandoned: 0, pending: 0, resolved: 30, mergeRate: 100 },
      recent: many
    }));
    render(<LayeredIntelligenceOutcomes appId="app-001" />);

    await waitFor(() => expect(screen.getByText('item-0')).toBeInTheDocument());
    expect(screen.getByText('+24 older')).toBeInTheDocument();
  });
});
