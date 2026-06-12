import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../../services/api', () => ({
  acceptPipelineManuscriptFix: vi.fn(),
  generatePipelineManuscriptFix: vi.fn(),
  patchPipelineManuscriptComment: vi.fn(),
}));
vi.mock('../../ui/Toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

import ManuscriptImpactPreview from './ManuscriptImpactPreview';
import { acceptPipelineManuscriptFix } from '../../../services/api';
import toast from '../../ui/Toast';

const SECTIONS = [
  { issueId: 'i1', stageId: 'prose', number: 1, title: 'One', content: 'hello brave world' },
  { issueId: 'i2', stageId: 'prose', number: 2, title: 'Two', content: 'another fine day' },
];
const COMMENTS = [
  { id: 'c1', status: 'open', issueNumber: 1, issueId: 'i1', stageId: 'prose', anchorQuote: 'brave', fix: { find: 'brave', replace: 'bold' } },
  { id: 'c2', status: 'open', issueNumber: 2, issueId: 'i2', stageId: 'prose', anchorQuote: 'fine', fix: { find: 'fine', replace: 'grand' } },
];

const renderPreview = (overrides = {}) => {
  const props = {
    open: true,
    seriesId: 'ser-1',
    sections: SECTIONS,
    comments: COMMENTS,
    fixDrafts: {},
    onAccepted: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<ManuscriptImpactPreview {...props} />);
  return props;
};

describe('ManuscriptImpactPreview accept-all', () => {
  beforeEach(() => vi.clearAllMocks());

  it('applies every previewed note (one accept per comment) and closes on full success', async () => {
    acceptPipelineManuscriptFix.mockResolvedValue({ comment: { id: 'cx', status: 'accepted' }, sections: [] });
    const { onAccepted, onClose } = renderPreview();
    fireEvent.click(screen.getByText('Accept all 2 edits'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(acceptPipelineManuscriptFix).toHaveBeenCalledTimes(2);
    expect(acceptPipelineManuscriptFix).toHaveBeenCalledWith(
      'ser-1', 'c1',
      { edits: [expect.objectContaining({ find: 'brave', replace: 'bold' })] },
      { silent: true },
    );
    expect(onAccepted).toHaveBeenCalledTimes(2);
    expect(toast.success).toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('reports a partial failure, applies the rest, and keeps the modal open', async () => {
    acceptPipelineManuscriptFix
      .mockResolvedValueOnce({ comment: { id: 'c1', status: 'accepted' }, sections: [] })
      .mockRejectedValueOnce(new Error('anchor not found'));
    const { onAccepted, onClose } = renderPreview();
    fireEvent.click(screen.getByText('Accept all 2 edits'));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(toast.error.mock.calls[0][0]).toMatch(/anchor not found/);
  });

  it('honors the draft selection — unchecked edits are not sent', async () => {
    acceptPipelineManuscriptFix.mockResolvedValue({ comment: {}, sections: [] });
    // c1's only edit is unchecked; c2 stays fully selected.
    const fixDrafts = {
      c1: { fixKey: '0:i1:prose:brave:bold', drafts: { 0: 'bold' }, selected: { 0: false } },
    };
    renderPreview({ fixDrafts });
    fireEvent.click(screen.getByText('Accept all 1 edit'));
    await waitFor(() => expect(acceptPipelineManuscriptFix).toHaveBeenCalledTimes(1));
    expect(acceptPipelineManuscriptFix.mock.calls[0][1]).toBe('c2');
  });

  it('shows no accept button when there is nothing to preview', () => {
    renderPreview({ comments: [] });
    expect(screen.queryByText(/Accept all/)).not.toBeInTheDocument();
  });

  it('does not accept edits for sections that were not previewed (count must not lie)', async () => {
    acceptPipelineManuscriptFix.mockResolvedValue({ comment: {}, sections: [] });
    // c3 targets a stage with no matching `sections` entry → it is NOT rendered
    // in the preview. accept-all must skip it (only c1 + c2 are previewed),
    // otherwise it would apply an unseen edit and the "2 edits" count would lie.
    const unseen = { id: 'c3', status: 'open', issueNumber: 3, issueId: 'i3', stageId: 'comic', anchorQuote: 'x', fix: { find: 'x', replace: 'y' } };
    renderPreview({ comments: [...COMMENTS, unseen] });

    // The button still advertises only the 2 previewed edits.
    fireEvent.click(screen.getByText('Accept all 2 edits'));
    await waitFor(() => expect(acceptPipelineManuscriptFix).toHaveBeenCalledTimes(2));
    const acceptedIds = acceptPipelineManuscriptFix.mock.calls.map((c) => c[1]);
    expect(acceptedIds).toEqual(['c1', 'c2']);
    expect(acceptedIds).not.toContain('c3');
  });
});
