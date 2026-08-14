import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ChordTransportBar from './ChordTransportBar.jsx';

const base = {
  playing: false,
  onToggle: () => {},
  hasChords: true,
  bpm: 90,
  onBpmChange: () => {},
  onPercent: () => {},
  writtenTempo: 90,
  beatsPerBar: 4,
  onBeatsPerBarChange: () => {},
  countInBars: 1,
  onCountInChange: () => {},
  clickEnabled: false,
  onClickToggle: () => {},
  chordCount: 4,
  pulse: null,
};

const renderBar = (props = {}) => render(<ChordTransportBar {...base} {...props} />);

describe('ChordTransportBar', () => {
  it('renders the transport controls with their current values', () => {
    renderBar();
    expect(screen.getByLabelText('Play along')).toBeTruthy();
    expect(screen.getByLabelText('Practice tempo (BPM)').value).toBe('90');
    expect(screen.getByLabelText('Beats per chord').value).toBe('4');
    expect(screen.getByLabelText('Count-in').value).toBe('1');
    // The metronome is off by default, so the button offers to turn it ON.
    expect(screen.getByLabelText('Turn the metronome on')).toBeTruthy();
  });

  it('advertises a keyboard shortcut only when the host actually binds one', () => {
    // The editor and importer previews bind no key, so their tooltip must not
    // name one; the viewer's play mode passes its own.
    const { rerender } = renderBar();
    expect(screen.getByLabelText('Play along').getAttribute('title')).toBe('Play along');
    rerender(<ChordTransportBar {...base} keyHint="(p)" />);
    expect(screen.getByLabelText('Play along').getAttribute('title')).toBe('Play along (p)');
  });

  it('disables Play when the sheet has nothing playable, and says why', () => {
    renderBar({ hasChords: false });
    const play = screen.getByLabelText('Play along');
    expect(play.disabled).toBe(true);
    expect(play.getAttribute('title')).toContain('Nothing to play');
  });

  it('steps the tempo by five and passes the raw input value through', () => {
    const onBpmChange = vi.fn();
    renderBar({ onBpmChange });
    fireEvent.click(screen.getByLabelText('Faster by 5 BPM'));
    expect(onBpmChange).toHaveBeenLastCalledWith(95);
    fireEvent.click(screen.getByLabelText('Slower by 5 BPM'));
    expect(onBpmChange).toHaveBeenLastCalledWith(85);
  });

  it('reports the beats-per-chord and count-in selections', () => {
    const onBeatsPerBarChange = vi.fn();
    const onCountInChange = vi.fn();
    renderBar({ onBeatsPerBarChange, onCountInChange });
    fireEvent.change(screen.getByLabelText('Beats per chord'), { target: { value: '3' } });
    expect(onBeatsPerBarChange).toHaveBeenCalledWith('3');
    fireEvent.change(screen.getByLabelText('Count-in'), { target: { value: '2' } });
    expect(onCountInChange).toHaveBeenCalledWith('2');
  });

  it('toggles the metronome to the opposite of its current state', () => {
    const onClickToggle = vi.fn();
    const { rerender } = renderBar({ onClickToggle });
    fireEvent.click(screen.getByLabelText('Turn the metronome on'));
    expect(onClickToggle).toHaveBeenLastCalledWith(true);
    rerender(<ChordTransportBar {...base} onClickToggle={onClickToggle} clickEnabled />);
    fireEvent.click(screen.getByLabelText('Turn the metronome off'));
    expect(onClickToggle).toHaveBeenLastCalledWith(false);
  });

  it.each([
    ['stopped', { pulse: null }, 'Stopped', '1/4'],
    ['counting in', { pulse: { index: null, beat: 2, countingIn: true } }, 'Counting in, beat 2', 'count-in'],
    ['mid-sheet', { pulse: { index: 2, beat: 3, countingIn: false } }, 'Beat 3', '3/4'],
  ])('reads out the pulse and position while %s', (_label, props, beatLabel, position) => {
    renderBar(props);
    expect(screen.getByLabelText(beatLabel)).toBeTruthy();
    expect(screen.getByText(position)).toBeTruthy();
  });

  it('collapses the setup controls behind a disclosure on a phone', () => {
    renderBar();
    const toggle = screen.getByLabelText('Show practice settings');
    const panel = document.getElementById(toggle.getAttribute('aria-controls'));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // Hidden under `sm`, always laid out from `sm` up — so the panel exists in
    // the DOM either way and the phone state is a class, not a mount.
    expect(panel.className).toContain('hidden');
    expect(panel.className).toContain('sm:flex');

    fireEvent.click(toggle);
    expect(screen.getByLabelText('Hide practice settings').getAttribute('aria-expanded')).toBe('true');
    expect(panel.className).toContain('flex');
  });
});
