import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import EditorialFindingsTriage from './EditorialFindingsTriage';
import { toast } from '../../ui/Toast';
import { findingManuscriptLink } from '../../../lib/editorialChecks';
import { acceptPipelineManuscriptFix, patchPipelineManuscriptComment, undoPipelineManuscriptFix } from '../../../services/api';

// Mock the whole api barrel — include every export the component tree touches.
// EditorialFindingsTriage transitively imports ManuscriptCommentCard, which also
// pulls in generatePipelineManuscriptFix; stub it too so the mock stays a
// complete stand-in for the barrel rather than dropping that named export.
vi.mock('../../../services/api', () => ({
  acceptPipelineManuscriptFix: vi.fn(),
  patchPipelineManuscriptComment: vi.fn(),
  undoPipelineManuscriptFix: vi.fn(),
  generatePipelineManuscriptFix: vi.fn(),
}));

const checksById = {
  'naming.dissimilar-names': {
    label: 'Character name dissimilarity',
    scope: 'series',
    kind: 'deterministic',
    description: 'Flags character names that are too visually similar to tell apart.',
  },
};

const renderTriage = (props) => render(
  <MemoryRouter><EditorialFindingsTriage seriesId="ser-1" checksById={checksById} {...props} /></MemoryRouter>,
);

