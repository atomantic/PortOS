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
  it('restores the local sheet if insertion cannot be saved', async () => {
    const edit = vi.fn();
    const save = vi.fn(async () => false);
    render(<LyricSheetCheck project={{ id: 'p', vocalStemFilename: 'stem.wav', vocalStemMasterFilename: 'song.wav', lyricCues: [cue] }} audioFilename="song.wav" onEditLocal={edit} onSave={save} />);
    fireEvent.click(screen.getByRole('button', { name: 'Check sheet against vocal' }));
    act(() => options.onComplete({ result: { extraPhrases: [{ startSec: 3, endSec: 4, text: 'extra words' }], unsungCues: [] } }));
    fireEvent.click(screen.getByRole('button', { name: 'Insert line here' }));
    await waitFor(() => expect(edit).toHaveBeenLastCalledWith({ lyricCues: [cue], lyricMarkers: [] }));
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save the line.');
    expect(screen.getByText(/extra words/)).toBeTruthy();
  });
  it('keeps an unrecognised vocal phrase playable without inserting an empty lyric', () => {
    const save = vi.fn();
    const edit = vi.fn();
    render(<LyricSheetCheck project={{ id: 'p', vocalStemFilename: 'stem.wav', vocalStemMasterFilename: 'song.wav', lyricCues: [cue] }} audioFilename="song.wav" onEditLocal={edit} onSave={save} />);
    fireEvent.click(screen.getByRole('button', { name: 'Check sheet against vocal' }));
    act(() => options.onComplete({ result: { extraPhrases: [{ startSec: 3, endSec: 4, text: '' }], unsungCues: [] } }));
    expect(screen.getByText(/vocal, no words recognised/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled();
    const insert = screen.getByRole('button', { name: 'Insert line here' });
    expect(insert).toBeDisabled();
    fireEvent.click(insert);
    expect(edit).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
  it('prevents a second insertion while the first save is pending', async () => {
    let finish;
    const save = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    render(<LyricSheetCheck project={{ id: 'p', vocalStemFilename: 'stem.wav', vocalStemMasterFilename: 'song.wav', lyricCues: [cue] }} audioFilename="song.wav" onEditLocal={vi.fn()} onSave={save} />);
    fireEvent.click(screen.getByRole('button', { name: 'Check sheet against vocal' }));
    act(() => options.onComplete({ result: { extraPhrases: [{ startSec: 3, endSec: 4, text: 'extra' }, { startSec: 5, endSec: 6, text: 'more' }], unsungCues: [] } }));
    const buttons = screen.getAllByRole('button', { name: 'Insert line here' });
    fireEvent.click(buttons[0]);
    expect(buttons[1]).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Check sheet against vocal' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Check sheet against vocal' }));
    expect(screen.getByText(/extra/)).toBeTruthy();
    fireEvent.click(buttons[1]);
    expect(save).toHaveBeenCalledOnce();
    await act(async () => finish(true));
    expect(screen.getByRole('button', { name: 'Check sheet against vocal' })).toBeEnabled();
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
