import { MemoryRouter } from 'react-router';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The widget's own contract is what it renders from a snapshot; the
// subscription/retry mechanics belong to useSocketResource's suite. Mocking
// the hook pins the render against a fixed { data, loading } pair.
const { mockUseSocketResource } = vi.hoisted(() => ({ mockUseSocketResource: vi.fn() }));

vi.mock('../hooks/useSocketResource', () => ({
  useSocketResource: (...args) => mockUseSocketResource(...args),
}));

vi.mock('../services/api', () => ({
  getCosQuickSummary: vi.fn(),
  getCosLearningSummary: vi.fn(),
  getCosRecentTasks: vi.fn(),
  getCosActivityCalendar: vi.fn(),
}));

import CosDashboardWidget from './CosDashboardWidget.jsx';

const snapshot = {
  summary: {
    today: { completed: 2, succeeded: 1, failed: 1, running: 0, timeWorked: '12m' },
    queue: { total: 0, pendingApprovals: 0 },
    status: { running: true, paused: false, lastEvaluation: '2026-07-13T10:00:00.000Z' },
  },
  learningSummary: { status: 'good', overallSuccessRate: 50, skipped: 0, totalCompleted: 2 },
  recentTasks: {
    tasks: [
      { id: 'a', description: 'Example docs sweep', taskType: 'documentation', app: null, durationFormatted: '5m', success: true, completedAt: '2026-07-13T09:50:00.000Z', completedRelative: '10m ago' },
      { id: 'b', description: 'Example security audit', taskType: 'security', app: null, durationFormatted: '7m', success: false, completedAt: '2026-07-13T09:40:00.000Z', completedRelative: '20m ago' },
    ],
    summary: { total: 2, succeeded: 1 },
  },
  activityCalendar: { weeks: [], maxTasks: 1, summary: { totalTasks: 0, activeDays: 0, avgTasksPerActiveDay: 0 } },
};

const renderWidget = () => render(<MemoryRouter><CosDashboardWidget /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  mockUseSocketResource.mockReturnValue({ data: snapshot, loading: false, error: null });
});

describe('CosDashboardWidget snapshot comparator', () => {
  const captureCompare = () => {
    renderWidget();
    const options = mockUseSocketResource.mock.calls.at(-1)[1];
    expect(options.compare).toBeTypeOf('function');
    return options.compare;
  };
  const withPatch = (patch) => patch(structuredClone(snapshot));

  it('treats an identical snapshot as unchanged and a null previous as changed', () => {
    const compare = captureCompare();
    expect(compare(snapshot, structuredClone(snapshot))).toBe(true);
    expect(compare(null, snapshot)).toBe(false);
  });

  it('re-renders for any rendered field, including ones no field list ever named', () => {
    const compare = captureCompare();
    // avgTasksPerActiveDay is rendered in the heatmap summary row but was
    // absent from the hand-written comparator this replaced.
    expect(compare(snapshot, withPatch((s) => { s.activityCalendar.summary.avgTasksPerActiveDay = 3.5; return s; }))).toBe(false);
    expect(compare(snapshot, withPatch((s) => { s.recentTasks.tasks[0].description = 'Renamed'; return s; }))).toBe(false);
    expect(compare(snapshot, withPatch((s) => { s.summary.today.succeeded = 5; return s; }))).toBe(false);
  });

  it('ignores the volatile fields the widget never renders', () => {
    const compare = captureCompare();
    expect(compare(snapshot, withPatch((s) => { s.summary.status.lastEvaluation = '2026-07-13T10:05:00.000Z'; return s; }))).toBe(true);
    expect(compare(snapshot, withPatch((s) => { s.recentTasks.tasks[1].completedRelative = '21m ago'; return s; }))).toBe(true);
  });
});

describe('CosDashboardWidget recent-task outcomes', () => {
  it('names each outcome in text and exposes the expander state', () => {
    renderWidget();

    const toggle = screen.getByRole('button', { name: /Recent Tasks/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const collapsed = document.getElementById(toggle.getAttribute('aria-controls'));
    const rows = within(collapsed).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Example docs sweep: succeeded');
    expect(rows[1]).toHaveTextContent('Example security audit: failed');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const expanded = document.getElementById(toggle.getAttribute('aria-controls'));
    const links = within(expanded).getAllByRole('link');
    expect(links[0]).toHaveAccessibleName(/succeeded/);
    expect(links[1]).toHaveAccessibleName(/failed/);
  });
});
