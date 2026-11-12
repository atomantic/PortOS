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

const checkedLine = (cueId, startSec) => ({ cueId, text: 'first', offsetSec: 0.6,
  words: [{ w: 'first', startSec, endSec: startSec + 1, conf: 'matched' }] });
const placedProject = { id: 'p', vocalStemFilename: 'stem.wav', vocalStemMasterFilename: 'song.wav',
  lyricCues: [cue, { ...cue, id: 'b', startSec: 4, endSec: 5, words: [{ w: 'first', startSec: 4, endSec: 5 }] }] };
const placementReport = { passed: false, extraPhrases: [], unsungCues: [], uncheckedCues: [], misplacedCues: [checkedLine('a', 1.6), checkedLine('b', 4.6)] };

it('accepts one line without changing the other occurrence and requires a re-check', async () => {
  const save = vi.fn(async () => true);
  render(<LyricSheetCheck project={placedProject} audioFilename="song.wav" onEditLocal={vi.fn()} onSave={save} />);
  fireEvent.click(screen.getByRole('button', { name: 'Check sheet against vocal' }));
  act(() => options.onComplete({ result: placementReport }));
  expect(screen.queryByText('No differences found among the timed lines.')).toBeNull();
  fireEvent.click(screen.getAllByRole('button', { name: 'Use the checked times' })[0]);
  await waitFor(() => expect(save).toHaveBeenCalledWith({ lyricCues: [expect.objectContaining({ id: 'a', startSec: 1.6, endSec: 2.6, suspect: false, words: placementReport.misplacedCues[0].words }), placedProject.lyricCues[1]] }));
  expect(await screen.findByText(/Run the check again/)).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'Use the checked times' })).toHaveLength(1);
});

it('accepts all checked times once and restores the sheet after a failed save', async () => {
  let finish;
  const save = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const edit = vi.fn();
  render(<LyricSheetCheck project={placedProject} audioFilename="song.wav" onEditLocal={edit} onSave={save} />);
  fireEvent.click(screen.getByRole('button', { name: 'Check sheet against vocal' }));
  act(() => options.onComplete({ result: placementReport }));
  const all = screen.getByRole('button', { name: 'Use all checked times' });
  fireEvent.click(all);
  fireEvent.click(all);
  expect(save).toHaveBeenCalledOnce();
  expect(save.mock.calls[0][0].lyricCues.map(line => line.startSec)).toEqual([1.6, 4.6]);
  expect(screen.getByRole('button', { name: 'Check sheet against vocal' })).toBeDisabled();
  expect(screen.getAllByRole('button', { name: 'Use the checked times' })[0]).toBeDisabled();
  await act(async () => finish(false));
  expect(edit).toHaveBeenLastCalledWith({ lyricCues: placedProject.lyricCues });
  expect(screen.getByRole('alert')).toHaveTextContent('Could not save the checked times.');
  expect(screen.getByRole('button', { name: 'Use all checked times' })).toBeEnabled();
});

it('discards timing offers when the sheet changes and does not claim unrecognized lines passed', () => {
  const save = vi.fn();
  const props = { project: placedProject, audioFilename: 'song.wav', onEditLocal: vi.fn(), onSave: save };
  const { rerender } = render(<LyricSheetCheck {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Check sheet against vocal' }));
  act(() => options.onComplete({ result: { ...placementReport, uncheckedCues: [{ cueId: 'b', text: 'unrecognized words' }] } }));
  expect(screen.getByText('Could not verify these lines')).toBeTruthy();
  rerender(<LyricSheetCheck {...props} project={{ ...placedProject, lyricCues: [{ ...cue, text: 'edited' }] }} />);
  expect(screen.queryByRole('button', { name: 'Use all checked times' })).toBeNull();
  expect(save).not.toHaveBeenCalled();
});
