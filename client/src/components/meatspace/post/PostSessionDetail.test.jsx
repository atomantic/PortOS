import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('../../../services/api', () => ({
  getPostSession: vi.fn(),
}));

import PostSessionDetail from './PostSessionDetail';
import { getPostSession } from '../../../services/api';

const SESSION = {
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
};

beforeEach(() => vi.clearAllMocks());

describe('PostSessionDetail (deep-linkable saved session, issue #2098)', () => {
  it('renders the saved session score and drill breakdown', async () => {
    getPostSession.mockResolvedValue(SESSION);
    render(<PostSessionDetail id="c" onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText('2026-06-03')).toBeTruthy());
    expect(screen.getByText('70')).toBeTruthy(); // session score
    expect(screen.getByText('Multiplication')).toBeTruthy();
  });

  it('reuses DrillQuestionReview when a non-LLM drill is expanded (preserves #2093 review)', async () => {
    getPostSession.mockResolvedValue(SESSION);
    render(<PostSessionDetail id="c" onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText('Multiplication')).toBeTruthy());
    // Expand the multiplication drill to reveal the per-question review.
    fireEvent.click(screen.getByText('Multiplication'));
    await waitFor(() => expect(screen.getByText('1 missed')).toBeTruthy());
    expect(screen.getByText('42')).toBeTruthy(); // the correct answer surfaced in the review
  });

  it('renders a not-found fallback for a stale/deleted id', async () => {
    getPostSession.mockResolvedValue(null);
    render(<PostSessionDetail id="gone" onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText('Session not found')).toBeTruthy());
  });
});
