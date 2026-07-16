import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { insightProvenance } from './ActionableInsightsBanner';

// The banner stamps each surfaced insight with a provenance chip. The honesty
// distinction the feature exists to enforce is that a *counted fact* (N tasks
// awaiting approval, N blocked, N health issues) must read as data-backed, while
// only the success-rate-modeled types (auto-skipped task types, peak-hour
// suggestion) read as inferred. These tests pin that mapping so it can't silently
// regress back to a single hardcoded level.
describe('ActionableInsightsBanner insightProvenance', () => {
  it('marks direct-count insight types as data-backed', () => {
    for (const type of ['approval', 'blocked', 'health', 'briefing', 'tasks']) {
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

// Regression: deleting a blocked task from the tasks page used to leave the
// "N blocked tasks" alert bar up until the 60s poll or a manual dismiss, because
// the banner owns its own insights fetch (decoupled from the task list). The
// parent now bumps `refreshKey` on every task mutation so the banner
// re-derives immediately. These tests pin that bridge.
const api = vi.hoisted(() => ({ getCosActionableInsights: vi.fn() }));
vi.mock('../../services/api', () => api);
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

const ActionableInsightsBanner = (await import('./ActionableInsightsBanner')).default;

const renderBanner = (refreshKey) =>
  render(
    <MemoryRouter>
      <ActionableInsightsBanner refreshKey={refreshKey} />
    </MemoryRouter>,
  );

describe('ActionableInsightsBanner refreshKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getCosActionableInsights.mockResolvedValue({
      insights: [
        { type: 'blocked', priority: 'warning', icon: 'AlertTriangle', title: '2 blocked tasks', description: 'blocked', tasks: [] },
      ],
    });
  });

  it('refetches insights when refreshKey changes (a task was deleted)', async () => {
    const { rerender } = renderBanner(0);
    await waitFor(() => expect(api.getCosActionableInsights).toHaveBeenCalled());
    const before = api.getCosActionableInsights.mock.calls.length;

    rerender(
      <MemoryRouter>
        <ActionableInsightsBanner refreshKey={1} />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(api.getCosActionableInsights.mock.calls.length).toBeGreaterThan(before),
    );
  });

  it('does not refetch when re-rendered without a key change', async () => {
    const { rerender } = renderBanner(3);
    await waitFor(() => expect(api.getCosActionableInsights).toHaveBeenCalled());
    const before = api.getCosActionableInsights.mock.calls.length;

    // Same key → the refetch effect's deps are unchanged, so no extra fetch.
    rerender(
      <MemoryRouter>
        <ActionableInsightsBanner refreshKey={3} />
      </MemoryRouter>,
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(api.getCosActionableInsights.mock.calls.length).toBe(before);
  });
});
