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

  it('supports single-selection mode and custom title', () => {
    const onAdd = vi.fn();
    const onClose = vi.fn();
    render(<AlbumTrackPicker open tracks={tracks} onAdd={onAdd} onClose={onClose} single title="Pick soundtrack track" />);

    expect(screen.getByRole('heading', { name: 'Pick soundtrack track' })).toBeTruthy();
    const selectBtn = screen.getByRole('button', { name: /select track/i });
    expect(selectBtn).toBeDisabled();

    fireEvent.click(screen.getByLabelText('Select Daybreak'));
    expect(selectBtn).not.toBeDisabled();

    // Selecting another replaces the selection in single mode
    fireEvent.click(screen.getByLabelText('Select Northern Lights'));
    fireEvent.click(selectBtn);

    expect(onAdd).toHaveBeenCalledWith([tracks[0]]);
    expect(onClose).toHaveBeenCalled();
  });
});
