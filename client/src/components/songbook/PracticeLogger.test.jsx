import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

vi.mock('../../services/api', () => ({ practiceSong: vi.fn() }));
vi.mock('../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

import PracticeLogger from './PracticeLogger.jsx';
import { practiceSong } from '../../services/api';
import toast from '../ui/Toast';

const song = (overrides = {}) => ({
  id: 'song-1',
  title: 'Example Song',
  stage: 'learning',
  updatedAt: '2026-02-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const future = () => new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

describe('PracticeLogger', () => {
  it('marks a song with no schedule as due and never practiced', () => {
    render(<PracticeLogger song={song()} />);
    expect(screen.getByText('Due now')).toBeTruthy();
    expect(screen.getByText('Never practiced')).toBeTruthy();
  });

  it('shows the next review and the session count once practiced', () => {
    render(<PracticeLogger song={song({
      practice: { nextReview: future(), lastReviewed: '2026-02-20T00:00:00.000Z', sessions: 3 },
    })} />);
    expect(screen.queryByText('Due now')).toBeNull();
    expect(screen.getByText(/Next review in/)).toBeTruthy();
    expect(screen.getByText(/3 sessions/)).toBeTruthy();
  });

  it('singularizes a single session', () => {
    render(<PracticeLogger song={song({
      practice: { nextReview: future(), lastReviewed: '2026-02-20T00:00:00.000Z', sessions: 1 },
    })} />);
    expect(screen.getByText(/1 session ·/)).toBeTruthy();
  });

  it('posts the grade and hands the updated record back — no client-side scheduling', async () => {
    const updated = { ...song(), stage: 'learned', practice: { nextReview: future(), sessions: 1 } };
    practiceSong.mockResolvedValue(updated);
    const onLogged = vi.fn();
    render(<PracticeLogger song={song()} onLogged={onLogged} />);

    fireEvent.click(screen.getByRole('button', { name: 'Solid' }));

    await waitFor(() => expect(onLogged).toHaveBeenCalledWith(updated));
    // The grade is the ONLY thing sent; the server owns stage + schedule.
    expect(practiceSong).toHaveBeenCalledWith('song-1', 4, { silent: true });
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('learned'));
  });

  it('sends the low grade for a failed run', async () => {
    practiceSong.mockResolvedValue({ ...song(), stage: 'learning', practice: { nextReview: new Date().toISOString() } });
    render(<PracticeLogger song={song()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Struggled' }));
    await waitFor(() => expect(practiceSong).toHaveBeenCalledWith('song-1', 0, { silent: true }));
  });

  it('surfaces a failure once and leaves local state alone', async () => {
    practiceSong.mockRejectedValue(new Error('nope'));
    const onLogged = vi.fn();
    render(<PracticeLogger song={song()} onLogged={onLogged} />);

    fireEvent.click(screen.getByRole('button', { name: 'Clean' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(onLogged).not.toHaveBeenCalled();
    // The request is silent so useAsyncAction's toast is the ONLY error layer.
    expect(practiceSong).toHaveBeenCalledWith('song-1', 5, { silent: true });
    expect(toast.success).not.toHaveBeenCalled();
  });
});