describe('EditorialFindingsTriage', () => {
  beforeEach(() => {
    acceptPipelineManuscriptFix.mockReset();
    patchPipelineManuscriptComment.mockReset();
    toast.dismiss(); // clear any toast left over from a prior test
  });

  it('shows the empty state when there are no check-sourced findings', () => {
    renderTriage({ comments: [{ id: 'x', problem: 'no checkId', status: 'open' }] });
    expect(screen.getByText(/No editorial-check findings yet/i)).toBeTruthy();
  });

  it('offers next-step CTAs in the no-findings empty state (#1612)', () => {
    const onRunChecks = vi.fn();
    renderTriage({ comments: [], onRunChecks });
    fireEvent.click(screen.getByRole('button', { name: /Run checks/i }));
    expect(onRunChecks).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: /Refresh reverse outline/i }).getAttribute('href'))
      .toBe('/pipeline/series/ser-1/reverse-outline');
    expect(screen.getByRole('link', { name: /Continue in the pipeline/i }).getAttribute('href'))
      .toBe('/pipeline/series/ser-1');
  });

  it('shows an "all cleared" CTA when findings exist but none are open (#1612)', () => {
    const onRunChecks = vi.fn();
    const comments = [
      { id: 'c1', checkId: 'naming.dissimilar-names', status: 'accepted', severity: 'high', problem: 'Confusable names' },
      { id: 'c2', checkId: 'naming.dissimilar-names', status: 'dismissed', severity: 'low', problem: 'Old finding' },
    ];
    renderTriage({ comments, onRunChecks });
    expect(screen.getByText(/All findings cleared/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Re-run checks/i }));
    expect(onRunChecks).toHaveBeenCalledTimes(1);
    // The resolved groups still render below the CTA so the user can review/undo.
    expect(screen.getByText('Character name dissimilarity')).toBeTruthy();
  });

  it('does not show the "all cleared" CTA while any finding is still open (#1612)', () => {
    const comments = [
      { id: 'c1', checkId: 'naming.dissimilar-names', status: 'open', severity: 'high', problem: 'Still open' },
      { id: 'c2', checkId: 'naming.dissimilar-names', status: 'accepted', severity: 'low', problem: 'Done' },
    ];
    renderTriage({ comments, onRunChecks: vi.fn() });
    expect(screen.queryByText(/All findings cleared/i)).toBeNull();
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

  it('shows the check kind badge and toggles its description in the group header (#1604)', () => {
    const comments = [
      { id: 'c1', checkId: 'naming.dissimilar-names', status: 'open', severity: 'high', problem: 'Confusable names' },
    ];
    renderTriage({ comments });
    // Kind badge is always visible so the user can tell rule from LLM at a glance.
    expect(screen.getByText('rule')).toBeTruthy();
    // Description is collapsed until the info toggle is clicked.
    expect(screen.queryByText(/too visually similar/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /show description for/i }));
    expect(screen.getByText(/too visually similar/i)).toBeTruthy();
    // Toggling again hides it.
    fireEvent.click(screen.getByRole('button', { name: /hide description for/i }));
    expect(screen.queryByText(/too visually similar/i)).toBeNull();
  });

  it('omits the description toggle when the check has no documented description (#1604)', () => {
    const comments = [
      { id: 'c1', checkId: 'unknown.check', status: 'open', severity: 'low', problem: 'Orphan finding' },
    ];
    renderTriage({ comments });
    expect(screen.queryByRole('button', { name: /show description for/i })).toBeNull();
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
      'ser-1', 'c1', { status: 'dismissed', dismissReason: null }, { silent: true },
    ));
    await waitFor(() => expect(onCommentChange).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1', status: 'dismissed' })));
  });

  it('flags a finding as a false positive inline (#1605)', async () => {
    const onCommentChange = vi.fn();
    patchPipelineManuscriptComment.mockResolvedValue({ comment: { id: 'c1', checkId: 'naming.dissimilar-names', status: 'dismissed', dismissReason: 'false-positive', severity: 'high', problem: 'Bad finding' } });
    const comments = [{ id: 'c1', checkId: 'naming.dissimilar-names', status: 'open', severity: 'high', problem: 'Bad finding' }];
    renderTriage({ comments, onCommentChange });

    fireEvent.click(screen.getByRole('button', { name: /false positive/i }));
    await waitFor(() => expect(patchPipelineManuscriptComment).toHaveBeenCalledWith(
      'ser-1', 'c1', { status: 'dismissed', dismissReason: 'false-positive' }, { silent: true },
    ));
  });

  it('does not offer inline actions on a resolved finding (#1598)', () => {
    const comments = [{ id: 'c1', checkId: 'naming.dissimilar-names', status: 'accepted', severity: 'high', problem: 'Done', fix: { edits: [{ find: 'a', replace: 'b' }] } }];
    renderTriage({ comments });
    expect(screen.queryByRole('button', { name: /accept/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /preview fix/i })).toBeNull();
  });

  it('only surfaces a selection checkbox for open findings (#1599)', () => {
    const comments = [
      { id: 'c1', checkId: 'naming.dissimilar-names', status: 'open', severity: 'high', problem: 'Open one' },
      { id: 'c2', checkId: 'naming.dissimilar-names', status: 'dismissed', severity: 'low', problem: 'Resolved one' },
    ];
    renderTriage({ comments });
    expect(screen.getByLabelText('Select finding: Open one')).toBeTruthy();
    expect(screen.queryByLabelText('Select finding: Resolved one')).toBeNull();
  });

  it('reveals the bulk action bar once a finding is selected and bulk-dismisses the selection (#1599)', async () => {
    const onCommentChange = vi.fn();
    patchPipelineManuscriptComment
      .mockResolvedValueOnce({ comment: { id: 'c1', checkId: 'naming.dissimilar-names', status: 'dismissed', severity: 'high', problem: 'A' } })
      .mockResolvedValueOnce({ comment: { id: 'c2', checkId: 'naming.dissimilar-names', status: 'dismissed', severity: 'low', problem: 'B' } });
    const comments = [
      { id: 'c1', checkId: 'naming.dissimilar-names', status: 'open', severity: 'high', problem: 'A' },
      { id: 'c2', checkId: 'naming.dissimilar-names', status: 'open', severity: 'low', problem: 'B' },
    ];
    renderTriage({ comments, onCommentChange });

    // No selection → no bar.
    expect(screen.queryByText(/selected$/)).toBeNull();
    fireEvent.click(screen.getByLabelText('Select finding: A'));
    fireEvent.click(screen.getByLabelText('Select finding: B'));
    expect(screen.getByText('2 selected')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /dismiss 2/i }));
    await waitFor(() => expect(patchPipelineManuscriptComment).toHaveBeenCalledTimes(2));
    expect(patchPipelineManuscriptComment).toHaveBeenCalledWith('ser-1', 'c1', { status: 'dismissed', dismissReason: null }, { silent: true });
    expect(patchPipelineManuscriptComment).toHaveBeenCalledWith('ser-1', 'c2', { status: 'dismissed', dismissReason: null }, { silent: true });
    await waitFor(() => expect(onCommentChange).toHaveBeenCalledTimes(2));
  });

  it('bulk-accepts only the selected findings that carry an applicable fix (#1599)', async () => {
    const onCommentChange = vi.fn();
    acceptPipelineManuscriptFix.mockResolvedValue({
      comment: { id: 'c1', checkId: 'naming.dissimilar-names', status: 'accepted', severity: 'high', problem: 'Fixable' },
    });
    const comments = [
      { id: 'c1', checkId: 'naming.dissimilar-names', status: 'open', severity: 'high', problem: 'Fixable', fix: { edits: [{ find: 'Adam', replace: 'Aaron' }] } },
      { id: 'c2', checkId: 'naming.dissimilar-names', status: 'open', severity: 'low', problem: 'No fix' },
    ];
    renderTriage({ comments, onCommentChange });

    fireEvent.click(screen.getByLabelText('Select finding: Fixable'));
    fireEvent.click(screen.getByLabelText('Select finding: No fix'));
    // Both selected, but only one has an applicable fix.
    expect(screen.getByRole('button', { name: /accept 1/i })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /accept 1/i }));
    await waitFor(() => expect(acceptPipelineManuscriptFix).toHaveBeenCalledTimes(1));
    const [, commentId, payload, options] = acceptPipelineManuscriptFix.mock.calls[0];
    expect(commentId).toBe('c1');
    expect(payload.edits).toEqual([{ find: 'Adam', replace: 'Aaron' }]);
    expect(options).toEqual({ silent: true });
  });

  it('selects every open finding in a group via the group checkbox (#1599)', () => {
    const comments = [
      { id: 'c1', checkId: 'naming.dissimilar-names', status: 'open', severity: 'high', problem: 'A' },
      { id: 'c2', checkId: 'naming.dissimilar-names', status: 'open', severity: 'low', problem: 'B' },
      { id: 'c3', checkId: 'naming.dissimilar-names', status: 'dismissed', severity: 'low', problem: 'C' },
    ];
    renderTriage({ comments });
    fireEvent.click(screen.getByLabelText(/Select all open findings in Character name dissimilarity/i));
    // Two open findings selected (the dismissed one is not selectable).
    expect(screen.getByText('2 selected')).toBeTruthy();
  });

  // ---- Filter / search / sort (#1600) ----
  const twoCheckChecks = {
    'naming.dissimilar-names': { label: 'Character name dissimilarity', scope: 'series', kind: 'deterministic' },
    'pacing.scene-drag': { label: 'Scene pacing drag', scope: 'scene', kind: 'llm' },
  };
  const twoCheckComments = () => [
    { id: 'n1', checkId: 'naming.dissimilar-names', status: 'open', severity: 'high', issueNumber: 1, problem: 'Confusable names' },
    { id: 'p1', checkId: 'pacing.scene-drag', status: 'open', severity: 'low', issueNumber: 2, problem: 'Sagging middle' },
    { id: 'p2', checkId: 'pacing.scene-drag', status: 'dismissed', severity: 'low', issueNumber: 2, problem: 'Resolved drag' },
  ];
  const renderTwoCheck = (initialEntries = ['/']) => render(
    <MemoryRouter initialEntries={initialEntries}>
      <EditorialFindingsTriage seriesId="ser-1" checksById={twoCheckChecks} comments={twoCheckComments()} />
    </MemoryRouter>,
  );

  it('filters findings by severity via a toolbar chip (#1600)', () => {
    renderTwoCheck();
    // Both findings visible up front.
    expect(screen.getByText('Confusable names')).toBeTruthy();
    expect(screen.getByText('Sagging middle')).toBeTruthy();
    // Toggle the High severity chip — only the high-severity finding remains.
    fireEvent.click(screen.getByRole('button', { name: 'High', pressed: false }));
    expect(screen.getByText('Confusable names')).toBeTruthy();
    expect(screen.queryByText('Sagging middle')).toBeNull();
  });

  it('filters findings by the free-text search box (#1600)', () => {
    renderTwoCheck();
    fireEvent.change(screen.getByLabelText('Search findings'), { target: { value: 'sagging' } });
    expect(screen.getByText('Sagging middle')).toBeTruthy();
    expect(screen.queryByText('Confusable names')).toBeNull();
  });

  it('filters by check via the Check select (#1600)', () => {
    renderTwoCheck();
    fireEvent.change(screen.getByLabelText('Check'), { target: { value: 'naming.dissimilar-names' } });
    expect(screen.getByText('Confusable names')).toBeTruthy();
    expect(screen.queryByText('Sagging middle')).toBeNull();
  });

  // ---- Category filter (#1606) — a comment-level facet distinct from scope. ----
  const categoryComments = () => [
    { id: 'n1', checkId: 'naming.dissimilar-names', category: 'naming', status: 'open', severity: 'high', issueNumber: 1, problem: 'Confusable names' },
    { id: 'p1', checkId: 'pacing.scene-drag', category: 'pacing', status: 'open', severity: 'low', issueNumber: 2, problem: 'Sagging middle' },
  ];
  const renderCategory = (initialEntries = ['/']) => render(
    <MemoryRouter initialEntries={initialEntries}>
      <EditorialFindingsTriage seriesId="ser-1" checksById={twoCheckChecks} comments={categoryComments()} />
    </MemoryRouter>,
  );

  it('filters by finding category via the Category select (#1606)', () => {
    renderCategory();
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'pacing' } });
    expect(screen.getByText('Sagging middle')).toBeTruthy();
    expect(screen.queryByText('Confusable names')).toBeNull();
  });

  it('honors a category filter supplied via the URL query (#1606)', () => {
    renderCategory(['/?fcat=naming']);
    expect(screen.getByText('Confusable names')).toBeTruthy();
    expect(screen.queryByText('Sagging middle')).toBeNull();
  });

  it('honors filters supplied via the URL query so a view is deep-linkable (#1600)', () => {
    renderTwoCheck(['/?fsev=low']);
    expect(screen.getByText('Sagging middle')).toBeTruthy();
    expect(screen.queryByText('Confusable names')).toBeNull();
  });

  it('shows a no-match state with a clear-filters affordance when filters exclude everything (#1600)', () => {
    renderTwoCheck(['/?fq=zzzznomatch']);
    expect(screen.getByText(/No findings match the current filters/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /clear filters/i }));
    // Clearing restores the findings.
    expect(screen.getByText('Confusable names')).toBeTruthy();
    expect(screen.getByText('Sagging middle')).toBeTruthy();
  });

  it('force-expands a group whose only matches are resolved findings (#1600)', () => {
    // ?fstatus=dismissed matches only the dismissed finding, whose group has 0
    // open — without force-expand it would hide behind a collapsed header.
    renderTwoCheck(['/?fstatus=dismissed']);
    expect(screen.getByText('Resolved drag')).toBeTruthy();
    expect(screen.queryByText('Confusable names')).toBeNull();
    expect(screen.queryByText('Sagging middle')).toBeNull();
  });

  it('drops a filter-hidden finding from the bulk selection so it can\'t be acted on unseen (#1600)', () => {
    renderTwoCheck();
    fireEvent.click(screen.getByLabelText('Select finding: Confusable names'));
    fireEvent.click(screen.getByLabelText('Select finding: Sagging middle'));
    expect(screen.getByText('2 selected')).toBeTruthy();
    // Filter so only one selected finding stays visible — the bar must follow.
    fireEvent.change(screen.getByLabelText('Search findings'), { target: { value: 'confusable' } });
    expect(screen.getByText('1 selected')).toBeTruthy();
  });

  // ---- Disable a noisy check in-situ (#1602). The mute state + persist + undo
  // toast were lifted to the parent page (#1697); this view now just renders the
  // affordance, fires `onDisableCheck`, and hides groups named in `hiddenCheckIds`.
  const enabledChecksById = {
    'naming.dissimilar-names': { label: 'Character name dissimilarity', scope: 'series', kind: 'deterministic', enabled: true },
  };
  const renderDisable = (props) => render(
    <MemoryRouter>
      <EditorialFindingsTriage seriesId="ser-1" checksById={enabledChecksById} {...props} />
    </MemoryRouter>,
  );

  it('offers a Disable action only when onDisableCheck is wired and the check is enabled (#1602)', () => {
    const comments = [{ id: 'c1', checkId: 'naming.dissimilar-names', status: 'open', severity: 'high', problem: 'Noisy' }];
    // No handler → no disable affordance (read-only triage).
    renderTriage({ comments });
    expect(screen.queryByRole('button', { name: /Disable check:/i })).toBeNull();
  });

  it('does NOT offer Disable for an already-disabled check (#1602)', () => {
    const comments = [{ id: 'c1', checkId: 'naming.dissimilar-names', status: 'open', severity: 'high', problem: 'Noisy' }];
    renderDisable({
      comments,
      checksById: { 'naming.dissimilar-names': { label: 'Character name dissimilarity', scope: 'series', enabled: false } },
      onDisableCheck: vi.fn(),
    });
    expect(screen.queryByRole('button', { name: /Disable check:/i })).toBeNull();
  });

  it('fires onDisableCheck with the checkId + label when the Disable button is clicked (#1697)', () => {
    const onDisableCheck = vi.fn();
    const comments = [{ id: 'c1', checkId: 'naming.dissimilar-names', status: 'open', severity: 'high', problem: 'Noisy finding' }];
    renderDisable({ comments, onDisableCheck });

    fireEvent.click(screen.getByRole('button', { name: /Disable check: Character name dissimilarity/i }));
    expect(onDisableCheck).toHaveBeenCalledWith('naming.dissimilar-names', 'Character name dissimilarity');
  });

  it('hides a check group whose id is in hiddenCheckIds and shows the catalog hint (#1697)', () => {
    const onDisableCheck = vi.fn();
    const comments = [{ id: 'c1', checkId: 'naming.dissimilar-names', status: 'open', severity: 'high', problem: 'Noisy finding' }];
    // Parent-owned mute set: the group is hidden purely off this prop now.
    renderDisable({ comments, onDisableCheck, hiddenCheckIds: new Set(['naming.dissimilar-names']) });

    expect(screen.queryByText('Noisy finding')).toBeNull();
    expect(screen.getByText(/Every check with findings is disabled/i)).toBeTruthy();
  });
});

