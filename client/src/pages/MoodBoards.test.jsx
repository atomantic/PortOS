import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

vi.mock('../services/api', () => ({
  listMoodBoards: vi.fn(),
  createMoodBoard: vi.fn(),
  deleteMoodBoard: vi.fn(),
}));

import MoodBoards from './MoodBoards';
import { listMoodBoards, createMoodBoard, deleteMoodBoard } from '../services/api';

const renderPage = async () => {
  const result = render(<MemoryRouter><MoodBoards /></MemoryRouter>);
  await act(async () => {});
  return result;
};

describe('MoodBoards index', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createMoodBoard.mockResolvedValue({ id: 'board-1' });
    deleteMoodBoard.mockResolvedValue({ success: true });
  });

  it('offers a call to action with an accessible name when no boards exist', async () => {
    listMoodBoards.mockResolvedValue([]);
    await renderPage();
    expect(await screen.findByText('No mood boards yet')).toBeInTheDocument();
    // Scope to the empty state's own button — the header "New Board" control is
    // a separate element with its own name, so a conversion that drops
    // actionLabel would leave a dead-end empty state this assertion catches.
    const cta = await screen.findByRole('button', { name: 'Create your first board' });
    await userEvent.click(cta);
    await waitFor(() => expect(createMoodBoard).toHaveBeenCalled());
  });

  it('renders the board cards with cover and item thumbnails once boards exist', async () => {
    listMoodBoards.mockResolvedValue([
      {
        id: 'board-1',
        name: 'Retro Sci-Fi',
        description: 'Neon aesthetics and space vibes',
        items: [
          { id: 'it-1', type: 'image', imageUrl: '/data/images/cover.png', caption: 'Cyber city' },
          { id: 'it-2', type: 'image', imageUrl: '/data/images/thumb1.png', caption: 'Neon sign' },
          { id: 'it-3', type: 'video', mediaKey: 'video:clip.mp4', imageUrl: '/data/video-thumbnails/clip.jpg', caption: 'Hovercar' },
          { id: 'it-4', type: 'text', text: 'Some notes on lighting' },
          { id: 'it-5', type: 'image', imageUrl: '/data/images/thumb3.png', caption: 'Spaceship' },
          { id: 'it-6', type: 'image', imageUrl: '/data/images/thumb4.png', caption: 'Terminal' },
          { id: 'it-7', type: 'image', imageUrl: '/data/images/thumb5.png', caption: 'Astronaut' },
        ],
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    await renderPage();
    expect(await screen.findByText('Retro Sci-Fi')).toBeInTheDocument();
    expect(screen.getByText('Neon aesthetics and space vibes')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create your first board' })).toBeNull();

    // Cover image check
    const cover = screen.getByAltText('Retro Sci-Fi');
    expect(cover).toBeInTheDocument();
    expect(cover.getAttribute('src')).toBe('/data/images/cover.png');

    // Sub-thumbnails check (it-2, it-3, it-5, it-6)
    expect(screen.getByAltText('Neon sign')).toBeInTheDocument();
    expect(screen.getByAltText('Hovercar')).toBeInTheDocument();
    expect(screen.getByAltText('Spaceship')).toBeInTheDocument();
    expect(screen.getByAltText('Terminal')).toBeInTheDocument();

    // Overflow badge check: 6 visual items total, 1 cover + 4 sub-thumbnails = 1 remaining (+1 badge)
    expect(screen.getByText('+1')).toBeInTheDocument();

    // Stats check: 5 images, 1 video, 1 text
    expect(screen.getByText('7 items')).toBeInTheDocument();
  });

  it('allows deleting a board with confirmation', async () => {
    listMoodBoards.mockResolvedValue([
      { id: 'board-1', name: 'Board To Delete', items: [], updatedAt: '2026-01-01T00:00:00.000Z' },
    ]);
    await renderPage();
    expect(await screen.findByText('Board To Delete')).toBeInTheDocument();

    const deleteBtn = screen.getByRole('button', { name: 'Delete Board To Delete' });
    await userEvent.click(deleteBtn);

    // Confirmation row appears
    expect(screen.getByText('Delete "Board To Delete"? This can\'t be undone.')).toBeInTheDocument();
    const confirmBtn = screen.getByRole('button', { name: 'Delete' });
    await userEvent.click(confirmBtn);

    await waitFor(() => expect(deleteMoodBoard).toHaveBeenCalledWith('board-1', { silent: true }));
    expect(screen.queryByText('Board To Delete')).toBeNull();
  });
});
