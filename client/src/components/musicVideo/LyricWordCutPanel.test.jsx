import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import LyricWordCutPanel from './LyricWordCutPanel.jsx';

const words = (text, at) => text.split(' ').map((w, i) => ({ w, startSec: at + i, endSec: at + i + 0.5, conf: 'matched' }));
const project = (extra = {}) => ({
  id: 'mv-1',
  scenes: [{ sceneId: 's1', label: 'Verse', startSec: 0, endSec: 20 }, { sceneId: 's2', label: 'Outro', startSec: 20, endSec: 30 }],
  lyricCues: [
    { id: 'l1', text: 'Great Danoodle, Beagle, Pug!', words: words('Great Danoodle, Beagle, Pug!', 2) },
    { id: 'l2', text: 'Corgi, Collie', words: words('Corgi, Collie', 8) },
    { id: 'l3', text: 'Not aligned yet' },
  ],
  ...extra,
});

describe('LyricWordCutPanel', () => {
  // Catches the Shots board sending the wrong line range or mode, or cutting untimed lines.
  it('cuts the chosen line range per phrase or per word, and waits for word timing', async () => {
    const onCut = vi.fn(() => Promise.resolve());
    render(<LyricWordCutPanel project={project()} onCut={onCut} onDismissSync={() => {}} />);
    fireEvent.change(screen.getByLabelText('To line'), { target: { value: 'l2' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Cut 5 shots/ })); });
    expect(onCut).toHaveBeenCalledWith({ cueIds: ['l1', 'l2'], mode: 'phrase' });
    fireEvent.change(screen.getByLabelText('Shots'), { target: { value: 'word' } });
    expect(screen.getByRole('button', { name: /Cut 6 shots/ })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('To line'), { target: { value: 'l3' } });
    expect(screen.getByRole('button', { name: /Cut/ }).disabled).toBe(true);
    expect(screen.getByText(/Align words on the Song step first/)).toBeTruthy();
  });

  // Catches the panel hiding on an empty board, or promising a cut when there is nothing to split.
  it('offers to lay out shots when the board has no timed shots', async () => {
    const onCut = vi.fn(() => Promise.resolve());
    render(<LyricWordCutPanel project={project({ scenes: [{ sceneId: 'u1', label: 'Untimed' }, { sceneId: 'c1', startSec: 0, endSec: 3, preMusic: { durationSec: 3 } }] })} onCut={onCut} onDismissSync={() => {}} />);
    expect(screen.getByText(/No timed shots yet/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Lay out 3 shots/ })); });
    expect(onCut).toHaveBeenCalledWith({ cueIds: ['l1'], mode: 'phrase' });
  });

  it('shows on a board with no shots at all', () => {
    render(<LyricWordCutPanel project={project({ scenes: [] })} onCut={() => {}} onDismissSync={() => {}} />);
    expect(screen.getByRole('button', { name: /Lay out 3 shots/ })).toBeTruthy();
  });

  // Catches the panel keying on the render style: a document project with Board shots must keep it, a shot manifest must not.
  it('follows where the storyboard comes from, not the render style', () => {
    const composition = { mode: 'document' };
    const { rerender } = render(<LyricWordCutPanel project={project({ composition, productionReview: { draft: { storyboardSource: 'board' } } })} onCut={() => {}} onDismissSync={() => {}} />);
    expect(screen.getByRole('button', { name: /Cut 3 shots/ })).toBeTruthy();
    rerender(<LyricWordCutPanel project={project({ composition })} onCut={() => {}} onDismissSync={() => {}} />);
    expect(screen.getByRole('button', { name: /Cut 3 shots/ })).toBeTruthy();
    rerender(<LyricWordCutPanel project={project({ composition, productionReview: { draft: { storyboardSource: 'document' } } })} onCut={() => {}} onDismissSync={() => {}} />);
    expect(screen.queryByRole('group', { name: 'Cut on lyric words' })).toBeNull();
  });

  it('says which shots followed their words after re-alignment until dismissed', () => {
    const onDismissSync = vi.fn();
    render(<LyricWordCutPanel project={project({ lyricAnchorSync: { at: 'now', moved: [{ sceneId: 's2', fromSec: 20, toSec: 20.2 }], unresolved: ['s1'], blocked: [] } })}
      onCut={() => {}} onDismissSync={onDismissSync} />);
    expect(screen.getByText(/1 shot followed its word: Outro \(\+0\.20s\)/)).toBeTruthy();
    expect(screen.getByText(/Not moved .*: Verse/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismissSync).toHaveBeenCalled();
  });
});
