import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { validateLoomEpisode, reviewLoomEpisodeContinuity, reviewLoomEpisode } from '../../services/apiFableLoom.js';
import LoomValidationPanel from './LoomValidationPanel';

vi.mock('../../services/apiFableLoom.js');
vi.mock('./LoomWorkflowPanel', () => ({
  default: () => <div>Ordered production workflow</div>,
}));
vi.mock('./LoomContinuityPanel', () => ({
  default: ({ loadError, onRetryLoad }) => (
    <div>
      Dedicated continuity workspace
      {loadError && <button type="button" onClick={onRetryLoad}>Retry continuity</button>}
    </div>
  ),
}));
vi.mock('./LoomProductionPanel', () => ({
  default: ({ onLoomUpdate }) => (
    <button type="button" onClick={() => onLoomUpdate?.({ id: 'loom-updated' })}>
      Dedicated render workspace
    </button>
  ),
}));

const episode = {
  id: 'episode-1', startNodeId: 'scene-1',
  nodes: [{ id: 'scene-1', isEnding: true, transitions: [] }],
};

beforeEach(() => {
  vi.clearAllMocks();
  validateLoomEpisode.mockResolvedValue({
    stats: {
      errorCount: 0, automaticCutCount: 0, decisionCount: 0,
      reachableEndingCount: 1, endingCount: 1, maxDepth: 1,
    },
    issues: [],
  });
  reviewLoomEpisodeContinuity.mockResolvedValue({ passed: true, findings: [], summary: {} });
});

describe('LoomValidationPanel', () => {
  it('opens on the ordered workflow and separates story, continuity, and render work', async () => {
    const user = userEvent.setup();
    const onLoomUpdate = vi.fn();
    render(
      <MemoryRouter>
        <LoomValidationPanel
          loom={{ id: 'loom-1', episodes: [episode] }}
          episode={episode}
          onSelectNode={vi.fn()}
          onLoomUpdate={onLoomUpdate}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('Ordered production workflow')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Story' }));
    await waitFor(() => expect(screen.getByText(/Graph is sound/i)).toBeInTheDocument());
    await user.click(screen.getByRole('tab', { name: 'Continuity' }));
    expect(screen.getByText('Dedicated continuity workspace')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Render' }));
    expect(screen.getByText('Dedicated render workspace')).toBeInTheDocument();
    await user.click(screen.getByText('Dedicated render workspace'));
    expect(onLoomUpdate).toHaveBeenCalledWith({ id: 'loom-updated' });
  });

  it('restores the selected production workspace from the URL', async () => {
    render(
      <MemoryRouter initialEntries={['/?production=render']}>
        <LoomValidationPanel
          loom={{ id: 'loom-1', episodes: [episode] }}
          episode={episode}
          onSelectNode={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('Dedicated render workspace')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Render' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => {
      expect(validateLoomEpisode).toHaveBeenCalled();
      expect(reviewLoomEpisodeContinuity).toHaveBeenCalled();
    });
  });

  const readiness = { ready: false, totalErrors: 2, findings: [] };
  const renderPanel = (loom, ep = episode, initial = '/?production=story') => render(
    <MemoryRouter initialEntries={[initial]}>
      <LoomValidationPanel loom={loom} episode={ep} onSelectNode={vi.fn()} />
    </MemoryRouter>,
  );

  it('keeps productionReadiness when the AI review result omits it', async () => {
    const user = userEvent.setup();
    validateLoomEpisode.mockResolvedValue({
      stats: { automaticCutCount: 0, decisionCount: 0, reachableEndingCount: 1, endingCount: 1, maxDepth: 1 },
      issues: [],
      productionReadiness: readiness,
    });
    reviewLoomEpisode.mockResolvedValue({
      review: { summary: 'ok', findings: [] },
      structural: { stats: { automaticCutCount: 0, decisionCount: 0, reachableEndingCount: 1, endingCount: 1, maxDepth: 1 }, issues: [] },
    });
    renderPanel({ id: 'loom-1', episodes: [episode] });
    await screen.findByText('2 blocking error(s)');
    await user.click(screen.getByRole('button', { name: /Review episode teleplay/ }));
    await screen.findByText('No narrative issues found.');
    expect(screen.getByText('2 blocking error(s)')).toBeInTheDocument();
  });

  it('ignores an AI review response that lands after the loom changed', async () => {
    const user = userEvent.setup();
    let resolveReview;
    reviewLoomEpisode.mockReturnValue(new Promise((resolve) => { resolveReview = resolve; }));
    const view = renderPanel({ id: 'loom-1', episodes: [episode] });
    await screen.findByText(/Graph is sound/i);
    await user.click(screen.getByRole('button', { name: /Review episode teleplay/ }));
    view.rerender(
      <MemoryRouter initialEntries={['/?production=story']}>
        <LoomValidationPanel loom={{ id: 'loom-2', episodes: [episode] }} episode={episode} onSelectNode={vi.fn()} />
      </MemoryRouter>,
    );
    resolveReview({ review: { summary: 'stale', findings: [] }, structural: { issues: [] } });
    await waitFor(() => expect(reviewLoomEpisode).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByText('No narrative issues found.')).not.toBeInTheDocument();
  });

  it('shows a retryable error instead of Validating… when validation fails', async () => {
    const user = userEvent.setup();
    validateLoomEpisode.mockRejectedValueOnce(new Error('boom'));
    renderPanel({ id: 'loom-1', episodes: [episode] });
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    expect(screen.queryByText('Validating…')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText(/Graph is sound/i);
  });

  it('surfaces continuity load failures with a retry', async () => {
    const user = userEvent.setup();
    reviewLoomEpisodeContinuity.mockRejectedValueOnce(new Error('nope'));
    renderPanel({ id: 'loom-1', episodes: [episode] }, episode, '/?production=continuity');
    await user.click(await screen.findByRole('button', { name: 'Retry continuity' }));
    await waitFor(() => expect(reviewLoomEpisodeContinuity).toHaveBeenCalledTimes(2));
  });

  it('does not re-validate when only episode content (not structure) changes', async () => {
    const loom = { id: 'loom-1', episodes: [episode] };
    const view = renderPanel(loom);
    await screen.findByText(/Graph is sound/i);
    expect(validateLoomEpisode).toHaveBeenCalledTimes(1);
    const edited = { ...episode, nodes: [{ ...episode.nodes[0], prose: 'edited' }] };
    view.rerender(
      <MemoryRouter initialEntries={['/?production=story']}>
        <LoomValidationPanel loom={{ id: 'loom-1', episodes: [edited] }} episode={edited} onSelectNode={vi.fn()} />
      </MemoryRouter>,
    );
    await Promise.resolve();
    expect(validateLoomEpisode).toHaveBeenCalledTimes(1);
  });
});
