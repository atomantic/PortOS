import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ManuscriptCommentCard from './ManuscriptCommentCard';
import { Toaster } from '../../ui/Toast';
import {
  acceptPipelineManuscriptFix,
  patchPipelineManuscriptComment,
  generatePipelineManuscriptFix,
} from '../../../services/api';

vi.mock('../../../services/api', () => ({
  acceptPipelineManuscriptFix: vi.fn(),
  patchPipelineManuscriptComment: vi.fn(),
  generatePipelineManuscriptFix: vi.fn(),
}));

const baseComment = {
  id: 'c1',
  status: 'open',
  severity: 'high',
  category: 'clarity',
  problem: 'Confusing sentence',
  issueNumber: 5,
};
const withFix = {
  ...baseComment,
  fix: { edits: [{ find: 'old text', replace: 'new text', issueNumber: 5 }] },
};

const renderCard = (props) => render(
  <>
    <ManuscriptCommentCard
      comment={baseComment}
      seriesId="ser-1"
      onCommentChange={vi.fn()}
      onAccepted={vi.fn()}
      draft={null}
      onDraftChange={vi.fn()}
      {...props}
    />
    <Toaster />
  </>,
);

// Single-key shortcut dispatched against document.body (no editable focus).
const pressKey = (key) => fireEvent.keyDown(window, { key });

describe('ManuscriptCommentCard keyboard shortcuts (#1603)', () => {
  beforeEach(() => {
    acceptPipelineManuscriptFix.mockReset();
    patchPipelineManuscriptComment.mockReset();
    generatePipelineManuscriptFix.mockReset();
  });

  it('shows generate hint (and not accept) when the note has no fix yet', () => {
    renderCard();
    expect(screen.getByText('generate')).toBeTruthy();
    expect(screen.queryByText('accept')).toBeNull();
    expect(screen.getByText('dismiss')).toBeTruthy();
  });

  it('g triggers generate when there is no fix', () => {
    generatePipelineManuscriptFix.mockResolvedValue({ comment: baseComment });
    renderCard();
    pressKey('g');
    expect(generatePipelineManuscriptFix).toHaveBeenCalledWith('ser-1', 'c1', expect.any(Object));
  });

  it('d dismisses the note via the patch endpoint', async () => {
    patchPipelineManuscriptComment.mockResolvedValue({ comment: { ...baseComment, status: 'dismissed' } });
    renderCard();
    pressKey('d');
    await waitFor(() => expect(patchPipelineManuscriptComment).toHaveBeenCalledWith(
      'ser-1', 'c1', { status: 'dismissed' }, { silent: true },
    ));
  });

  it('a accepts the suggested fix when one exists, and shows accept/regenerate hints', () => {
    acceptPipelineManuscriptFix.mockResolvedValue({ comment: { ...withFix, status: 'accepted' } });
    renderCard({ comment: withFix });
    expect(screen.getByText('accept')).toBeTruthy();
    expect(screen.getByText('regenerate')).toBeTruthy();
    pressKey('a');
    expect(acceptPipelineManuscriptFix).toHaveBeenCalledWith('ser-1', 'c1', expect.objectContaining({
      edits: expect.arrayContaining([expect.objectContaining({ replace: 'new text' })]),
    }));
  });

  it('arrow keys step through the triage order, and the step hint renders only with nav', () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    const nav = { index: 1, total: 3, onPrev, onNext };
    const { rerender } = renderCard({ nav });
    expect(screen.getByText('step')).toBeTruthy();
    pressKey('ArrowRight');
    expect(onNext).toHaveBeenCalledTimes(1);
    pressKey('ArrowLeft');
    expect(onPrev).toHaveBeenCalledTimes(1);
    // vim aliases
    pressKey('j');
    expect(onNext).toHaveBeenCalledTimes(2);
    pressKey('k');
    expect(onPrev).toHaveBeenCalledTimes(2);

    rerender(
      <>
        <ManuscriptCommentCard comment={baseComment} seriesId="ser-1" onCommentChange={vi.fn()} onAccepted={vi.fn()} draft={null} onDraftChange={vi.fn()} />
        <Toaster />
      </>,
    );
    expect(screen.queryByText('step')).toBeNull();
  });

  it('does not fire a shortcut while typing in an editable field', () => {
    renderCard({ comment: withFix });
    const textarea = screen.getByLabelText(/Replacement \(editable\)/i);
    fireEvent.keyDown(textarea, { key: 'd' });
    expect(patchPipelineManuscriptComment).not.toHaveBeenCalled();
  });
});
