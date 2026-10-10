// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import SetupStage from './SetupStage.jsx';

vi.mock('../../songs/MidiVisualization.jsx', () => ({ default: () => null }));
vi.mock('../CompositionPreviewPlayer.jsx', () => ({ default: ({ lyrics }) => <div data-testid="playthrough">{lyrics ? 'lyrics' : 'document'}</div> }));

const review = (over = {}) => ({ readiness: null, current: true, busy: false, error: null, save: vi.fn(async () => ({})), reverifyAlignment: vi.fn(async () => ({})), ...over });
const board = (project, extra = {}) => ({
  project, tracks: [], trackName: () => 'Song', tempo: { bpm: '', setBpm: vi.fn() }, audioFilename: 'a.wav', audioUrl: '/data/music/a.wav', locked: false,
  youtube: { editJob: {}, editUrl: '', setEditUrl: vi.fn(), startEdit: vi.fn() },
  midi: { model: 'base', active: false }, busy: {},
  onAnalyze: vi.fn(), onAlignLyrics: vi.fn(), ...extra,
});

describe('Song step', () => {
  it('lays out four open numbered parts with done states and nothing else', () => {
    const project = {
      id: 'p', trackId: 't', audioAnalysis: { durationSec: 10 },
      lyricCues: [{ id: 'c', text: 'hi', words: [{ w: 'hi', startSec: 0, endSec: 1 }] }],
      productionReview: { draft: { lyricsMode: 'vocal', timingStatus: 'verified' } },
    };
    render(<SetupStage board={board(project, { productionReview: review() })} />);
    const steps = screen.getAllByRole('region', { name: /^Step \d/ });
    expect(steps.map((s) => s.getAttribute('aria-label'))).toEqual([
      'Step 1: Track', 'Step 2: Analyze', 'Step 3: Lyrics', 'Step 4: Time and verify',
    ]);
    steps.forEach((s) => expect(within(s).getByText('Done')).toBeTruthy());
    // Advanced audio and project options moved to Project settings; no folds here.
    expect(document.getElementById('mv-setup-advanced-audio')).toBeNull();
    expect(document.querySelector('details#mv-setup-song')).toBeNull();
    expect(within(steps[3]).getByText('Word timing verified against the current master.')).toBeTruthy();
  });

  it('marks every part to do for an empty project', () => {
    render(<SetupStage board={board({ id: 'p' })} />);
    expect(screen.getAllByText('To do')).toHaveLength(4);
  });

  it('verifies the timing on the step itself, keeping an unsaved planning draft in step', async () => {
    const save = vi.fn(async () => ({}));
    const setPlanning = vi.fn();
    const project = { id: 'p', trackId: 't', audioAnalysis: {}, lyricCues: [{ id: 'c', text: 'hi', startSec: 1, endSec: 2, words: [{ w: 'hi' }] }],
      productionReview: { draft: { cast: 'kept', lyricsMode: 'vocal', timingStatus: 'provisional', timingNotes: '' } } };
    render(<SetupStage board={board(project, { productionReview: review({ save }), planningDraft: [{ cast: 'edited', lyricsMode: 'vocal' }, setPlanning] })} />);
    fireEvent.change(screen.getByLabelText('Notes (optional)'), { target: { value: 'Listened through twice' } });
    // The timing is judged on the lyric playthrough shown beside the button.
    expect(screen.getByTestId('playthrough').textContent).toBe('lyrics');
    await fireEvent.click(screen.getByRole('button', { name: 'Timing looks right' }));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ cast: 'kept', lyricsMode: 'vocal', timingStatus: 'verified', timingNotes: 'Listened through twice' }));
    await vi.waitFor(() => expect(setPlanning).toHaveBeenCalledWith({ cast: 'edited', lyricsMode: 'vocal', timingStatus: 'verified', timingNotes: 'Listened through twice' }));
  });

  it('holds the timing check until the aligned words can be played through', () => {
    const project = { id: 'p', trackId: 't', audioAnalysis: {}, lyricCues: [{ id: 'c', text: 'hi', startSec: 1, endSec: 2 }],
      productionReview: { draft: { lyricsMode: 'vocal', timingStatus: 'provisional' } } };
    render(<SetupStage board={board(project, { productionReview: review(), aligningLyrics: true })} />);
    expect(screen.queryByTestId('playthrough')).toBeNull();
    expect(screen.getByText(/Aligning the words to the vocal/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Timing looks right' })).toBeDisabled();
  });

  it('re-verifies a stale timing through the alignment route without requiring a note', () => {
    const reverifyAlignment = vi.fn(async () => ({}));
    const project = { id: 'p', trackId: 't', audioAnalysis: {}, lyricCues: [{ id: 'c', text: 'hi', startSec: 1, endSec: 2 }], productionReview: { draft: { lyricsMode: 'vocal', timingStatus: 'verified' } } };
    render(<SetupStage board={board(project, { productionReview: review({ reverifyAlignment, readiness: { alignment: { status: 'stale' } } }) })} />);
    const button = screen.getByRole('button', { name: 'Timing still looks right' });
    expect(button).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Notes (optional)'), { target: { value: 'New master checked' } });
    fireEvent.click(button);
    expect(reverifyAlignment).toHaveBeenCalledWith('New master checked');
  });

  it('keeps an unsaved planning draft in step after a re-verify', async () => {
    const setPlanning = vi.fn();
    const project = { id: 'p', trackId: 't', audioAnalysis: {}, lyricCues: [{ id: 'c', text: 'hi', startSec: 1, endSec: 2 }], productionReview: { draft: { lyricsMode: 'vocal', timingStatus: 'verified', timingNotes: 'old' } } };
    render(<SetupStage board={board(project, {
      productionReview: review({ readiness: { alignment: { status: 'stale' } } }),
      planningDraft: [{ cast: 'edited', timingStatus: 'verified', timingNotes: 'old' }, setPlanning],
    })} />);
    fireEvent.change(screen.getByLabelText('Notes (optional)'), { target: { value: 'New master checked' } });
    fireEvent.click(screen.getByRole('button', { name: 'Timing still looks right' }));
    await vi.waitFor(() => expect(setPlanning).toHaveBeenCalledWith({ cast: 'edited', timingStatus: 'verified', timingNotes: 'New master checked' }));
  });

  it('confirms an instrumental straight away; a note is optional', () => {
    const save = vi.fn(async () => ({}));
    const project = { id: 'p', trackId: 't', audioAnalysis: {}, productionReview: { draft: {} } };
    render(<SetupStage board={board(project, { productionReview: review({ save }) })} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Instrumental' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm instrumental' }));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ lyricsMode: 'instrumental', timingNotes: '' }));
  });
});
