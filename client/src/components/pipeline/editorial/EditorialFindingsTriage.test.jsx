import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import EditorialFindingsTriage from './EditorialFindingsTriage';
import { findingManuscriptLink } from '../../../lib/editorialChecks';
import { acceptPipelineManuscriptFix, patchPipelineManuscriptComment } from '../../../services/api';

// Mock the whole api barrel — include every export the component tree touches.
// EditorialFindingsTriage transitively imports ManuscriptCommentCard, which also
// pulls in generatePipelineManuscriptFix; stub it too so the mock stays a
// complete stand-in for the barrel rather than dropping that named export.
vi.mock('../../../services/api', () => ({
  acceptPipelineManuscriptFix: vi.fn(),
  patchPipelineManuscriptComment: vi.fn(),
  generatePipelineManuscriptFix: vi.fn(),
}));

const checksById = {
  'naming.dissimilar-names': { label: 'Character name dissimilarity', scope: 'series', kind: 'deterministic' },
};

const renderTriage = (props) => render(
  <MemoryRouter><EditorialFindingsTriage seriesId="ser-1" checksById={checksById} {...props} /></MemoryRouter>,
);

describe('EditorialFindingsTriage', () => {
  beforeEach(() => {
    acceptPipelineManuscriptFix.mockReset();
    patchPipelineManuscriptComment.mockReset();
  });

  it('shows the empty state when there are no check-sourced findings', () => {
    renderTriage({ comments: [{ id: 'x', problem: 'no checkId', status: 'open' }] });
    expect(screen.getByText(/No editorial-check findings yet/i)).toBeTruthy();
  });

  it('groups findings by check with an open/total header and deep-links each finding', () => {
    const comments = [
      { id: 'c1', checkId: 'naming.dissimilar-names', status: 'open', severity: 'high', issueNumber: 5, problem: 'Confusable names: Alice / Adam' },
      { id: 'c2', checkId: 'naming.dissimilar-names', status: 'dismissed', severity: 'low', issueNumber: null, problem: 'Old finding' },
    ];
    renderTriage({ comments });
    expect(screen.getByText('Character name dissimilarity')).toBeTruthy();
    expect(screen.getByText(/1 open · 2 total/)).toBeTruthy();
    const link = screen.getByText('Confusable names: Alice / Adam').closest('a');
    expect(link.getAttribute('href')).toBe(findingManuscriptLink('ser-1', comments[0]));
  });

  it('renders a stale badge (group + per-finding) when an open finding is stale (#1345)', () => {
    const comments = [
      { id: 'c1', checkId: 'naming.dissimilar-names', status: 'open', severity: 'high', problem: 'Stale finding', stale: true },
      { id: 'c2', checkId: 'naming.dissimilar-names', status: 'open', severity: 'low', problem: 'Fresh finding' },
    ];
    renderTriage({ comments });
    // Group header badge ("1 stale") + per-finding badge ("Stale") = 2 badges.
    expect(screen.getByText('1 stale')).toBeTruthy();
    expect(screen.getByText('Stale')).toBeTruthy();
  });

  it('does NOT render a stale badge when no open finding is stale', () => {
    const comments = [
      { id: 'c1', checkId: 'naming.dissimilar-names', status: 'open', severity: 'high', problem: 'Fresh finding' },
      // A dismissed-but-stale finding must not surface a badge.
      { id: 'c2', checkId: 'naming.dissimilar-names', status: 'dismissed', severity: 'low', problem: 'Old', stale: true },
    ];
    renderTriage({ comments });
    expect(screen.queryByText('Stale')).toBeNull();
    expect(screen.queryByText(/stale/i)).toBeNull();
  });

  it('previews a suggested fix inline and accepts it without leaving the page (#1598)', async () => {
    const onCommentChange = vi.fn();
    acceptPipelineManuscriptFix.mockResolvedValue({
      comment: { id: 'c1', checkId: 'naming.dissimilar-names', status: 'accepted', severity: 'high', problem: 'Confusable names' },
    });
    const comments = [{
      id: 'c1', checkId: 'naming.dissimilar-names', status: 'open', severity: 'high', problem: 'Confusable names',
      fix: { edits: [{ find: 'Adam', replace: 'Aaron' }] },
    }];
    renderTriage({ comments, onCommentChange });

    // The diff is collapsed until "Preview fix" is clicked.
    expect(screen.queryByText('Aaron')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /preview fix/i }));
    expect(screen.getByText('Aaron')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /accept/i }));
    await waitFor(() => expect(acceptPipelineManuscriptFix).toHaveBeenCalledTimes(1));
    const [, commentId, payload, options] = acceptPipelineManuscriptFix.mock.calls[0];
    expect(commentId).toBe('c1');
    expect(payload.edits).toEqual([{ find: 'Adam', replace: 'Aaron' }]);
    expect(options).toEqual({ silent: true });
    await waitFor(() => expect(onCommentChange).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1', status: 'accepted' })));
  });

  it('dismisses an open finding inline (#1598)', async () => {
    const onCommentChange = vi.fn();
    patchPipelineManuscriptComment.mockResolvedValue({
      comment: { id: 'c1', checkId: 'naming.dissimilar-names', status: 'dismissed', severity: 'low', problem: 'Minor' },
    });
    const comments = [{ id: 'c1', checkId: 'naming.dissimilar-names', status: 'open', severity: 'low', problem: 'Minor' }];
    renderTriage({ comments, onCommentChange });

    // No fix → no Accept/Preview, but Dismiss is still offered inline.
    expect(screen.queryByRole('button', { name: /accept/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /preview fix/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    await waitFor(() => expect(patchPipelineManuscriptComment).toHaveBeenCalledWith(
      'ser-1', 'c1', { status: 'dismissed' }, { silent: true },
    ));
    await waitFor(() => expect(onCommentChange).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1', status: 'dismissed' })));
  });

  it('does not offer inline actions on a resolved finding (#1598)', () => {
    const comments = [{ id: 'c1', checkId: 'naming.dissimilar-names', status: 'accepted', severity: 'high', problem: 'Done', fix: { edits: [{ find: 'a', replace: 'b' }] } }];
    renderTriage({ comments });
    expect(screen.queryByRole('button', { name: /accept/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /preview fix/i })).toBeNull();
  });
});
