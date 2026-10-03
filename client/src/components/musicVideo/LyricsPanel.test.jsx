import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import LyricsPanel from './LyricsPanel.jsx';

const PROJECT = {
  id: 'mv-1',
  trackId: 't1',
  lyricCues: [{
    id: 'lc-1',
    text: 'walking home',
    startSec: 1,
    endSec: 2,
    words: [
      { w: 'walking', startSec: 1, endSec: 1.4, conf: 'matched' },
      { w: 'home', startSec: 1.4, endSec: 2, conf: 'interpolated' },
    ],
  }],
};

function renderPanel(overrides = {}) {
  const props = {
    project: PROJECT,
    onEditLocal: vi.fn(),
    onSave: vi.fn(),
    onImport: vi.fn(),
    onAlign: vi.fn(),
    ...overrides,
  };
  render(<LyricsPanel {...props} />);
  return props;
}

describe('LyricsPanel word alignment', () => {
  it('saves exact first-word starts and multiple boundaries together, preserving the cue and rejecting reversed ranges', () => {
    const { onSave } = renderPanel();
    fireEvent.change(screen.getByLabelText('Start of word 1 (walking), line 1'), { target: { value: '0.82' } });
    fireEvent.change(screen.getByLabelText('End of word 1 (walking), line 1'), { target: { value: '1.25' } });
    fireEvent.change(screen.getByLabelText('Start of word 2 (home), line 1'), { target: { value: '1.3' } });
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save word times for line 1' }));
    expect(onSave).toHaveBeenCalledWith({ lyricCues: [{ ...PROJECT.lyricCues[0], words: [
      { ...PROJECT.lyricCues[0].words[0], startSec: 0.82, endSec: 1.25 },
      { ...PROJECT.lyricCues[0].words[1], startSec: 1.3 },
    ] }] });
    onSave.mockClear();
    fireEvent.change(screen.getByLabelText('End of word 2 (home), line 1'), { target: { value: '1.2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save word times for line 1' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('at least 0.02 seconds');
  });
  it('does not align until Align words is clicked, and shows the whisper setup error', async () => {
    const onAlign = vi.fn().mockRejectedValue(new Error(
      'Speech-to-text is not running. Enable the local whisper server in Settings → Voice, then try Align words again.',
    ));
    renderPanel({ onAlign });
    expect(onAlign).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Align words' }));
    expect(onAlign).toHaveBeenCalledWith(undefined);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Settings → Voice/);
  });

  it('flags only measured low confidence, and clears the badge data when the lyric text changes', () => {
    const cues = [
      { ...PROJECT.lyricCues[0], matched: 0.4 },
      { id: 'b', text: 'new line', startSec: null, endSec: null },
      { id: 'c', text: 'confident line', startSec: 5, endSec: 6, matched: 0.5 },
    ];
    const { onEditLocal } = renderPanel({ project: { ...PROJECT, lyricCues: cues } });
    expect(screen.getAllByText('Low confidence — check by ear')).toHaveLength(1);
    fireEvent.change(screen.getByRole('textbox', { name: 'Line 1 text' }), { target: { value: 'changed line' } });
    expect(onEditLocal.mock.lastCall[0].lyricCues[0].matched).toBeUndefined();
    expect(onEditLocal.mock.lastCall[0].lyricCues[0].words).toBeUndefined();
  });

  it('re-aligns one line and nudges a word boundary into the save', () => {
    const { onAlign, onSave } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Re-align line 1' }));
    expect(onAlign).toHaveBeenCalledWith('lc-1');
    expect(screen.getByText('home').className).toMatch(/text-port-warning/);
    expect(screen.getByText('walking').className).toMatch(/text-port-accent/);
    fireEvent.click(screen.getByRole('button', { name: 'Nudge the end of walking later' }));
    expect(onSave).toHaveBeenCalledWith({
      lyricCues: [{
        ...PROJECT.lyricCues[0],
        words: [
          { w: 'walking', startSec: 1, endSec: 1.45, conf: 'matched' },
          { w: 'home', startSec: 1.45, endSec: 2, conf: 'interpolated' },
        ],
      }],
    });
  });
});

describe('LyricsPanel track lyrics', () => {
  it('offers the linked track\'s lyric sheet, and shows its sections and directions over the lines', () => {
    const onImportTrack = vi.fn();
    renderPanel({
      onImportTrack,
      project: {
        ...PROJECT,
        lyricMarkers: [
          { type: 'section', label: 'Chorus', kind: 'chorus', line: 0 },
          { type: 'direction', label: 'Whispered spoken', kind: 'whispered', line: 0 },
        ],
      },
    });
    expect(screen.getByText('Chorus')).toBeTruthy();
    expect(screen.getByText('[Whispered spoken]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Use track lyrics/ }));
    expect(onImportTrack).toHaveBeenCalledOnce();
  });

  it('has no track-lyrics button without a linked track', () => {
    renderPanel({ onImportTrack: vi.fn(), project: { ...PROJECT, trackId: null } });
    expect(screen.queryByRole('button', { name: /Use track lyrics/ })).toBeNull();
  });
});
