import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// SongRecordings owns the color-match grading (#1092) so it can attach the
// finished take's pitch trace + accuracy to the saved recording. We mock the
// three seams that need a mic / Web Audio (none exist in jsdom):
//   - useColorMatch: the grading hook. stop() returns the analysis to attach.
//   - audioRecorder.startMemoRecording: the WAV recorder.
//   - services/api: the upload + url helpers.
// The pure grading math is covered in colorMatch.test.js; here we pin the
// wiring: stop() is harvested before the stream drops, and its analysis lands
// on the new recording entry.

// startMatch returns true when a grading run actually armed (mirrors the real
// hook: false on no-stream / rest-only / already-running). The owner gates
// "armed for this take" on that, so the default success case returns true.
let matchStartResult = true;
const matchStart = vi.fn(() => matchStartResult);
let matchStopResult = null;
const matchStop = vi.fn(() => matchStopResult);
let hookState = { running: false, countingIn: false, noteColors: {}, summary: null, activeIndex: null };

vi.mock('../../hooks/useColorMatch', () => ({
  __esModule: true,
  default: () => ({ ...hookState, start: matchStart, stop: matchStop }),
}));

const takeResult = { audioBase64: 'data', durationMs: 1200, peak: 0.5 };
const handleStop = vi.fn(() => Promise.resolve(takeResult));
vi.mock('../../lib/audioRecorder', () => ({
  startMemoRecording: vi.fn(() => Promise.resolve({
    stream: { getTracks: () => [{ stop: vi.fn() }] },
    stop: handleStop,
    cancel: vi.fn(),
  })),
}));

vi.mock('../../lib/songPlayback', () => ({
  createLayeredPlayer: vi.fn(() => ({ play: vi.fn(() => Promise.resolve()), stop: vi.fn(), onEnded: vi.fn() })),
}));

const uploadFile = vi.fn(() => Promise.resolve({ filename: 'vocal-test.wav' }));
vi.mock('../../services/api', () => ({
  uploadFile: (...a) => uploadFile(...a),
  getUploadUrl: (f) => `/api/uploads/${f}`,
}));

vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

// PitchTuner taps Web Audio (createStreamAnalyser) on a live stream — stub it;
// it has its own test. ColorMatch stays real (it's pure now) so we exercise the
// lifted grading state it renders.
vi.mock('./PitchTuner', () => ({ default: () => null }));

import SongRecordings from './SongRecordings.jsx';

// A short score so scoreHasMusic() is true and grading auto-arms.
const SCORE = ['time: 4/4', 'tempo: 120', '| C4q D4q E4q F4q |'].join('\n');

