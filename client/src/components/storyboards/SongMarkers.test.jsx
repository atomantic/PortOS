import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import SongMarkers from './SongMarkers';

const track = (filename, sections = []) => ({ filename, name: filename, sections, lines: [] });

describe('SongMarkers draft reconciliation', () => {
  it('reverts an optimistic marker when its save fails', async () => {
    let rejectSave;
    const onChange = vi.fn(() => new Promise((_, reject) => { rejectSave = reject; }));
    render(<SongMarkers track={track('first.wav')} time={2} onSeek={() => {}} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: /Mark section at/ }));
    expect(screen.getByLabelText('Section name').value).toBe('Section 1');
    await act(async () => { await Promise.resolve(); });
    await act(async () => { rejectSave(new Error('save failed')); });
    await waitFor(() => expect(screen.queryByLabelText('Section name')).toBeNull());
  });

  it('keeps a replacement temp track while a marker save is pending', async () => {
    let releaseSave;
    const onChange = vi.fn(() => new Promise((resolve) => { releaseSave = resolve; }));
    const { rerender } = render(<SongMarkers track={track('first.wav')} time={2} onSeek={() => {}} onChange={onChange} />);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Mark section at/ })); await Promise.resolve(); });
    rerender(<SongMarkers track={track('replacement.wav')} time={3} onSeek={() => {}} onChange={onChange} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Mark section at/ })); await Promise.resolve(); });
    await act(async () => { releaseSave({}); await Promise.resolve(); });

    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.calls[1][0]).toMatchObject({ filename: 'replacement.wav', name: 'replacement.wav' });
    expect(onChange.mock.calls[1][0].sections).toHaveLength(2);
  });
});
