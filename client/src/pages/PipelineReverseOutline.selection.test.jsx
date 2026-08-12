import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import PipelineReverseOutline from './PipelineReverseOutline';

const getPipelineSeries = vi.fn();
const getReverseOutline = vi.fn();
const getReverseOutlineStatus = vi.fn();

vi.mock('../services/api', () => ({
  getPipelineSeries: (...a) => getPipelineSeries(...a),
  getReverseOutline: (...a) => getReverseOutline(...a),
  generateReverseOutline: vi.fn(),
  cancelReverseOutline: vi.fn(),
  getReverseOutlineStatus: (...a) => getReverseOutlineStatus(...a),
  pipelineReverseOutlineSseUrl: () => '/sse',
}));

vi.mock('../hooks/usePipelineProgress', () => ({ usePipelineProgress: () => ({ latest: null }) }));
vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

const OUTLINE = {
  status: 'complete',
  plotlines: [{ id: 'pl-1', label: 'Main thread', kind: 'main', color: '#ff0000' }],
  scenes: [
    { id: 'sc-1', plotlineId: 'pl-1', heading: 'Opening scene', summary: 'The first beat.', issueNumber: 1 },
    { id: 'sc-2', plotlineId: 'pl-1', heading: 'Second scene', summary: 'The second beat.', issueNumber: 2 },
  ],
};

function LocationProbe() {
  const { search } = useLocation();
  return <span data-testid="search">{search}</span>;
}

function renderAt(entry = '/pipeline/series/ser-1/reverse-outline') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="/pipeline/series/:seriesId/reverse-outline"
          element={<><PipelineReverseOutline /><LocationProbe /></>}
        />
        <Route path="/pipeline" element={<div>Pipeline index</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  getPipelineSeries.mockReset().mockResolvedValue({ id: 'ser-1', name: 'Example Series' });
  getReverseOutline.mockReset().mockResolvedValue(OUTLINE);
  getReverseOutlineStatus.mockReset().mockResolvedValue({ active: false });
});

describe('PipelineReverseOutline scene selection', () => {
  it('opens the detail panel from a ?scene= deep link', async () => {
    renderAt('/pipeline/series/ser-1/reverse-outline?scene=sc-2');
    expect(await screen.findByText('Second scene')).toBeInTheDocument();
    expect(screen.getByText('The second beat.')).toBeInTheDocument();
  });

  it('writes the clicked scene into the URL instead of local state', async () => {
    const user = userEvent.setup();
    renderAt();
    await screen.findAllByText('Main thread');
    expect(screen.getByText(/Click a scene marker/)).toBeInTheDocument();

    await user.click(screen.getByTitle('Opening scene'));

    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent('scene=sc-1'));
    expect(screen.getByText('The first beat.')).toBeInTheDocument();
  });

  it('falls back to the placeholder when ?scene= names a scene that no longer exists', async () => {
    renderAt('/pipeline/series/ser-1/reverse-outline?scene=sc-gone');
    expect(await screen.findByText(/Click a scene marker/)).toBeInTheDocument();
  });
});
