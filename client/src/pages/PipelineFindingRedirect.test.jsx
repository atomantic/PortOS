import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useParams, useSearchParams } from 'react-router-dom';
import PipelineFindingRedirect from './PipelineFindingRedirect';
import { locatePipelineFinding } from '../services/api';

vi.mock('../services/api', () => ({
  locatePipelineFinding: vi.fn(),
}));

// Destination stand-in that echoes where the resolver landed (#1608) so we can
// assert it redirected to the right series + comment without the real editor.
function EditorLanding() {
  const { seriesId } = useParams();
  const [params] = useSearchParams();
  return <div>editor series={seriesId} comment={params.get('comment')}</div>;
}

const renderAt = (commentId) => render(
  <MemoryRouter initialEntries={[`/pipeline/findings/${commentId}`]}>
    <Routes>
      <Route path="/pipeline/findings/:commentId" element={<PipelineFindingRedirect />} />
      <Route path="/pipeline/series/:seriesId/manuscript/*" element={<EditorLanding />} />
      <Route path="/pipeline/editorial-checks" element={<div>editorial checks page</div>} />
    </Routes>
  </MemoryRouter>,
);

describe('PipelineFindingRedirect', () => {
  beforeEach(() => locatePipelineFinding.mockReset());

  it('shows a resolving state while the lookup is in flight', async () => {
    let resolve;
    locatePipelineFinding.mockReturnValue(new Promise((r) => { resolve = r; }));
    renderAt('c-1');
    expect(screen.getByText(/resolving finding/i)).toBeInTheDocument();
    // Settle so the pending effect promise doesn't dangle into the next test.
    await act(async () => { resolve(null); });
  });

  it('redirects to the manuscript editor with the resolved series + comment focused', async () => {
    locatePipelineFinding.mockResolvedValue({ seriesId: 'ser-9', comment: { id: 'c-1', issueNumber: 4 } });
    renderAt('c-1');
    await waitFor(() => expect(screen.getByText(/editor series=ser-9/)).toBeInTheDocument());
    expect(screen.getByText(/comment=c-1/)).toBeInTheDocument();
    expect(locatePipelineFinding).toHaveBeenCalledWith('c-1');
  });

  it('shows a not-found state with a path back to Editorial Checks when no series owns the id', async () => {
    locatePipelineFinding.mockResolvedValue(null);
    renderAt('gone');
    await waitFor(() => expect(screen.getByText(/finding not found/i)).toBeInTheDocument());
    const link = screen.getByRole('link', { name: /editorial checks/i });
    expect(link).toHaveAttribute('href', '/pipeline/editorial-checks');
  });
});
