import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

vi.mock('../services/api', () => ({
  listLooms: vi.fn(),
  createLoom: vi.fn(),
  deleteLoom: vi.fn(),
  listUniverses: vi.fn(),
  listPipelineSeries: vi.fn(),
}));

const navigate = vi.fn();
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useNavigate: () => navigate };
});

import * as api from '../services/api';
import FableLoom from './FableLoom';

// The list endpoint returns summaries, not the episode graphs.
const looms = [
  {
    id: 'loom-1',
    name: 'The Hollow Crown',
    logline: 'A crown that remembers.',
    universeId: 'uni-1',
    seriesId: null,
    updatedAt: '2026-08-20T00:00:00Z',
    episodeCount: 1,
    sceneCount: 3,
    endingCount: 2,
  },
];

const renderPage = () => render(<MemoryRouter><FableLoom /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  api.listLooms.mockResolvedValue(looms);
  api.listUniverses.mockResolvedValue([{ id: 'uni-1', name: 'Aria Verse' }]);
  api.listPipelineSeries.mockResolvedValue([]);
});

describe('FableLoom index', () => {
  it('lists looms with episode/scene/ending stats and the universe chip', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('The Hollow Crown')).toBeInTheDocument());
    expect(screen.getByText('1 episode')).toBeInTheDocument();
    expect(screen.getByText('3 scenes')).toBeInTheDocument();
    expect(screen.getByText('2 endings')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Aria Verse')).toBeInTheDocument());
  });

  it('shows the empty state when there are no looms', async () => {
    api.listLooms.mockResolvedValue([]);
    renderPage();
    await waitFor(() => expect(screen.getByText(/No branching narratives yet/)).toBeInTheDocument());
  });

  it('creates a loom and navigates to its editor', async () => {
    api.createLoom.mockResolvedValue({ id: 'loom-9' });
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('The Hollow Crown')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /New loom/ }));
    await user.type(screen.getByLabelText('Name'), 'Gate of Ash');
    await user.click(screen.getByRole('button', { name: 'Create loom' }));

    await waitFor(() => expect(api.createLoom).toHaveBeenCalledWith({
      name: 'Gate of Ash', logline: '', premise: '', styleNotes: '', format: 'prose', universeId: null, seriesId: null,
    }, { silent: true }));
    expect(navigate).toHaveBeenCalledWith('/fableloom/loom-9');
  });

  it('deletes a loom after inline confirmation', async () => {
    api.deleteLoom.mockResolvedValue({});
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('The Hollow Crown')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Delete The Hollow Crown' }));
    await user.click(screen.getByRole('button', { name: /^Delete$/ }));

    await waitFor(() => expect(api.deleteLoom).toHaveBeenCalledWith('loom-1'));
    await waitFor(() => expect(screen.queryByText('The Hollow Crown')).not.toBeInTheDocument());
  });
});
