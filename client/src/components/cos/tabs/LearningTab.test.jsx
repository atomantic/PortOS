import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import LearningTab from './LearningTab';

const api = vi.hoisted(() => ({
  getCosLearningDashboard: vi.fn(),
  getReviewerVerdictStats: vi.fn(),
  backfillCosLearning: vi.fn(),
}));

const socket = vi.hoisted(() => {
  const handlers = new Map();
  return {
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(handler);
    },
    off: (event, handler) => handlers.get(event)?.delete(handler),
    emit: vi.fn(),
    receive: (event, payload) => handlers.get(event)?.forEach(handler => handler(payload)),
  };
});

vi.mock('../../../services/apiAgents.js', () => ({
  getCosLearningDashboard: api.getCosLearningDashboard,
  backfillCosLearning: api.backfillCosLearning,
}));
vi.mock('../../../services/apiCodeReview.js', () => ({ getReviewerVerdictStats: api.getReviewerVerdictStats }));
vi.mock('../../../services/socket', () => ({ default: socket }));
vi.mock('../../ui/Toast');

const dashboard = {};

const renderTab = () => render(<MemoryRouter><LearningTab /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  dashboard.learning = { totals: { completed: 12, succeeded: 10, failed: 2, successRate: 83 }, recommendations: [] };
  dashboard.performance = { topPerformers: [], needsAttention: [] };
  dashboard.skipped = { skippedCount: 0, skippedTypes: [] };
  dashboard.durations = {};
  dashboard.routing = { matrix: [] };
  dashboard.confidence = {};
  dashboard.feedback = { total: 0 };
  dashboard.dismissed = [];
  dashboard.reviewerVerdicts = { runs: 0, reports: 0, byReviewer: [], bySize: [] };
  api.getCosLearningDashboard.mockImplementation(async () => ({ ...dashboard }));
  api.getReviewerVerdictStats.mockImplementation(async () => dashboard.reviewerVerdicts);
});

describe('LearningTab failed reads', () => {
  // A failed summary read used to say "No learning data available yet" and offer
  // Backfill History, as if the install had never recorded a completed task.
  it('shows Retry and hides empty-state controls when the first read fails', async () => {
    api.getCosLearningDashboard.mockRejectedValueOnce(new Error('Synthetic learning failure'));
    renderTab();

    expect(await screen.findByText('Could not load learning analytics')).toBeInTheDocument();
    expect(screen.queryByText('No learning data available yet.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Backfill History/ })).not.toBeInTheDocument();
    expect(api.getCosLearningDashboard).toHaveBeenCalledWith({ silent: true });

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Tasks Analyzed')).toBeInTheDocument();
    expect(screen.queryByText('Could not load learning analytics')).not.toBeInTheDocument();
  });

  it('names a failed section while keeping the rest of the dashboard visible', async () => {
    api.getCosLearningDashboard.mockResolvedValueOnce({ ...dashboard, confidence: null });
    renderTab();

    expect(await screen.findByText(/Could not load some learning sections \(confidence\)/)).toBeInTheDocument();
    expect(screen.getByText('Tasks Analyzed')).toBeInTheDocument();
    expect(screen.queryByText('Confidence & Autonomy')).not.toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })));
    expect(screen.queryByText(/Could not load some learning sections/)).not.toBeInTheDocument();
  });

  it('uses one dashboard request per load and keeps the snapshot on refresh failure', async () => {
    renderTab();
    expect(await screen.findByText('Tasks Analyzed')).toBeInTheDocument();
    expect(api.getCosLearningDashboard).toHaveBeenCalledTimes(1);
    expect(api.getReviewerVerdictStats).not.toHaveBeenCalled();

    api.getCosLearningDashboard.mockRejectedValueOnce(new Error('Synthetic refresh failure'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Could not load learning analytics')).toBeInTheDocument();
    expect(screen.getByText('Tasks Analyzed')).toBeInTheDocument();
    expect(api.getCosLearningDashboard).toHaveBeenCalledTimes(2);
    expect(api.getReviewerVerdictStats).not.toHaveBeenCalled();
  });

  it('reloads the dashboard once after backfilling history', async () => {
    api.getCosLearningDashboard.mockResolvedValueOnce({
      ...dashboard, learning: { totals: { completed: 0 }, recommendations: [] },
    });
    api.backfillCosLearning.mockResolvedValueOnce({ success: true });
    renderTab();

    fireEvent.click(await screen.findByRole('button', { name: 'Backfill History' }));
    expect(await screen.findByText('Tasks Analyzed')).toBeInTheDocument();
    expect(api.backfillCosLearning).toHaveBeenCalledTimes(1);
    expect(api.getCosLearningDashboard).toHaveBeenCalledTimes(2);
    expect(api.getReviewerVerdictStats).not.toHaveBeenCalled();
  });

  // StrictMode mounts twice, so two batches overlap; the older one failing after
  // the newer one succeeded must not replace the loaded view with an error.
  it('ignores an older batch that fails after a newer one loaded', async () => {
    let failFirst;
    api.getCosLearningDashboard
      .mockImplementationOnce(() => new Promise((_, reject) => { failFirst = reject; }))
      .mockResolvedValueOnce({ ...dashboard });
    render(<StrictMode><MemoryRouter><LearningTab /></MemoryRouter></StrictMode>);

    expect(await screen.findByText('Tasks Analyzed')).toBeInTheDocument();
    await act(async () => failFirst(new Error('Synthetic stale failure')));
    expect(screen.getByText('Tasks Analyzed')).toBeInTheDocument();
    expect(screen.queryByText('Could not load learning analytics')).not.toBeInTheDocument();
  });
});

