import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

vi.mock('../../../services/api', () => ({
  getPostSessions: vi.fn(),
  getPostStats: vi.fn(),
}));

// recharts ResponsiveContainer renders nothing at 0-width in jsdom; the
// assertions below target the non-chart DOM (stat cards + drill breakdown).
import PostHistory from './PostHistory';
import { getPostSessions, getPostStats } from '../../../services/api';

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
    // The 'Mental Math' / 'Wordplay' domain labels above can ONLY appear when the
    // domain is derived from the drill TYPE (multiplication→math, pun-wordplay→
    // wordplay). The coarse `byModule`/byDrill keys are 'mental-math'/'llm-drills',
    // so the earlier byModule-keyed implementation would have rendered those raw.
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

  describe('session row keyboard accessibility', () => {
    it('exposes a collapsed session row as a disclosure control with aria-expanded=false', async () => {
      render(<PostHistory onBack={() => {}} />);
      await waitFor(() => expect(screen.getByText('2026-06-01')).toBeTruthy());
      const row = screen.getByRole('button', { name: /Session 2026-06-01/ });
      expect(row).toHaveAttribute('aria-expanded', 'false');
      expect(row).toHaveAttribute('tabindex', '0');
    });

    it('expands a row via a click, flipping aria-expanded and revealing task detail', async () => {
      render(<PostHistory onBack={() => {}} />);
      await waitFor(() => expect(screen.getByText('2026-06-01')).toBeTruthy());
      const table = screen.getByRole('table');
      expect(within(table).queryByText('Multiplication')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /Session 2026-06-01/ }));
      expect(screen.getByRole('button', { name: /Session 2026-06-01/ })).toHaveAttribute('aria-expanded', 'true');
      expect(within(table).getByText('Multiplication')).toBeTruthy();
    });

    it('expands and collapses a row via the Enter key, without scrolling the page (default prevented)', async () => {
      render(<PostHistory onBack={() => {}} />);
      await waitFor(() => expect(screen.getByText('2026-06-01')).toBeTruthy());
      const table = screen.getByRole('table');
      const row = screen.getByRole('button', { name: /Session 2026-06-01/ });
      fireEvent.keyDown(row, { key: 'Enter' });
      expect(screen.getByRole('button', { name: /Session 2026-06-01/ })).toHaveAttribute('aria-expanded', 'true');
      expect(within(table).getByText('Multiplication')).toBeTruthy();
      fireEvent.keyDown(screen.getByRole('button', { name: /Session 2026-06-01/ }), { key: 'Enter' });
      expect(screen.getByRole('button', { name: /Session 2026-06-01/ })).toHaveAttribute('aria-expanded', 'false');
      expect(within(table).queryByText('Multiplication')).toBeNull();
    });

    it('expands a row via the Space key', async () => {
      render(<PostHistory onBack={() => {}} />);
      await waitFor(() => expect(screen.getByText('2026-06-01')).toBeTruthy());
      const row = screen.getByRole('button', { name: /Session 2026-06-01/ });
      fireEvent.keyDown(row, { key: ' ' });
      expect(screen.getByRole('button', { name: /Session 2026-06-01/ })).toHaveAttribute('aria-expanded', 'true');
    });

    it('ignores unrelated keys — a row does not expand on an arbitrary keypress', async () => {
      render(<PostHistory onBack={() => {}} />);
      await waitFor(() => expect(screen.getByText('2026-06-01')).toBeTruthy());
      const row = screen.getByRole('button', { name: /Session 2026-06-01/ });
      fireEvent.keyDown(row, { key: 'a' });
      expect(row).toHaveAttribute('aria-expanded', 'false');
    });
  });
});

// Issue #2093 — expanding a past session must reuse DrillQuestionReview so
// history teaches from mistakes exactly like the just-finished session does.
describe('PostHistory expanded session review', () => {
  const REVIEW_SESSIONS = [
    {
      id: 'c', date: '2026-06-03', score: 70, durationMs: 60000, modules: ['mental-math'],
      tasks: [
        {
          module: 'mental-math', type: 'multiplication', score: 50,
          questions: [
            { prompt: '6 x 7', expected: 42, answered: 41, correct: false, responseMs: 2000 },
            { prompt: '3 x 3', expected: 9, answered: 9, correct: true, responseMs: 1200 },
          ],
        },
        { module: 'llm-drills', type: 'pun-wordplay', score: 64, responses: [{}] },
      ],
    },
  ];

  it('reuses DrillQuestionReview inside an expanded session for a non-LLM task', async () => {
    getPostSessions.mockResolvedValue(REVIEW_SESSIONS);
    render(<PostHistory onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText('2026-06-03')).toBeTruthy());

    fireEvent.click(screen.getByText('2026-06-03'));

    // The missed-item summary + per-question table (shared with PostSessionResults).
    // "6 x 7" appears twice once expanded: once in the missed-items chip,
    // once in the per-question table row.
    await waitFor(() => expect(screen.getByText('1 missed')).toBeTruthy());
    expect(screen.getAllByText('6 x 7').length).toBe(2);
    expect(screen.getByText('42')).toBeTruthy();
  });

  it('does not render a review for an LLM task (unchanged summary-only behavior)', async () => {
    getPostSessions.mockResolvedValue(REVIEW_SESSIONS);
    render(<PostHistory onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText('2026-06-03')).toBeTruthy());

    fireEvent.click(screen.getByText('2026-06-03'));

    await waitFor(() => expect(screen.getByText('1 responses')).toBeTruthy());
    // No missed-item summary rendered twice — only the one math task produces it.
    expect(screen.getAllByText(/missed/).length).toBe(1);
  });
});
