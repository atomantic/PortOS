import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../../services/api', () => ({
  getPipelinePerspectiveRewrites: vi.fn(),
  createPipelinePerspectiveRewrite: vi.fn(),
  deletePipelinePerspectiveRewrite: vi.fn(),
}));

vi.mock('../../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import PovRewritePanel from './PovRewritePanel';
import {
  getPipelinePerspectiveRewrites,
  createPipelinePerspectiveRewrite,
  deletePipelinePerspectiveRewrite,
} from '../../../services/api';

const ISSUE = {
  id: 'iss-1',
  number: 3,
  title: 'T',
  stages: { prose: { output: 'Original prose passage.', status: 'ready' } },
};

const REWRITE = {
  id: 'pov-1',
  sourceStage: 'prose',
  povCharacterName: 'Ada',
  povCharacterRole: 'protagonist',
  rewrite: 'Ada-lensed retelling.',
  stale: false,
  createdAt: new Date().toISOString(),
  analysis: {
    newInformation: ['Ada fears failure'],
    hiddenInformation: ['the rival was bluffing'],
    arcStrength: { score: 80, strongerThanOriginal: true, rationale: 'her stakes are clearer' },
    foldBackSuggestions: [{ suggestion: 'plant the locket earlier', rationale: 'pays off the reveal' }],
    povJustification: 'switch this scene to Ada',
    oneLine: 'sharper through Ada',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PovRewritePanel', () => {
  it('loads cast + rewrites and generates a new POV rewrite', async () => {
    const cast = [{ id: 'char-ada', name: 'Ada', role: 'protagonist' }, { id: 'char-bly', name: 'Bly', role: 'rival' }];
    // Initial load: empty. After generate, the panel refetches (server-
    // authoritative, capped) — return the new rewrite on subsequent calls.
    getPipelinePerspectiveRewrites
      .mockResolvedValueOnce({ cast, rewrites: [], hasContent: true })
      .mockResolvedValue({ cast, rewrites: [REWRITE], hasContent: true });
    createPipelinePerspectiveRewrite.mockResolvedValue({ status: 'complete', rewrite: REWRITE });

    render(<PovRewritePanel issue={ISSUE} series={{}} />);

    await waitFor(() => expect(screen.getByRole('button', { name: /Rewrite in another POV/i })).toBeInTheDocument());
    expect(screen.getByText(/No alternate-POV rewrites yet/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Rewrite in another POV/i }));

    await waitFor(() => expect(createPipelinePerspectiveRewrite).toHaveBeenCalledWith(
      'iss-1',
      expect.objectContaining({ povCharacterId: 'char-ada' }),
    ));
    // newly generated rewrite appears via the post-generate refetch
    await waitFor(() => expect(screen.getByText('Ada')).toBeInTheDocument());
  });

  it('shows side-by-side passages + analysis when a rewrite card is expanded', async () => {
    getPipelinePerspectiveRewrites.mockResolvedValue({
      cast: [{ id: 'char-ada', name: 'Ada', role: 'protagonist' }],
      rewrites: [REWRITE],
      hasContent: true,
    });

    render(<PovRewritePanel issue={ISSUE} series={{}} />);

    await waitFor(() => expect(screen.getByText('Ada')).toBeInTheDocument());
    // collapsed: analysis not yet shown
    expect(screen.queryByText(/What we learn/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByText('Ada'));

    expect(screen.getByText('Original prose passage.')).toBeInTheDocument();
    expect(screen.getByText('Ada-lensed retelling.')).toBeInTheDocument();
    expect(screen.getByText(/What we learn/i)).toBeInTheDocument();
    expect(screen.getByText('Ada fears failure')).toBeInTheDocument();
    expect(screen.getByText('the rival was bluffing')).toBeInTheDocument();
    expect(screen.getByText(/Arc strength: 80\/100/)).toBeInTheDocument();
    expect(screen.getByText(/plant the locket earlier/)).toBeInTheDocument();
  });

  it('disables generation when the issue has no drafted content', async () => {
    getPipelinePerspectiveRewrites.mockResolvedValue({ cast: [], rewrites: [], hasContent: false });

    render(<PovRewritePanel issue={ISSUE} series={{}} />);

    await waitFor(() => expect(screen.getByRole('button', { name: /Rewrite in another POV/i })).toBeDisabled());
    expect(screen.getByText(/Draft prose/i)).toBeInTheDocument();
  });

  it('refetches when the source draft changes on the same issue', async () => {
    getPipelinePerspectiveRewrites.mockResolvedValue({ cast: [], rewrites: [], hasContent: false });

    const { rerender } = render(<PovRewritePanel issue={ISSUE} series={{}} />);
    await waitFor(() => expect(getPipelinePerspectiveRewrites).toHaveBeenCalledTimes(1));

    // Edit the prose output on the same issue → panel should refetch (so
    // hasContent / stale flags track the live draft, not just navigation).
    const edited = { ...ISSUE, stages: { prose: { output: 'Now there is drafted prose.' } } };
    await act(async () => { rerender(<PovRewritePanel issue={edited} series={{}} />); });

    await waitFor(() => expect(getPipelinePerspectiveRewrites).toHaveBeenCalledTimes(2));
  });

  it('deletes a stored rewrite', async () => {
    getPipelinePerspectiveRewrites.mockResolvedValue({
      cast: [{ id: 'char-ada', name: 'Ada', role: 'protagonist' }],
      rewrites: [REWRITE],
      hasContent: true,
    });
    deletePipelinePerspectiveRewrite.mockResolvedValue({ removed: true });

    render(<PovRewritePanel issue={ISSUE} series={{}} />);

    await waitFor(() => expect(screen.getByText('Ada')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /Delete rewrite/i }));

    await waitFor(() => expect(deletePipelinePerspectiveRewrite).toHaveBeenCalledWith('iss-1', 'pov-1'));
    await waitFor(() => expect(screen.queryByText('Ada')).not.toBeInTheDocument());
  });
});
