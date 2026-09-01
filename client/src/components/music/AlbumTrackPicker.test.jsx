import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import AlbumTrackPicker from './AlbumTrackPicker';

const tracks = [
  { id: 'track-1', title: 'Northern Lights', artist: 'The Examples', durationSec: 201 },
  { id: 'track-2', title: 'Midnight Signal', artist: 'Test Artist', durationSec: 185 },
  { id: 'track-3', title: 'Daybreak', artist: 'The Examples' },
];

describe('AlbumTrackPicker', () => {
  it('searches by title or artist and adds multiple selected tracks in library order', () => {
    const onAdd = vi.fn();
    const onClose = vi.fn();
    render(<AlbumTrackPicker open tracks={tracks} onAdd={onAdd} onClose={onClose} />);

    fireEvent.change(screen.getByRole('searchbox', { name: /search tracks/i }), { target: { value: 'examples' } });
    expect(screen.getByText('Northern Lights')).toBeTruthy();
    expect(screen.getByText('Daybreak')).toBeTruthy();
    expect(screen.queryByText('Midnight Signal')).toBeNull();

    fireEvent.click(screen.getByLabelText('Select Daybreak'));
    fireEvent.click(screen.getByLabelText('Select Northern Lights'));
    fireEvent.click(screen.getByRole('button', { name: /add selected/i }));

    expect(onAdd).toHaveBeenCalledWith([tracks[0], tracks[2]]);
    expect(onClose).toHaveBeenCalled();
  });

  it('does not allow an empty batch to be added', () => {
    render(<AlbumTrackPicker open tracks={tracks} onAdd={() => {}} onClose={() => {}} />);
    expect(screen.getByRole('button', { name: /add selected/i })).toBeDisabled();
  });
});
