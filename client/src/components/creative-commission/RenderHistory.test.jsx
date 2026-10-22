import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import RenderHistory from './RenderHistory.jsx';

vi.mock('../creative-director/ProjectPreview.jsx', () => ({ default: () => <div>project preview</div> }));

const recipe = {
  version: 1,
  source: 'digital-twin',
  window: 'month',
  explorationPercent: 35,
  sourceVersion: 'music-taste-v1:example',
  sourceHash: 'example-hash',
  anchors: [{ kind: 'artist', name: 'Example Artist' }],
};

describe('RenderHistory taste-aware runs', () => {
  it('shows bounded recipe/render provenance and submits structured steering tags', async () => {
    const onRate = vi.fn(async () => {});
    render(
      <MemoryRouter>
        <RenderHistory
          runs={[{
            id: 'run-example', ranAt: new Date().toISOString(), status: 'started', projectId: 'cd-example',
            tasteRecipe: recipe,
          }]}
          feedback={[]}
          projectsById={new Map([['cd-example', { id: 'cd-example', musicBed: { engine: 'musicgen', modelId: 'example-model' } }]])}
          projectsLoading={false}
          onRate={onRate}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('Example Artist')).toBeInTheDocument();
    expect(screen.getByText(/35% exploration/)).toBeInTheDocument();
    expect(screen.getByText(/rendered with musicgen · example-model/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More familiar' }));
    fireEvent.click(screen.getByRole('button', { name: 'More experimental' }));
    expect(screen.getByRole('button', { name: 'More familiar' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Like this result' }));
    await waitFor(() => expect(onRate).toHaveBeenCalledWith('run-example', 'up', '', ['more-experimental']));
  });
});

describe('RenderHistory render state', () => {
  const now = new Date().toISOString();
  const runs = [
    { id: 'run-removed', ranAt: now, status: 'started', projectId: 'cd-gone' },
    { id: 'run-failed', ranAt: now, status: 'failed', error: 'boom', projectId: null },
    { id: 'run-done', ranAt: now, status: 'started', projectId: 'cd-done' },
    { id: 'run-bad', ranAt: now, status: 'started', projectId: 'cd-bad' },
  ];
  const projectsById = new Map([['cd-done', { id: 'cd-done', status: 'complete' }], ['cd-bad', { id: 'cd-bad', status: 'failed' }]]);
  const mount = (props) => render(
    <MemoryRouter>
      <RenderHistory runs={runs} feedback={[]} projectsById={projectsById} projectsLoading={false} onRate={vi.fn()} {...props} />
    </MemoryRouter>,
  );

  it('shows the project state, never a bare "started", and groups removed renders', () => {
    mount();
    expect(screen.getByText('Complete')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText(/boom/)).toBeInTheDocument();
    expect(screen.queryByText(/^started$/)).toBeNull();
    // Only the two live project cards link out; the removed one does not.
    expect(screen.getAllByRole('link', { name: /view output/i })).toHaveLength(2);
    const summary = screen.getByText('1 older render is no longer available');
    expect(summary.closest('details').open).toBe(false);
    fireEvent.click(summary);
    expect(screen.getAllByText('Render removed').length).toBeGreaterThan(0);
    // The removed-render run is still rateable.
    expect(screen.getAllByRole('button', { name: 'Like this result' })).toHaveLength(3);
  });

  it('shows Loading… and no removed grouping while projects load', () => {
    mount({ projectsLoading: true, projectsById: new Map() });
    expect(screen.getAllByText('Loading…').length).toBeGreaterThan(0);
    expect(screen.queryByText('Render removed')).toBeNull();
    expect(screen.queryByText(/no longer available/)).toBeNull();
  });
});
