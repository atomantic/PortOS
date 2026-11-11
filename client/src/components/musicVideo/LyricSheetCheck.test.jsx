// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import LyricSheetCheck from './LyricSheetCheck.jsx';

let options;
vi.mock('../../hooks/useSseJobSlot.js', () => ({ default: value => { options = value; return { active: false, start: vi.fn(), cancel: vi.fn() }; } }));
const cue = { id: 'a', text: 'first', startSec: 1, endSec: 2, words: [{ w: 'first', startSec: 1, endSec: 2 }] };

describe('lyric sheet check', () => {
  it('explains the missing stem', () => {
    render(<LyricSheetCheck project={{ id: 'p', lyricCues: [cue] }} />);
    expect(screen.getByRole('button', { name: 'Check sheet against vocal' })).toBeDisabled();
    expect(screen.getByText('Align words with a separated vocal first.')).toBeTruthy();
  });
  it('inserts a reported phrase into the saved sheet in time order', async () => {
    const edit = vi.fn();
    const save = vi.fn(async () => true);
    render(<LyricSheetCheck project={{ id: 'p', vocalStemFilename: 'stem.wav', vocalStemMasterFilename: 'song.wav', lyricCues: [cue] }} audioFilename="song.wav" onEditLocal={edit} onSave={save} />);
    fireEvent.click(screen.getByRole('button', { name: 'Check sheet against vocal' }));
    act(() => options.onComplete({ result: { extraPhrases: [{ startSec: 3, endSec: 4, text: 'extra words' }], unsungCues: [] } }));
    expect(await screen.findByText(/extra words/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Insert line here' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ lyricCues: [cue, expect.objectContaining({ text: 'extra words', startSec: 3, endSec: 4 })] })));
    await waitFor(() => expect(screen.queryByText(/extra words/)).toBeNull());
  });
});
