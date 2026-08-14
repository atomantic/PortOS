/**
 * SeriesReviewPanel — the kickoff-conflict contract (#4113).
 *
 * The server refuses to coalesce a review/fix start whose options diverge from
 * the run already in flight, answering `{ alreadyRunning: true, conflict: true }`
 * instead. The panel must SURFACE that rather than binding its progress UI (and
 * its terminal-frame success handler) to a run computed from someone else's
 * options — and, for the review, must keep the user's un-taken note.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../services/api', () => ({
  startPipelineSeriesReview: vi.fn(),
  getPipelineSeriesReview: vi.fn(),
  getPipelineSeriesReviewStatus: vi.fn(),
  cancelPipelineSeriesReview: vi.fn(),
  pipelineSeriesReviewSseUrl: (id) => `/api/pipeline/series/${id}/review/progress`,
  startPipelineSeriesFix: vi.fn(),
  getPipelineSeriesFixStatus: vi.fn(),
  pipelineSeriesFixSseUrl: (id) => `/api/pipeline/series/${id}/review/fix/progress`,
  getPipelineSeries: vi.fn(),
  listPipelineIssues: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
}));
// No EventSource in jsdom — and this suite never needs a live stream.
vi.mock('../../hooks/usePipelineProgress', () => ({
  usePipelineProgress: () => ({ latest: null, frames: [], closed: false }),
}));

import {
  startPipelineSeriesReview,
  getPipelineSeriesReview,
  getPipelineSeriesReviewStatus,
  startPipelineSeriesFix,
  getPipelineSeriesFixStatus,
} from '../../services/api';
import toast from '../ui/Toast';
import SeriesReviewPanel from './SeriesReviewPanel';

const FINDINGS = [{ commentId: 'mrc-1', severity: 'high', issueNumber: 1, summary: 'the middle sags', location: 'V1' }];
const ISSUES_VERDICT = {
  verdict: 'issues', findings: FINDINGS, findingCount: 1, foundationThreshold: 7.5,
};

const renderPanel = () => render(
  <MemoryRouter>
    <SeriesReviewPanel series={{ id: 'ser-1' }} onSeriesUpdate={vi.fn()} onIssuesUpdate={vi.fn()} />
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  getPipelineSeriesReview.mockResolvedValue({ review: null, fix: { mode: 'execute', canFix: true } });
  getPipelineSeriesReviewStatus.mockResolvedValue({ active: false });
  getPipelineSeriesFixStatus.mockResolvedValue({ active: false });
});

describe('SeriesReviewPanel — review kickoff conflict', () => {
  it('reports the conflict and does NOT enter the reviewing state', async () => {
    startPipelineSeriesReview.mockResolvedValue({ runId: 'other-run', alreadyRunning: true, conflict: true });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /Review series/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/different review is already running/i)));
    // Still offering the action — never swapped to the in-flight run's "Stop".
    expect(screen.getByRole('button', { name: /Review series/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Stop/i })).toBeNull();
  });

  it('keeps the note the conflicting run never took', async () => {
    startPipelineSeriesReview.mockResolvedValue({ runId: 'other-run', alreadyRunning: true, conflict: true });
    renderPanel();
    const note = await screen.findByLabelText(/Anything specific/i);
    fireEvent.change(note, { target: { value: 'volume 1 has no real development' } });
    fireEvent.click(screen.getByRole('button', { name: /Review series/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(note).toHaveValue('volume 1 has no real development');
  });

  it('still tracks a normal (non-conflicting) start', async () => {
    startPipelineSeriesReview.mockResolvedValue({ runId: 'run-1', alreadyRunning: false });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /Review series/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Stop/i })).toBeInTheDocument());
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('SeriesReviewPanel — fix kickoff conflict', () => {
  beforeEach(() => {
    getPipelineSeriesReview.mockResolvedValue({ review: ISSUES_VERDICT, fix: { mode: 'execute', canFix: true } });
  });

  it('reports the conflict instead of adopting the other pass as its own', async () => {
    startPipelineSeriesFix.mockResolvedValue({ runId: 'other-fix', alreadyRunning: true, conflict: true });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /Fix these issues/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/different fix pass is already running/i)));
    // The confirm block is still up — the panel never entered the fixing state.
    expect(screen.getByRole('button', { name: /Fix these issues/i })).toBeInTheDocument();
  });

  it('still tracks a normal (non-conflicting) fix start', async () => {
    startPipelineSeriesFix.mockResolvedValue({ runId: 'fix-1', alreadyRunning: false });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /Fix these issues/i }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/Fixing started/i)));
    expect(toast.error).not.toHaveBeenCalled();
  });
});
