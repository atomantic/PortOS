import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

vi.mock('../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn(), emit: vi.fn() } }));
vi.mock('../../hooks/useSocketSubscription', () => ({ useSocketSubscription: vi.fn() }));
vi.mock('../../services/api', () => ({
  listCodeAnimationJobPage: vi.fn(),
  deleteCodeAnimationJob: vi.fn(),
  requestCodeAnimationPoster: vi.fn(),
  codeAnimationPosterUrl: (id) => `/posters/${id}.jpg`,
}));
import { deleteCodeAnimationJob, listCodeAnimationJobPage } from '../../services/api';
import CodeAnimationGallery from './CodeAnimationGallery';

const item = (id, title, status = 'completed') => ({ id, title, status, posterVersion: 1, createdAt: '2026-01-01T00:00:00.000Z' });

beforeEach(() => {
  vi.clearAllMocks();
  listCodeAnimationJobPage.mockResolvedValue({
    items: [item('a', 'Station boot'), item('b', 'Still generating', 'running')],
    nextCursor: null, counts: { running: 1, completed: 1 },
  });
  deleteCodeAnimationJob.mockResolvedValue({ id: 'a', deleted: true });
});

describe('CodeAnimationGallery', () => {
  it('deletes an animation only after the inline confirm, and never offers it while generating', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><CodeAnimationGallery /></MemoryRouter>);
    await screen.findByText('Station boot');
    expect(screen.queryByRole('button', { name: 'Delete Still generating' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Delete Station boot' }));
    expect(deleteCodeAnimationJob).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Station boot')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Delete Station boot' }));
    expect(screen.getByText('Delete “Station boot”? Its files go to the Trash.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(deleteCodeAnimationJob).toHaveBeenCalledWith('a', { silent: true });
    await waitFor(() => expect(screen.queryByText('Station boot')).toBeNull());
    expect(screen.getByText('Still generating')).toBeTruthy();
  });

  it('keeps the animation when the delete is refused', async () => {
    const user = userEvent.setup();
    deleteCodeAnimationJob.mockRejectedValue(new Error('Could not move the animation files to the Trash'));
    render(<MemoryRouter><CodeAnimationGallery /></MemoryRouter>);
    await user.click(await screen.findByRole('button', { name: 'Delete Station boot' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete Station boot' }).disabled).toBe(false));
    expect(screen.getByText('Station boot')).toBeTruthy();
  });
});
