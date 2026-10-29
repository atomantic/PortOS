import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
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
import socket from '../../services/socket';
import { useSocketSubscription } from '../../hooks/useSocketSubscription';
import toast from '../ui/Toast';
import CodeAnimationGallery from './CodeAnimationGallery';

vi.mock('../ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

const changed = (event) => socket.on.mock.calls.find(([name]) => name === 'code-animation:changed')[1](event);

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
    listCodeAnimationJobPage.mockResolvedValue({ items: [item('b', 'Still generating', 'running')], nextCursor: null, counts: { running: 1, completed: 0 } });
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
    expect(toast.error).toHaveBeenCalledWith('Could not move the animation files to the Trash');
  });

  it('removes a remotely deleted animation even when an older read finishes late', async () => {
    render(<MemoryRouter><CodeAnimationGallery /></MemoryRouter>);
    await screen.findByText('Station boot');
    let finishRead;
    listCodeAnimationJobPage.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
    act(() => changed({ id: 'a' }));
    listCodeAnimationJobPage.mockResolvedValue({ items: [], nextCursor: null, counts: { running: 0, completed: 0 } });
    act(() => changed({ id: 'a', kind: 'deleted' }));
    await screen.findByText('0 completed · 0 in progress');
    await act(async () => finishRead({ items: [item('a', 'Station boot')], nextCursor: null, counts: { completed: 1, running: 0 } }));
    expect(screen.queryByText('Station boot')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete Station boot' })).toBeNull();
    expect(screen.getByText('0 completed · 0 in progress')).toBeTruthy();
  });

  it('reloads after reconnect and allows older pages to be loaded again', async () => {
    const user = userEvent.setup();
    listCodeAnimationJobPage.mockResolvedValueOnce({ items: [item('a', 'Deleted while offline')], nextCursor: 'older', counts: { completed: 3, running: 0 } })
      .mockResolvedValueOnce({ items: [item('b', 'Older animation')], nextCursor: null, counts: { completed: 3, running: 0 } });
    render(<MemoryRouter><CodeAnimationGallery /></MemoryRouter>);
    await user.click(await screen.findByRole('button', { name: 'Load older animations' }));
    await screen.findByText('Older animation');
    listCodeAnimationJobPage.mockResolvedValueOnce({ items: [item('c', 'Fresh animation')], nextCursor: 'older-again', counts: { completed: 2, running: 0 } })
      .mockResolvedValueOnce({ items: [item('b', 'Older animation')], nextCursor: null, counts: { completed: 2, running: 0 } });
    await act(async () => { await useSocketSubscription.mock.calls.at(-1)[1].onResubscribe(); });
    await screen.findByText('Fresh animation');
    expect(screen.queryByText('Deleted while offline')).toBeNull();
    expect(screen.queryByText('Older animation')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Load older animations' }));
    await screen.findByText('Older animation');
    expect(listCodeAnimationJobPage.mock.calls.at(-1)[0].cursor).toBe('older-again');
  });
});