describe('EditorialFindingsTriage — per-finding undo of an accepted fix (#1609)', () => {
  beforeEach(() => {
    acceptPipelineManuscriptFix.mockReset();
    patchPipelineManuscriptComment.mockReset();
    undoPipelineManuscriptFix.mockReset();
    toast.dismiss();
  });

  it('offers Undo on an accepted finding with a snapshot and re-opens it on click', async () => {
    const onCommentChange = vi.fn();
    const comments = [
      // An open sibling keeps the group expanded so the accepted row renders.
      { id: 'open-1', checkId: 'naming.dissimilar-names', status: 'open', severity: 'low', problem: 'Still open' },
      {
        id: 'acc-1', checkId: 'naming.dissimilar-names', status: 'accepted', severity: 'high',
        problem: 'Accepted finding', acceptedSnapshot: { acceptedAt: 't', sections: [{ issueId: 'i1', stageId: 'prose', priorText: 'before' }] },
      },
    ];
    undoPipelineManuscriptFix.mockResolvedValue({ comment: { ...comments[1], status: 'open', acceptedSnapshot: null }, sections: [] });
    renderTriage({ comments, onCommentChange });

    const undoBtn = screen.getByRole('button', { name: /Undo fix/i });
    fireEvent.click(undoBtn);
    await waitFor(() => expect(undoPipelineManuscriptFix).toHaveBeenCalledWith('ser-1', 'acc-1', { silent: true }));
    await waitFor(() => expect(onCommentChange).toHaveBeenCalledWith(expect.objectContaining({ id: 'acc-1', status: 'open' })));
  });

  it('does NOT offer Undo on an accepted finding without a snapshot (older/synced record)', () => {
    const comments = [
      { id: 'open-1', checkId: 'naming.dissimilar-names', status: 'open', severity: 'low', problem: 'Still open' },
      { id: 'acc-2', checkId: 'naming.dissimilar-names', status: 'accepted', severity: 'high', problem: 'No snapshot' },
    ];
    renderTriage({ comments });
    expect(screen.queryByRole('button', { name: /Undo fix/i })).toBeNull();
  });
});
