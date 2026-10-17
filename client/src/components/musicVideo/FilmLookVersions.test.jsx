import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../services/apiMusicVideo.js', () => ({
  getMusicVideoFilmLooks: vi.fn(),
  deleteMusicVideoFilmLook: vi.fn(),
}));

import FilmLookVersions from './FilmLookVersions.jsx';
import { deleteMusicVideoFilmLook, getMusicVideoFilmLooks } from '../../services/apiMusicVideo.js';

const project = { id: 'mv-1', composition: { mode: 'composed' }, filmLook: { preset: 'super8' } };
const super8 = { id: 'b'.repeat(32), look: { preset: 'super8', grain: 0.75 }, current: true, rendered: 116, bytes: 650 * 1024 ** 2 };
const vhs = { id: 'c'.repeat(32), look: { preset: 'vhs', grain: 0.25 }, current: false, rendered: 40, bytes: 120 * 1024 ** 2 };

beforeEach(() => vi.clearAllMocks());

describe('FilmLookVersions', () => {
  it('lists the cached looks, puts one back on the video, and deletes one', async () => {
    vi.useFakeTimers();
    getMusicVideoFilmLooks.mockResolvedValue({ available: true, total: 116, looks: [super8, vhs] });
    const onUse = vi.fn();
    render(<FilmLookVersions project={project} onUse={onUse} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    vi.useRealTimers();
    const rows = screen.getAllByTestId('film-look-version');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/Super 8In use116 of 116 shots/),
      expect.stringMatching(/VHS40 of 116 shots/),
    ]);
    fireEvent.click(screen.getByRole('button', { name: /Use/ }));
    expect(onUse).toHaveBeenCalledWith(vhs.look);

    deleteMusicVideoFilmLook.mockResolvedValueOnce({ available: true, total: 116, looks: [super8] });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Delete VHS renders' })));
    expect(deleteMusicVideoFilmLook).toHaveBeenCalledWith('mv-1', vhs.id, { silent: true });
    expect(screen.getAllByTestId('film-look-version')).toHaveLength(1);
  });
});
