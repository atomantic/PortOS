import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import ManuscriptCommentCard, { Badge } from './ManuscriptCommentCard';
import { Toaster, toast } from '../../ui/Toast';
import {
  acceptPipelineManuscriptFix,
  patchPipelineManuscriptComment,
  generatePipelineManuscriptFix,
  undoPipelineManuscriptFix,
} from '../../../services/api';

vi.mock('../../../services/api', () => ({
  acceptPipelineManuscriptFix: vi.fn(),
  patchPipelineManuscriptComment: vi.fn(),
  generatePipelineManuscriptFix: vi.fn(),
  undoPipelineManuscriptFix: vi.fn(),
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
const withAnchor = {
  ...baseComment,
  issueId: 'iss-1',
  stageId: 'script',
  anchorQuote: 'the muddled span',
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

// Drain pending pre-resolved mock promises inside act so their state updates
// (card status, Toaster toast) can't land outside it after the test body.
const settle = () => act(async () => {});

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

  it('g triggers generate when there is no fix', async () => {
    generatePipelineManuscriptFix.mockResolvedValue({ comment: baseComment });
    renderCard();
    pressKey('g');
    expect(generatePipelineManuscriptFix).toHaveBeenCalledWith('ser-1', 'c1', expect.any(Object), { silent: true });
    await settle();
  });

  it('d dismisses the note via the patch endpoint', async () => {
    patchPipelineManuscriptComment.mockResolvedValue({ comment: { ...baseComment, status: 'dismissed' } });
    renderCard();
    pressKey('d');
    await waitFor(() => expect(patchPipelineManuscriptComment).toHaveBeenCalledWith(
      'ser-1', 'c1', { status: 'dismissed', dismissReason: null }, { silent: true },
    ));
  });

  it('f flags a check-sourced finding as a false positive (#1605)', async () => {
    const checkComment = { ...baseComment, checkId: 'prose.info-dumping' };
    patchPipelineManuscriptComment.mockResolvedValue({ comment: { ...checkComment, status: 'dismissed', dismissReason: 'false-positive' } });
    render(
      <>
        <ManuscriptCommentCard comment={checkComment} seriesId="ser-1" onCommentChange={vi.fn()} onAccepted={vi.fn()} draft={null} onDraftChange={vi.fn()} />
        <Toaster />
      </>,
    );
    expect(screen.getByText('False positive')).toBeTruthy();
    pressKey('f');
    await waitFor(() => expect(patchPipelineManuscriptComment).toHaveBeenCalledWith(
      'ser-1', 'c1', { status: 'dismissed', dismissReason: 'false-positive' }, { silent: true },
    ));
  });

  it('does NOT offer the false-positive action for a completeness finding (no checkId)', () => {
    renderCard();
    expect(screen.queryByText('False positive')).toBeNull();
  });

  it('a accepts the suggested fix when one exists, and shows accept/regenerate hints', async () => {
    acceptPipelineManuscriptFix.mockResolvedValue({ comment: { ...withFix, status: 'accepted' } });
    renderCard({ comment: withFix });
    expect(screen.getByText('accept')).toBeTruthy();
    expect(screen.getByText('regenerate')).toBeTruthy();
    pressKey('a');
    expect(acceptPipelineManuscriptFix).toHaveBeenCalledWith('ser-1', 'c1', expect.objectContaining({
      edits: expect.arrayContaining([expect.objectContaining({ replace: 'new text' })]),
    }), { silent: true });
    await settle();
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

describe('ManuscriptCommentCard — accept toast offers Undo (#1609)', () => {
  beforeEach(() => {
    acceptPipelineManuscriptFix.mockReset();
    undoPipelineManuscriptFix.mockReset();
    toast.dismiss(); // clear any accept toast left over from a prior test
  });

  it('shows an Undo action after accept, and clicking it undoes the fix', async () => {
    acceptPipelineManuscriptFix.mockResolvedValue({ comment: { ...withFix, status: 'accepted' }, sections: [] });
    undoPipelineManuscriptFix.mockResolvedValue({ comment: { ...withFix, status: 'open' }, sections: [] });
    const onAccepted = vi.fn();
    renderCard({ comment: withFix, onAccepted });

    pressKey('a');
    await waitFor(() => expect(acceptPipelineManuscriptFix).toHaveBeenCalled());
    // The success toast renders with an inline Undo button.
    const undoBtn = await screen.findByRole('button', { name: /undo/i });
    expect(screen.getByText('Fix applied to the manuscript')).toBeTruthy();

    fireEvent.click(undoBtn);
    await waitFor(() => expect(undoPipelineManuscriptFix).toHaveBeenCalledWith('ser-1', 'c1', { silent: true }));
    // The undo result is re-applied through onAccepted (re-opens the finding).
    await waitFor(() => expect(onAccepted).toHaveBeenCalledWith(expect.objectContaining({
      comment: expect.objectContaining({ status: 'open' }),
    })));
    expect(await screen.findByText(/Fix undone/i)).toBeTruthy();
  });
});

describe('ManuscriptCommentCard — manual edit path (#1610)', () => {
  beforeEach(() => {
    acceptPipelineManuscriptFix.mockReset();
    toast.dismiss();
  });

  it('offers a manual-edit affordance for an anchored finding with no fix', () => {
    renderCard({ comment: withAnchor });
    expect(screen.getByText('Generate fix')).toBeTruthy();
    expect(screen.getByText('Manual edit')).toBeTruthy();
    expect(screen.getByText('manual edit')).toBeTruthy(); // shortcut hint
  });

  it('does NOT offer manual edit when the finding has no anchor span', () => {
    renderCard(); // baseComment has no anchorQuote
    expect(screen.queryByText('Manual edit')).toBeNull();
  });

  it('applies a manual replacement against the anchored span through the accept path', async () => {
    acceptPipelineManuscriptFix.mockResolvedValue({ comment: { ...withAnchor, status: 'accepted' }, sections: [] });
    const onAccepted = vi.fn();
    renderCard({ comment: withAnchor, onAccepted });

    fireEvent.click(screen.getByText('Manual edit'));
    const textarea = screen.getByLabelText(/Replacement \(editable\)/i);
    expect(textarea.value).toBe('the muddled span'); // seeded with the anchor
    fireEvent.change(textarea, { target: { value: 'the clear span' } });
    fireEvent.click(screen.getByText('Apply edit'));

    await waitFor(() => expect(acceptPipelineManuscriptFix).toHaveBeenCalledWith('ser-1', 'c1', {
      edits: [{ issueId: 'iss-1', stageId: 'script', issueNumber: 5, find: 'the muddled span', replace: 'the clear span' }],
    }, { silent: true }));
    await waitFor(() => expect(onAccepted).toHaveBeenCalled());
  });

  it('disables Apply until the replacement differs from the anchored span', () => {
    renderCard({ comment: withAnchor });
    fireEvent.click(screen.getByText('Manual edit'));
    // Seeded value equals the anchor → no-op, so Apply is disabled.
    expect(screen.getByText('Apply edit').closest('button').disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Replacement \(editable\)/i), { target: { value: 'changed' } });
    expect(screen.getByText('Apply edit').closest('button').disabled).toBe(false);
  });

  it('m toggles manual-edit mode for an anchored finding', () => {
    renderCard({ comment: withAnchor });
    expect(screen.queryByLabelText(/Replacement \(editable\)/i)).toBeNull();
    pressKey('m');
    expect(screen.getByLabelText(/Replacement \(editable\)/i)).toBeTruthy();
    pressKey('m');
    expect(screen.queryByLabelText(/Replacement \(editable\)/i)).toBeNull();
  });
});

describe('ManuscriptCommentCard Badge — subtype (#1626)', () => {
  it('renders a labeled subtype badge when the finding carries one', () => {
    render(<Badge comment={{ ...baseComment, category: 'dialogue', subtype: 'emotion-tell' }} />);
    expect(screen.getByText('Emotion-tell')).toBeTruthy();
  });

  it('falls back to the raw subtype when unmapped', () => {
    render(<Badge comment={{ ...baseComment, category: 'dialogue', subtype: 'novel-kind' }} />);
    expect(screen.getByText('novel-kind')).toBeTruthy();
  });

  it('renders no subtype badge when absent', () => {
    render(<Badge comment={{ ...baseComment, category: 'dialogue', subtype: null }} />);
    expect(screen.queryByText('Emotion-tell')).toBeNull();
  });

  it('renders a prototype-key subtype as its raw string without crashing', () => {
    // A hand-edited / older-peer record whose subtype is a prototype key must not
    // resolve to an inherited Object.prototype member (a truthy non-string) — that
    // would throw "Objects are not valid as a React child" and blank the card.
    render(<Badge comment={{ ...baseComment, category: 'dialogue', subtype: '__proto__' }} />);
    expect(screen.getByText('__proto__')).toBeTruthy();
  });
});