it('labels low success as historical advice rather than automatic skipping', async () => {
  dashboard.skipped = {
    skippedCount: 1, skippedTypes: [{ taskType: 'pr-watcher', successRate: 13, completed: 8 }]
  };
  renderTab();
  expect(await screen.findByText('Low-Success History')).toBeInTheDocument();
  expect(screen.getByText(/not a scheduler pause/)).toBeInTheDocument();
  expect(screen.queryByText(/automatically skipped/)).not.toBeInTheDocument();
  expect(screen.getByTitle('Clear historical learning metrics; scheduling is unchanged')).toBeInTheDocument();
});

describe('LearningTab reviewer verdicts', () => {
  it('shows clean rate per reviewer and per diff size once runs recorded verdicts', async () => {
    dashboard.reviewerVerdicts = {
      runs: 3, reports: 4,
      byReviewer: [{ reviewer: 'codex', reports: 4, clean: 1, findings: 3, cleanRate: 25, runs: 3, avgRounds: 1.3 }],
      bySize: [
        { bucket: 'xs', label: '0-20 lines', reports: 1, clean: 1, findings: 0, cleanRate: 100 },
        { bucket: 'm', label: '101-500 lines', reports: 3, clean: 0, findings: 3, cleanRate: 0 },
        { bucket: 'unknown', label: 'Size not reported', reports: 0, clean: 0, findings: 0, cleanRate: null },
      ],
    };
    renderTab();

    expect(await screen.findByText('Reviewer Verdicts')).toBeInTheDocument();
    expect(screen.getByText('codex')).toBeInTheDocument();
    expect(screen.getByText('25%')).toBeInTheDocument();
    expect(screen.getByText('101-500 lines')).toBeInTheDocument();
    expect(screen.queryByText('Size not reported')).not.toBeInTheDocument();
  });

  it('re-reads the aggregate when a run records a verdict while the tab is open', async () => {
    renderTab();
    expect(await screen.findByText('Tasks Analyzed')).toBeInTheDocument();
    expect(screen.queryByText('Reviewer Verdicts')).not.toBeInTheDocument();

    dashboard.reviewerVerdicts = {
      runs: 1, reports: 1,
      byReviewer: [{ reviewer: 'codex', reports: 1, clean: 0, findings: 1, cleanRate: 0, runs: 1, avgRounds: 1 }],
      bySize: [{ bucket: 's', label: '21-100 lines', reports: 1, clean: 0, findings: 1, cleanRate: 0 }],
    };
    await act(async () => { socket.receive('cos:reviewer-verdict:recorded', { agentId: 'agent-example', reviewer: 'codex', verdict: 'findings' }); });

    expect(await screen.findByText('Reviewer Verdicts')).toBeInTheDocument();
    expect(screen.getByText('21-100 lines')).toBeInTheDocument();
    expect(api.getReviewerVerdictStats).toHaveBeenLastCalledWith({ silent: true });
  });

  it('re-reads after a reconnect, and a failed re-read keeps the last aggregate and names the section', async () => {
    const recorded = {
      runs: 1, reports: 1,
      byReviewer: [{ reviewer: 'codex', reports: 1, clean: 1, findings: 0, cleanRate: 100, runs: 1, avgRounds: 1 }],
      bySize: [{ bucket: 'xs', label: '0-20 lines', reports: 1, clean: 1, findings: 0, cleanRate: 100 }],
    };
    renderTab();
    expect(await screen.findByText('Tasks Analyzed')).toBeInTheDocument();

    dashboard.reviewerVerdicts = recorded;
    await act(async () => { socket.receive('connect'); });
    expect(await screen.findByText('Reviewer Verdicts')).toBeInTheDocument();

    api.getReviewerVerdictStats.mockRejectedValueOnce(new Error('Synthetic verdict failure'));
    await act(async () => { socket.receive('cos:reviewer-verdict:recorded', { agentId: 'agent-example', reviewer: 'codex', verdict: 'clean' }); });
    expect(await screen.findByText(/Could not load some learning sections \(reviewer verdicts\)/)).toBeInTheDocument();
    expect(screen.getByText('Reviewer Verdicts')).toBeInTheDocument();

    await act(async () => { socket.receive('cos:reviewer-verdict:recorded', { agentId: 'agent-example', reviewer: 'codex', verdict: 'clean' }); });
    expect(screen.queryByText(/Could not load some learning sections/)).not.toBeInTheDocument();
  });

  it('shows recorded verdicts even before task learning has completed tasks, and names unreadable runs', async () => {
    dashboard.learning = { totals: { completed: 0, succeeded: 0, failed: 0, successRate: 0 }, recommendations: [] };
    dashboard.reviewerVerdicts = {
      runs: 1, reports: 1, unreadableRuns: 2,
      byReviewer: [{ reviewer: 'codex', reports: 1, clean: 1, findings: 0, cleanRate: 100, runs: 1, avgRounds: 1 }],
      bySize: [{ bucket: 'xs', label: '0-20 lines', reports: 1, clean: 1, findings: 0, cleanRate: 100 }],
    };
    renderTab();

    expect(await screen.findByText('No learning data available yet.')).toBeInTheDocument();
    expect(screen.getByText('Reviewer Verdicts')).toBeInTheDocument();
    expect(screen.getByText(/2 archived runs could not be read/)).toBeInTheDocument();
  });

  it('keeps a newer socket verdict when the dashboard resolves later', async () => {
    let finishDashboard;
    api.getCosLearningDashboard.mockImplementationOnce(() => new Promise(resolve => {
      finishDashboard = resolve;
    }));
    renderTab();

    api.getReviewerVerdictStats.mockResolvedValueOnce({
      runs: 1, reports: 1,
      byReviewer: [{ reviewer: 'latest-reviewer', reports: 1, clean: 1, findings: 0, cleanRate: 100, runs: 1, avgRounds: 1 }],
      bySize: [],
    });
    await act(async () => socket.receive('cos:agents:changed', {}));
    await act(async () => finishDashboard({ ...dashboard }));
    expect(screen.getByText('latest-reviewer')).toBeInTheDocument();
  });

  it('re-reads reviewer verdicts when agent runs change', async () => {
    renderTab();
    expect(await screen.findByText('Tasks Analyzed')).toBeInTheDocument();
    const initialReads = api.getReviewerVerdictStats.mock.calls.length;

    await act(async () => { socket.receive('cos:agents:changed', {}); });
    expect(api.getReviewerVerdictStats).toHaveBeenCalledTimes(initialReads + 1);
  });

  it('shows no panel when no run has recorded a verdict', async () => {
    renderTab();
    expect(await screen.findByText('Tasks Analyzed')).toBeInTheDocument();
    expect(screen.queryByText('Reviewer Verdicts')).not.toBeInTheDocument();
  });
});

