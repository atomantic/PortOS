import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('../../../services/api', () => ({
  getPostSessions: vi.fn(),
  getPostStats: vi.fn(),
}));

// recharts ResponsiveContainer renders nothing at 0-width in jsdom; the
// assertions below target the non-chart DOM (stat cards + drill breakdown).
import PostHistory from './PostHistory';
import { getPostSessions, getPostStats } from '../../../services/api';

const SESSIONS = [
  {
    id: 'a', date: '2026-06-01', score: 72, durationMs: 300000, modules: ['math', 'wordplay'],
    tasks: [
      { module: 'math', type: 'multiplication', score: 80, questions: [{ correct: true }] },
      { module: 'wordplay', type: 'pun-wordplay', score: 64, responses: [{}] },
    ],
  },
  {
    id: 'b', date: '2026-06-02', score: 88, durationMs: 300000, modules: ['math'],
    tasks: [
      { module: 'math', type: 'multiplication', score: 90, questions: [{ correct: true }] },
    ],
  },
];

const STATS = {
  days: 30,
  sessionCount: 2,
  overall: 80,
  byModule: { math: 85, wordplay: 64 },
  byDrill: { 'math:multiplication': 85, 'wordplay:pun-wordplay': 64 },
  currentStreak: 3,
  longestStreak: 5,
};

beforeEach(() => {
  vi.clearAllMocks();
  getPostSessions.mockResolvedValue(SESSIONS);
  getPostStats.mockResolvedValue(STATS);
});

describe('PostHistory analytics dashboard', () => {
  it('surfaces streaks and overall stats without opening a session', async () => {
    render(<PostHistory onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText('Current Streak')).toBeTruthy());
    expect(screen.getByText('Longest Streak')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy(); // current streak
    expect(screen.getByText('5')).toBeTruthy(); // longest streak
    expect(screen.getByText('Avg Score')).toBeTruthy();
  });

  it('renders per-domain and per-drill breakdowns from getPostStats', async () => {
    render(<PostHistory onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText('Drill Breakdown')).toBeTruthy());
    // Domain labels come from DOMAINS metadata, not raw keys.
    expect(screen.getAllByText('Mental Math').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Wordplay').length).toBeGreaterThan(0);
    // Per-drill labels render inside the breakdown.
    expect(screen.getByText('Multiplication')).toBeTruthy();
    expect(screen.getByText('Pun & Wordplay')).toBeTruthy();
  });

  it('reloads stats when the range selector changes', async () => {
    render(<PostHistory onBack={() => {}} />);
    await waitFor(() => expect(getPostStats).toHaveBeenCalledWith(30));
    fireEvent.click(screen.getByText('7d'));
    await waitFor(() => expect(getPostStats).toHaveBeenCalledWith(7));
  });

  it('shows an empty state when no sessions are in range', async () => {
    getPostSessions.mockResolvedValue([]);
    getPostStats.mockResolvedValue({ ...STATS, sessionCount: 0, overall: null, byModule: {}, byDrill: {} });
    render(<PostHistory onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText('No sessions found for this range.')).toBeTruthy());
    expect(screen.queryByText('Drill Breakdown')).toBeNull();
  });
});
