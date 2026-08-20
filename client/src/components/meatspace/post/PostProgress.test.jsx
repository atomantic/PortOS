import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../../services/api', () => ({
  getPostProgress: vi.fn(),
  // PostHistory (the Sessions sub-view) imports these from the same module.
  getPostSessions: vi.fn().mockResolvedValue([]),
  getPostStats: vi.fn().mockResolvedValue(null),
  // PostHistory's useUserTimezone reads getSettings for its range-floor day key.
  getSettings: vi.fn().mockResolvedValue({ timezone: 'UTC' }),
}));

import PostProgress from './PostProgress';
import { getPostProgress } from '../../../services/api';

const PROGRESS = {
  days: 90,
  series: {
    byDay: [
      { date: '2026-06-01', score: 70, accuracy: 0.7, avgResponseMs: 3000, minutes: 5, sessions: 1 },
      { date: '2026-06-02', score: 82, accuracy: 0.85, avgResponseMs: 2500, minutes: 6, sessions: 1 },
      { date: '2026-06-03', score: 90, accuracy: 0.9, avgResponseMs: 2000, minutes: 4, sessions: 1 },
    ],
    byDomain: { 'mental-math': [] },
    byDrill: {
      multiplication: [
        { date: '2026-06-01', score: 70, accuracy: 0.7, avgResponseMs: 3000 },
        { date: '2026-06-02', score: 82, accuracy: 0.85, avgResponseMs: 2500 },
      ],
    },
  },
  totals: { minutesTrained: 135, sessions: 3, practiceEntries: 2 },
  streak: { current: 3, longest: 5, lastActiveDate: '2026-06-03' },
  mastery: {
    multiplication: { level: 2, description: '1×1×1-digit', floorLevel: 1 },
    cognitive: {
      stroop: {
        type: 'stroop',
        level: 1,
        label: '12 trials · 65% incongruent',
        levels: [
          { level: 0, samples: 3, accuracy: 0.9, completion: 1, incompleteSamples: 0, avgResponseMs: 1350, targetMs: 1500 },
          { level: 1, samples: 2, accuracy: 0.88, completion: 0.92, incompleteSamples: 1, avgResponseMs: 1450, targetMs: 1400 },
        ],
        thresholds: { minSamples: 3, targetAccuracy: 0.85, minCompletion: 0.75 },
        decision: { action: 'hold', reasons: ['samples', 'speed'] },
      },
    },
    memoryItems: [{ id: 'm1', title: 'Elements', overallPct: 42, dueCount: 1 }],
  },
};

function renderProgress(subtab) {
  return render(
    <MemoryRouter>
      <PostProgress subtab={subtab} onBack={() => {}} />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getPostProgress.mockResolvedValue(PROGRESS);
});

describe('PostProgress', () => {
  it('renders stat cards, trend charts, and the mastery panel', async () => {
    renderProgress();
    await waitFor(() => expect(screen.getByText('Time in Training')).toBeInTheDocument());
    // Unified streak + time in training cards.
    expect(screen.getByText('Current Streak')).toBeInTheDocument();
    expect(screen.getByText('2h 15m')).toBeInTheDocument(); // 135 minutes
    // Trend chart headings.
    expect(screen.getByText('Score Trend')).toBeInTheDocument();
    expect(screen.getByText('Accuracy Trend')).toBeInTheDocument();
    expect(screen.getByText(/Response Time/)).toBeInTheDocument();
    // Mastery panel: multiplication + performance-valid cognitive rung + memory.
    expect(screen.getByText('Multiplication Ladder')).toBeInTheDocument();
    expect(screen.getByText('L2')).toBeInTheDocument();
    expect(screen.getByText('Cognitive Ladders')).toBeInTheDocument();
    expect(screen.getByText('Stroop')).toBeInTheDocument();
    expect(screen.getByText('2/3 exact-rung runs')).toBeInTheDocument();
    expect(screen.getByText('1 incomplete excluded')).toBeInTheDocument();
    expect(screen.getByText('1.4s / ≤1.4s')).toBeInTheDocument();
    expect(screen.getByText('Elements')).toBeInTheDocument();
  });

  it('offers a per-domain trend selector', async () => {
    renderProgress();
    await waitFor(() => expect(screen.getByText('Trend focus:')).toBeInTheDocument());
    // The "All domains" focus button plus the domain derived from byDrill (Mental Math).
    expect(screen.getByRole('button', { name: 'All domains' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Mental Math/ })).toBeInTheDocument();
  });

  it('shows an empty state when there is no activity', async () => {
    getPostProgress.mockResolvedValue({
      days: 90,
      series: { byDay: [], byDomain: {}, byDrill: {} },
      totals: { minutesTrained: 0, sessions: 0, practiceEntries: 0 },
      streak: { current: 0, longest: 0, lastActiveDate: null },
      mastery: { multiplication: null, cognitive: {}, memoryItems: [] },
    });
    renderProgress();
    await waitFor(() => expect(screen.getByText(/No training activity yet/)).toBeInTheDocument());
  });

  it('renders the session-list sub-view when subtab is "sessions"', async () => {
    renderProgress('sessions');
    // PostHistory renders its own "POST History" heading.
    await waitFor(() => expect(screen.getByText('POST History')).toBeInTheDocument());
    // The progress endpoint is not fetched on the sessions sub-view.
    expect(getPostProgress).not.toHaveBeenCalled();
  });
});