describe('SongRecordings — pitch analysis wiring (#1092)', () => {
  beforeEach(() => {
    matchStart.mockClear();
    matchStop.mockClear();
    handleStop.mockClear();
    uploadFile.mockClear();
    matchStartResult = true;
    matchStopResult = null;
    hookState = { running: false, countingIn: false, noteColors: {}, summary: null, activeIndex: null };
  });

  it('attaches the captured pitchTrack + accuracy to the new take on stop', async () => {
    matchStopResult = {
      summary: { graded: 4, counts: { 'in-tune': 3, close: 1, off: 0, missed: 0 }, percentInTune: 75, perNote: ['in-tune', 'in-tune', 'in-tune', 'close'] },
      pitchTrack: [{ tMs: 0, hz: 261.6, cents: 2, clarity: 0.95 }, { tMs: 50, hz: 293.7, cents: -3, clarity: 0.9 }],
    };
    const onChange = vi.fn();
    render(<SongRecordings recordings={[]} score={SCORE} tempo={120} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: /record take/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /stop & save/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /stop & save/i }));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    // Grading was stopped to harvest the analysis.
    expect(matchStop).toHaveBeenCalled();
    const next = onChange.mock.calls.at(-1)[0];
    expect(next).toHaveLength(1);
    expect(next[0].filename).toBe('vocal-test.wav');
    expect(next[0].accuracy).toEqual(matchStopResult.summary);
    expect(next[0].pitchTrack).toEqual(matchStopResult.pitchTrack);
  });

  it('omits analysis when grading produced no graded notes', async () => {
    matchStopResult = {
      summary: { graded: 0, counts: { 'in-tune': 0, close: 0, off: 0, missed: 0 }, percentInTune: 0, perNote: [] },
      pitchTrack: [],
    };
    const onChange = vi.fn();
    render(<SongRecordings recordings={[]} score={SCORE} tempo={120} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: /record take/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /stop & save/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /stop & save/i }));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const next = onChange.mock.calls.at(-1)[0];
    expect(next[0]).not.toHaveProperty('accuracy');
    expect(next[0]).not.toHaveProperty('pitchTrack');
  });

  it('does not inherit a prior take’s analysis when a later take has no score to grade', async () => {
    // Regression (codex review): the hook only resets its trace/grade accumulators
    // on start(). A no-score take never arms grading, so an unguarded stopMatch()
    // would return the PREVIOUS take's analysis. The owner gates harvest on
    // "armed for THIS take", so a no-score take must persist no analysis — even
    // though the mocked stopMatch() still returns stale data if called.
    matchStopResult = {
      summary: { graded: 4, counts: { 'in-tune': 4, close: 0, off: 0, missed: 0 }, percentInTune: 100, perNote: ['in-tune', 'in-tune', 'in-tune', 'in-tune'] },
      pitchTrack: [{ tMs: 0, hz: 261.6, cents: 0, clarity: 0.99 }],
    };
    const onChange = vi.fn();
    // No score → scoreHasMusic() is false → grading never auto-arms.
    const { rerender } = render(<SongRecordings recordings={[]} score="" tempo={120} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: /record take/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /stop & save/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /stop & save/i }));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    // stopMatch() must not even be consulted for an unarmed take.
    expect(matchStop).not.toHaveBeenCalled();
    const next = onChange.mock.calls.at(-1)[0];
    expect(next[0]).not.toHaveProperty('accuracy');
    expect(next[0]).not.toHaveProperty('pitchTrack');
    // Keep rerender referenced (used to prove the harness can swap props).
    rerender(<SongRecordings recordings={next} score="" tempo={120} onChange={onChange} />);
  });

  it('does not arm (or harvest) when the score has notation but no gradable notes', async () => {
    // Regression (codex iteration 2): a rest-only score makes scoreHasMusic()
    // true, so the auto-arm effect runs — but the hook's start() bails (zero
    // gradable notes) WITHOUT resetting its accumulators. The owner must trust
    // startMatch()'s return value: a false arm means no harvest, so a rest-only
    // take can't inherit the prior take's analysis.
    matchStartResult = false; // hook reports it didn't actually start a run
    matchStopResult = {
      summary: { graded: 4, counts: { 'in-tune': 4, close: 0, off: 0, missed: 0 }, percentInTune: 100, perNote: ['in-tune', 'in-tune', 'in-tune', 'in-tune'] },
      pitchTrack: [{ tMs: 0, hz: 261.6, cents: 0, clarity: 0.99 }],
    };
    const onChange = vi.fn();
    // A score with a measure (scoreHasMusic true) but only a rest.
    const restOnly = ['time: 4/4', 'tempo: 120', '| rw |'].join('\n');
    render(<SongRecordings recordings={[]} score={restOnly} tempo={120} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: /record take/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /stop & save/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /stop & save/i }));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(matchStop).not.toHaveBeenCalled(); // unarmed → no harvest attempt
    const next = onChange.mock.calls.at(-1)[0];
    expect(next[0]).not.toHaveProperty('accuracy');
    expect(next[0]).not.toHaveProperty('pitchTrack');
  });

  it('shows a saved take’s accuracy badge and a Review button to replay its grading', () => {
    const recordings = [{
      id: 'rec-1', label: 'Take', filename: 'a.wav', durationMs: 1000, peak: 0.4, muted: false,
      accuracy: { graded: 4, counts: { 'in-tune': 3, close: 1, off: 0, missed: 0 }, percentInTune: 75, perNote: ['in-tune', 'in-tune', 'in-tune', 'close'] },
    }];
    render(<SongRecordings recordings={recordings} score={SCORE} tempo={120} onChange={vi.fn()} />);
    // Badge shows the persisted percent (read from disk, not recomputed).
    expect(screen.getByText('75%')).toBeTruthy();
    // Review button is present and toggles aria-pressed.
    const review = screen.getByRole('button', { name: /review take grading/i });
    expect(review.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(review);
    expect(review.getAttribute('aria-pressed')).toBe('true');
  });

  it('does not offer Review for a legacy take with no per-note grades', () => {
    const recordings = [{ id: 'rec-1', label: 'Take', filename: 'a.wav', durationMs: 1000, peak: 0.4, muted: false }];
    render(<SongRecordings recordings={recordings} score={SCORE} tempo={120} onChange={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /review take grading/i })).toBeNull();
  });
});
