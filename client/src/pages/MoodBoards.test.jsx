import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

vi.mock('../services/api', () => ({
  listMoodBoards: vi.fn(),
  createMoodBoard: vi.fn(),
  deleteMoodBoard: vi.fn(),
}));

import MoodBoards from './MoodBoards';
import { listMoodBoards, createMoodBoard } from '../services/api';

const renderPage = () => render(<MemoryRouter><MoodBoards /></MemoryRouter>);

describe('MoodBoards index empty state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createMoodBoard.mockResolvedValue({ id: 'board-1' });
  });

  it('offers a call to action with an accessible name when no boards exist', async () => {
    listMoodBoards.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('No mood boards yet')).toBeInTheDocument();
    // Scope to the empty state's own button — the header "New Board" control is
    // a separate element with its own name, so a conversion that drops
    // actionLabel would leave a dead-end empty state this assertion catches.
    const cta = await screen.findByRole('button', { name: 'Create your first board' });
    await userEvent.click(cta);
    await waitFor(() => expect(createMoodBoard).toHaveBeenCalled());
  });

  it('renders the board list instead of the empty state once boards exist', async () => {
    listMoodBoards.mockResolvedValue([
      { id: 'board-1', name: 'Example Board', items: [], updatedAt: '2026-01-01T00:00:00.000Z' },
    ]);
    renderPage();
    expect(await screen.findByText('Example Board')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create your first board' })).toBeNull();
  });
});