it('reports disclosure state and names its analytics tables and row actions', async () => {
  dashboard.learning = {
    totals: { completed: 12, succeeded: 10, failed: 2, successRate: 83 },
    recommendations: [],
    insights: {
      modelEffectiveness: [{ tier: 'light', completed: 12, successRate: 83, avgDurationMin: 1 }],
      commonErrors: [{ category: 'Timeout', count: 2 }],
    },
    standingLearnings: [{ message: 'Example operating note' }],
  };
  dashboard.confidence = { summary: { total: 1 }, thresholds: {}, levels: {} };
  dashboard.skipped = {
    skippedCount: 1, skippedTypes: [{ taskType: 'example-task', successRate: 13, completed: 8 }],
  };
  dashboard.dismissed = [{ id: 'example-recommendation' }];
  const duration = { avgDurationMs: 60000, completed: 12, successRate: 83 };
  dashboard.durations = { 'example-task': duration, _overall: duration };
  const tier = { tier: 'light', successRate: 75, succeeded: 3, failed: 1 };
  dashboard.routing = {
    matrix: [
      { taskType: 'example-task', tiers: [tier, { ...tier, tier: 'medium' }] },
      { taskType: 'other-task', tiers: [tier] },
    ],
  };
  renderTab();
  await screen.findByText('Tasks Analyzed');

  for (const [name, initiallyExpanded] of [
    [/dismissed$/, false],
    [/^Confidence & Autonomy/, true],
    [/^Task Type Performance/, true],
    [/^Low-Success History/, true],
    [/^Duration Estimates/, false],
    [/^Model Performance/, true],
    [/^Routing Accuracy/, true],
    [/^Error Patterns/, false],
    [/^Standing Learnings/, true],
  ]) {
    const button = screen.getByRole('button', { name });
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('aria-expanded', String(initiallyExpanded));
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', String(!initiallyExpanded));
    if (initiallyExpanded) fireEvent.click(button);
  }

  expect(screen.getByRole('button', { name: 'Restore recommendation example-recommendation' }))
    .toHaveAttribute('type', 'button');
  expect(screen.getByRole('button', { name: 'Reset example-task' })).toHaveAttribute('type', 'button');

  const durationTable = within(screen.getByRole('table', { name: 'Duration Estimates' }));
  const routingTable = within(screen.getByRole('table', { name: 'Routing Accuracy' }));
  for (const table of [durationTable, routingTable]) {
    const columns = table.getAllByRole('columnheader');
    expect(columns).toHaveLength(5);
    columns.forEach(column => expect(column).toHaveAttribute('scope', 'col'));
  }
  expect(durationTable.getByRole('rowheader', { name: 'example-task' })).toHaveAttribute('scope', 'row');
  for (const [taskType, rows] of [['example-task', 2], ['other-task', 1]]) {
    const header = routingTable.getByRole('rowheader', { name: taskType });
    expect(header).toHaveAttribute('scope', 'rowgroup');
    expect(header).toHaveAttribute('rowspan', String(rows));
    expect(within(header.closest('tbody')).getAllByRole('row')).toHaveLength(rows);
  }
});