// Protocol-scoped benchmark trend (issue #4442) — a narrower comparison than
// the blended Score Trend above, visibly separate from legacy/excluded runs.
describe('PostProgress — benchmark trend', () => {
  it('renders the benchmark trend chart with its protocol id/version in the title', async () => {
    getPostProgress.mockResolvedValue({
      ...PROGRESS,
      series: {
        ...PROGRESS.series,
        benchmark: {
          protocolId: 'post-foundation-battery',
          protocolVersion: 1,
          scorerVersion: 'post-deterministic-v1',
          byDay: [{ date: '2026-06-03', score: 88, sessions: 1 }],
          excludedCount: 0,
        },
      },
    });
    renderProgress();
    await waitFor(() => expect(screen.getByText(/Benchmark Trend/)).toBeInTheDocument());
    expect(screen.getByText(/post-foundation-battery v1/)).toBeInTheDocument();
  });

  it('shows a single-point summary instead of the empty state for exactly one compatible run (issue #4442 codex review)', async () => {
    getPostProgress.mockResolvedValue({
      ...PROGRESS,
      series: {
        ...PROGRESS.series,
        benchmark: {
          protocolId: 'post-foundation-battery',
          protocolVersion: 1,
          scorerVersion: 'post-deterministic-v1',
          byDay: [{ date: '2026-06-03', score: 88, sessions: 1 }],
          excludedCount: 0,
        },
      },
    });
    renderProgress();
    await waitFor(() => expect(screen.getByText(/Benchmark Trend/)).toBeInTheDocument());
    // The one real result must be visible, not masked by the "no runs yet" text
    // TrendChart's own multi-point chart would otherwise fall back to.
    expect(screen.getByText('88')).toBeInTheDocument();
    expect(screen.getByText(/2026-06-03/)).toBeInTheDocument();
    expect(screen.queryByText(/No compatible benchmark runs yet/)).not.toBeInTheDocument();
  });

  it('labels a single displayed point as a day average when it aggregates multiple same-day runs (issue #4442 codex review round 2)', async () => {
    getPostProgress.mockResolvedValue({
      ...PROGRESS,
      series: {
        ...PROGRESS.series,
        benchmark: {
          protocolId: 'post-foundation-battery',
          protocolVersion: 1,
          scorerVersion: 'post-deterministic-v2',
          byDay: [{ date: '2026-06-03', score: 70, sessions: 2 }],
          excludedCount: 0,
        },
      },
    });
    renderProgress();
    await waitFor(() => expect(screen.getByText(/Benchmark Trend/)).toBeInTheDocument());
    expect(screen.getByText(/Day average \(2 runs\)/)).toBeInTheDocument();
    expect(screen.queryByText(/Latest compatible run/)).not.toBeInTheDocument();
  });

  it('surfaces the excluded-legacy-runs note when excludedCount is set', async () => {
    getPostProgress.mockResolvedValue({
      ...PROGRESS,
      series: {
        ...PROGRESS.series,
        benchmark: {
          protocolId: 'post-foundation-battery',
          protocolVersion: 1,
          scorerVersion: 'post-deterministic-v1',
          byDay: [],
          excludedCount: 2,
        },
      },
    });
    renderProgress();
    await waitFor(() => expect(screen.getByText(/Benchmark Trend/)).toBeInTheDocument());
    expect(screen.getByText(/2 earlier benchmark runs excluded/)).toBeInTheDocument();
  });

  it('omits the benchmark trend section entirely when the server sends no benchmark field', async () => {
    renderProgress();
    await waitFor(() => expect(screen.getByText('Score Trend')).toBeInTheDocument());
    expect(screen.queryByText(/Benchmark Trend/)).not.toBeInTheDocument();
  });
});
