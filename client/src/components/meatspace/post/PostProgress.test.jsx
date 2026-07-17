import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

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
    // Mastery panel: multiplication rung + memory item.
    expect(screen.getByText('Multiplication Ladder')).toBeInTheDocument();
    expect(screen.getByText('L2')).toBeInTheDocument();
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
      mastery: { multiplication: null, memoryItems: [] },
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
