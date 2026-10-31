import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import PanelSongTiming from './PanelSongTiming';

const panel = { id: 'panel-a', seconds: 4 };
const span = { beforeSong: false, startSec: 10, endSec: 14, durationSec: 4, estimated: false, pastSong: false, lyricText: 'Here we go' };
const cues = [{ id: 'c1', text: 'Here we go', startSec: 11 }, { id: 'c2', text: 'Next line', startSec: 15.5 }];

describe('PanelSongTiming', () => {
  it('shows when the panel plays and what is sung over it', () => {
    render(<PanelSongTiming panel={panel} span={span} lyricCues={cues} onPatch={() => {}} />);
    expect(screen.getByText('0:10.00')).toBeTruthy();
    expect(screen.getByText('Here we go')).toBeTruthy();
    expect(screen.getByLabelText('Ends').value).toBe('14');
  });

  it('sets the panel length from its end, or from where a sung line starts', () => {
    const onPatch = vi.fn();
    render(<PanelSongTiming panel={panel} span={span} lyricCues={cues} onPatch={onPatch} />);
    const end = screen.getByLabelText('Ends');
    fireEvent.change(end, { target: { value: '15.25' } });
    fireEvent.blur(end);
    expect(onPatch).toHaveBeenLastCalledWith({ seconds: 5.25 });
    fireEvent.change(screen.getByLabelText('End where a line starts'), { target: { value: '15.5' } });
    expect(onPatch).toHaveBeenLastCalledWith({ seconds: 5.5 });
  });

  it('reverts an end before the panel starts', () => {
    const onPatch = vi.fn();
    render(<PanelSongTiming panel={panel} span={span} lyricCues={cues} onPatch={onPatch} />);
    const end = screen.getByLabelText('Ends');
    fireEvent.change(end, { target: { value: '9' } });
    fireEvent.blur(end);
    expect(onPatch).not.toHaveBeenCalled();
    expect(end.value).toBe('14');
  });
});
