import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';

vi.mock('../../../services/apiMeatspace.js', () => ({
  getPostSessions: vi.fn(),
  getPostStats: vi.fn(),
}));
vi.mock('../../../services/apiSystem.js', () => ({
  getSettings: vi.fn().mockResolvedValue({ timezone: 'UTC' }),
}));

import PostHistory from './PostHistory';
import { getPostSessions, getPostStats } from '../../../services/apiMeatspace.js';

// Surfaces the current router path so navigation-on-row-click can be asserted —
// rows now open the deep-linkable /post/session/:id detail (issue #2098) rather
// than expanding inline.
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

function renderHistory() {
  return render(
    <MemoryRouter initialEntries={['/post/history']}>
      <PostHistory onBack={() => {}} />
      <LocationProbe />
    </MemoryRouter>
  );
}

// Runners save COARSE module keys (`mental-math`, `llm-drills`) — not DOMAINS
// keys — so getPostStats keys byModule/byDrill by those. The dashboard must
// derive the real domain (Mental Math / Wordplay) from the drill TYPE.
const SESSIONS = [
  {
    id: 'a', date: '2026-06-01', score: 72, durationMs: 300000, modules: ['mental-math', 'llm-drills'],
    tasks: [
      { module: 'mental-math', type: 'multiplication', score: 80, questions: [{ correct: true }] },
      { module: 'llm-drills', type: 'pun-wordplay', score: 64, responses: [{}] },
    ],
  },
  {
    id: 'b', date: '2026-06-02', score: 88, durationMs: 300000, modules: ['mental-math'],
    tasks: [
      { module: 'mental-math', type: 'multiplication', score: 90, questions: [{ correct: true }] },
    ],
  },
];

const STATS = {
  days: 30,
  sessionCount: 2,
  overall: 80,
  byModule: { 'mental-math': 85, 'llm-drills': 64 },
  byDrill: { 'mental-math:multiplication': 85, 'llm-drills:pun-wordplay': 64 },
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
    renderHistory();
    await waitFor(() => expect(screen.getByText('Current Streak')).toBeTruthy());
    expect(screen.getByText('Longest Streak')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy(); // current streak
    expect(screen.getByText('5')).toBeTruthy(); // longest streak
    expect(screen.getByText('Avg Score')).toBeTruthy();
  });

  it('renders per-domain and per-drill breakdowns from getPostStats', async () => {
    renderHistory();
    await waitFor(() => expect(screen.getByText('Drill Breakdown')).toBeTruthy());
    // Domain labels come from DOMAINS metadata, not raw keys.
    expect(screen.getAllByText('Mental Math').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Wordplay').length).toBeGreaterThan(0);
    // Per-drill labels render inside the breakdown.
    expect(screen.getByText('Multiplication')).toBeTruthy();
    expect(screen.getByText('Pun & Wordplay')).toBeTruthy();
  });

  it('reloads stats when the range selector changes', async () => {
    renderHistory();
    await waitFor(() => expect(getPostStats).toHaveBeenCalledWith(30, { silent: true }));
    fireEvent.click(screen.getByText('7d'));
    await waitFor(() => expect(getPostStats).toHaveBeenCalledWith(7, { silent: true }));
  });

  it('shows an empty state when no sessions are in range', async () => {
    getPostSessions.mockResolvedValue([]);
    getPostStats.mockResolvedValue({ ...STATS, sessionCount: 0, overall: null, byModule: {}, byDrill: {} });
    renderHistory();
    await waitFor(() => expect(screen.getByText('No sessions found for this range.')).toBeTruthy());
    expect(screen.queryByText('Drill Breakdown')).toBeNull();
  });

  it('reports a failed session read with Retry instead of "No sessions found", and recovers', async () => {
    // Persistent, not Once: when the browser zone differs from the configured one, useUserTimezone
    // changes `timezone` after mount and loadData fires a second read. A one-shot rejection would let
    // that reload succeed and clear the alert (passes in UTC CI, fails in any other local zone).
    getPostSessions.mockRejectedValue(new Error('db down'));
    renderHistory();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load POST sessions');
    expect(screen.queryByText('No sessions found for this range.')).toBeNull();
    expect(screen.queryByText('Complete more sessions to chart your trend.')).toBeNull();

    getPostSessions.mockResolvedValue(SESSIONS);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: /Session 2026-06-01/ })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

// Rows are now navigation controls into the deep-linkable session detail
// (/post/session/:id) — the per-question review (#2093) lives on that page now.
describe('PostHistory session rows navigate to the detail route (issue #2098)', () => {
  it('exposes each session row as a keyboard-focusable navigation control', async () => {
    renderHistory();
    const row = await screen.findByRole('button', { name: /Session 2026-06-01/ });
    expect(row).toHaveAttribute('tabindex', '0');
    expect(row).not.toHaveAttribute('aria-expanded');
  });

  it('navigates to /post/session/:id on click', async () => {
    renderHistory();
    fireEvent.click(await screen.findByRole('button', { name: /Session 2026-06-01/ }));
    expect(screen.getByTestId('loc')).toHaveTextContent('/post/session/a');
  });

  it('navigates via the Enter key (default prevented so the page does not scroll)', async () => {
    renderHistory();
    fireEvent.keyDown(await screen.findByRole('button', { name: /Session 2026-06-02/ }), { key: 'Enter' });
    expect(screen.getByTestId('loc')).toHaveTextContent('/post/session/b');
  });

  it('navigates via the Space key', async () => {
    renderHistory();
    fireEvent.keyDown(await screen.findByRole('button', { name: /Session 2026-06-01/ }), { key: ' ' });
    expect(screen.getByTestId('loc')).toHaveTextContent('/post/session/a');
  });

  it('ignores unrelated keys — a row does not navigate on an arbitrary keypress', async () => {
    renderHistory();
    fireEvent.keyDown(await screen.findByRole('button', { name: /Session 2026-06-01/ }), { key: 'a' });
    expect(screen.getByTestId('loc')).toHaveTextContent('/post/history');
  });
});
