import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../services/apiPipeline', () => ({
  getIssueJudge: vi.fn(),
  judgeIssue: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { getIssueJudge, judgeIssue } from '../../services/apiPipeline';
import IssueJudgePanel from './IssueJudgePanel';

const proseIssue = (text = 'Some drafted prose.') => ({
  id: 'iss-1',
  stages: { prose: { output: text } },
});

const completeJudge = (over = {}) => ({
  status: 'complete',
  overall: 7,
  slopPenalty: 1.5,
  qualityScore: 5.5,
  sceneVsSummaryRatio: 0.7,
  oneLineVerdict: 'Tighten the middle.',
  dimensions: { voiceAdherence: { score: 6, weakestMoment: 'flat', fix: 'vary rhythm' } },
  topRevisions: ['cut the exposition'],
  weakestSentences: ['a weak line'],
  strongestSentences: ['a strong line'],
  completedAt: new Date().toISOString(),
  stale: false,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  getIssueJudge.mockResolvedValue(null);
  judgeIssue.mockResolvedValue(completeJudge());
});

describe('IssueJudgePanel', () => {
  it('renders nothing when no text stage has content', async () => {
    const { container } = render(<IssueJudgePanel issue={{ id: 'iss-x', stages: {} }} stageId="prose" />);
    expect(container.firstChild).toBeNull();
    // Drain the mount getIssueJudge fetch inside act so its state update
    // can't land outside it after the test body.
    await act(async () => {});
  });

  it('shows the not-judged state then the quality chip after a stored score loads', async () => {
    getIssueJudge.mockResolvedValue(completeJudge());
    render(<IssueJudgePanel issue={proseIssue()} stageId="prose" />);
    await waitFor(() => expect(screen.getByText('5.5')).toBeInTheDocument());
    expect(screen.getByText('Quality judge')).toBeInTheDocument();
  });

  it('dispatches judgeIssue with the resolved stage on click and shows the result', async () => {
    getIssueJudge.mockResolvedValue(null);
    render(<IssueJudgePanel issue={proseIssue()} stageId="prose" />);
    await waitFor(() => expect(screen.getByText(/Judge quality/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/Judge quality/));
    await waitFor(() => expect(judgeIssue).toHaveBeenCalledWith(
      'iss-1', { stageId: 'prose', force: true }, { silent: true },
    ));
    await waitFor(() => expect(screen.getByText('5.5')).toBeInTheDocument());
  });

  it('flags a stale score', async () => {
    getIssueJudge.mockResolvedValue(completeJudge({ stale: true }));
    render(<IssueJudgePanel issue={proseIssue()} stageId="prose" />);
    await waitFor(() => expect(screen.getByText('stale')).toBeInTheDocument());
  });
});
