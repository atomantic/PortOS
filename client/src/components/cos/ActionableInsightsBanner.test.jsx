import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { insightProvenance } from './ActionableInsightsBanner';

// The banner stamps each surfaced insight with a provenance chip. The honesty
// distinction the feature exists to enforce is that a *counted fact* (N tasks
// awaiting approval, N blocked, N health issues) must read as data-backed, while
// only the success-rate-modeled types (auto-skipped task types, peak-hour
// suggestion) read as inferred. These tests pin that mapping so it can't silently
// regress back to a single hardcoded level.
describe('ActionableInsightsBanner insightProvenance', () => {
  it('marks direct-count insight types as data-backed', () => {
    for (const type of ['approval', 'blocked', 'health', 'agent-feedback', 'briefing', 'tasks']) {
      expect(insightProvenance(type).level).toBe('data-backed');
    }
  });

  it('marks success-rate-modeled insight types as inferred', () => {
    for (const type of ['learning', 'peak-time']) {
      expect(insightProvenance(type).level).toBe('inferred');
    }
  });

  it('defaults an unknown insight type to data-backed (a count, not a model)', () => {
    // New insight types are far more likely to be counts than statistical models,
    // so the safe default is data-backed — an over-claim of "inferred" is the one
    // mislabel this feature must avoid.
    expect(insightProvenance('some-future-type').level).toBe('data-backed');
  });
});

// The banner is now presentational (#2654): ChiefOfStaff.fetchData owns the
// actionable-insights fetch and passes the result down as `insights`, so every
// parent trigger that refetches CoS data refreshes the banner for free. These
// tests pin the prop-driven render, the null/empty gating, and the unblock path
// calling `onRefresh` up instead of owning its own poll.
const api = vi.hoisted(() => ({ updateCosTask: vi.fn(), approveCosTask: vi.fn() }));
vi.mock('../../services/api', () => api);
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

const ActionableInsightsBanner = (await import('./ActionableInsightsBanner')).default;

const LocationDisplay = () => {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
};

const renderBanner = (props, { withLocation = false } = {}) =>
  render(
    <MemoryRouter>
      <ActionableInsightsBanner {...props} />
      {withLocation && <LocationDisplay />}
    </MemoryRouter>,
  );

describe('ActionableInsightsBanner (presentational)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing before the first parent fetch resolves (null insights)', () => {
    const { container } = renderBanner({ insights: null });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when insights is a legitimately-empty array', () => {
    // Empty (all-clear) must render nothing — distinct from null (not-yet-fetched)
    // but visually identical, and never re-hitting the API to find that out.
    const { container } = renderBanner({ insights: [] });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the primary insight passed as a prop (no fetch of its own)', () => {
    renderBanner({
      insights: [
        { type: 'approval', priority: 'high', icon: 'AlertCircle', title: '3 approvals waiting', action: { label: 'Review', route: '/cos/tasks' } },
      ],
    });
    expect(screen.getByText('3 approvals waiting')).toBeInTheDocument();
    // The banner never calls the API directly anymore — the parent owns fetching.
    expect(api.updateCosTask).not.toHaveBeenCalled();
  });

  it('navigates feedback reminders to the URL-backed review queue', () => {
    renderBanner({
      insights: [{
        type: 'agent-feedback', priority: 'medium', icon: 'MessageSquare', title: '1 completed run needs feedback',
        action: { label: 'Review runs', route: '/cos/agents?feedback=needs-feedback' },
      }],
    }, { withLocation: true });

    fireEvent.click(screen.getByRole('button', { name: 'Review runs' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/cos/agents?feedback=needs-feedback');
  });

  it('hides insights the user dismisses', () => {
    renderBanner({
      insights: [
        { type: 'approval', priority: 'high', icon: 'AlertCircle', title: '3 approvals waiting', action: { label: 'Review', route: '/cos/tasks' } },
      ],
    });
    fireEvent.click(screen.getByTitle('Dismiss'));
    expect(screen.queryByText('3 approvals waiting')).not.toBeInTheDocument();
  });

  it('approves the surfaced task directly from the banner', async () => {
    api.approveCosTask.mockResolvedValue({ id: 'a1' });
    const onRefresh = vi.fn();
    renderBanner({
      insights: [{
        type: 'approval', priority: 'high', icon: 'AlertCircle', title: '1 approval waiting',
        action: { label: 'Approve' }, tasks: [{ id: 'a1', description: 'Investigate a failure' }],
      }],
      onRefresh,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(api.approveCosTask).toHaveBeenCalledWith('a1', { silent: true }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('unblocks a task and calls onRefresh + onTaskUnblocked up (no self-poll)', async () => {
    api.updateCosTask.mockResolvedValue({ id: 't1' });
    const onRefresh = vi.fn();
    const onTaskUnblocked = vi.fn();
    renderBanner({
      insights: [
        {
          type: 'blocked', priority: 'warning', icon: 'AlertTriangle', title: '1 blocked task',
          action: {}, tasks: [{ id: 't1', description: 'stuck task', taskType: 'user' }],
        },
      ],
      onRefresh,
      onTaskUnblocked,
    });
    // Expand to reveal the per-task Unblock button, then click it.
    fireEvent.click(screen.getByText('View Tasks'));
    fireEvent.click(screen.getByText('Unblock'));

    await waitFor(() =>
      expect(api.updateCosTask).toHaveBeenCalledWith('t1', { status: 'pending', type: 'user' }, { silent: true }),
    );
    // The parent refetch (fetchData re-pulls insights) is how the unblocked task
    // drops out of the banner — the banner no longer owns a refetch.
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(onTaskUnblocked).toHaveBeenCalledWith('t1');
  });
});
