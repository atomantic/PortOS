import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// Drive the component off a mocked training hook so we don't need a real mic /
// AudioContext (neither exists in jsdom). The hook + the pure progress math are
// tested on their own (useColorMatch + songProgress.test.js).
const start = vi.fn();
const stop = vi.fn();
let hookState = { running: false, countingIn: false, noteColors: {}, activeIndex: null, lastSummary: null };

vi.mock('../../hooks/useSongTraining.js', () => ({
  __esModule: true,
  default: () => ({ ...hookState, start, stop }),
}));

import SongTraining from './SongTraining.jsx';
import { recordAttempt, WHOLE_SONG_SCOPE } from '../../lib/songProgress.js';

const SCORE = [
  'clef: treble', 'key: G', 'time: 4/4', 'tempo: 68', '',
  '| [G] D4q(If) D4q(you) | [G] B4h(miss) |',
  '',
  '| [Em] B4h(on) | [C] C5q(know) G4q(am) |',
].join('\n');

describe('SongTraining', () => {
  beforeEach(() => {
    start.mockClear();
    stop.mockClear();
    hookState = { running: false, countingIn: false, noteColors: {}, activeIndex: null, lastSummary: null };
  });

  it('prompts to add a melody when the song has no notated music', () => {
    render(<SongTraining score="" />);
    expect(screen.getByText(/add a notated melody/i)).toBeTruthy();
  });

  it('renders the scope picker with the whole song and each section', () => {
    render(<SongTraining score={SCORE} lyricSections={[{ label: 'Verse 1' }, { label: 'Chorus' }]} />);
    const select = screen.getByLabelText(/practice/i);
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(options[0]).toMatch(/whole song/i);
    expect(options.some((o) => /Verse 1/.test(o))).toBe(true);
    expect(options.some((o) => /Chorus/.test(o))).toBe(true);
  });

  it('shows a Start button that triggers a run after the mic opens', async () => {
    // getUserMedia isn't in jsdom — provide a stub the component awaits.
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [] });
    Object.defineProperty(global.navigator, 'mediaDevices', {
      value: { getUserMedia }, configurable: true,
    });
    render(<SongTraining score={SCORE} />);
    fireEvent.click(screen.getByRole('button', { name: /start/i }));
    expect(getUserMedia).toHaveBeenCalled();
    // The Start handler awaits getUserMedia then arms the run via setState —
    // flush that resolution inside act() so it doesn't fire after the test returns.
    await act(async () => {});
  });

  it('renders progress for trained scopes', () => {
    // Whole song trained to 90% once.
    const progress = recordAttempt(null, WHOLE_SONG_SCOPE, { percentInTune: 90, graded: 6 });
    render(<SongTraining score={SCORE} progress={progress} />);
    // The whole-song best/avg (both 90% after one take) are surfaced.
    expect(screen.getAllByText(/90%/).length).toBeGreaterThan(0);
    // The memorization bar label is present.
    expect(screen.getByText(/memorization/i)).toBeTruthy();
  });

  it('surfaces the last-take readout from the hook', () => {
    hookState = { ...hookState, lastSummary: { percentInTune: 75, graded: 4 } };
    render(<SongTraining score={SCORE} />);
    expect(screen.getByText(/last take/i)).toBeTruthy();
    expect(screen.getByText(/75%/)).toBeTruthy();
  });

  it('closes the mic when a non-loop run finishes naturally', async () => {
    // Track stop() on the mic's track so we can assert teardown without a real
    // AudioContext. The hook is mocked, so we drive `running` true→false by hand
    // and re-render — that edge is the natural-completion signal.
    const trackStop = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: trackStop }] });
    Object.defineProperty(global.navigator, 'mediaDevices', {
      value: { getUserMedia }, configurable: true,
    });

    const { rerender } = render(<SongTraining score={SCORE} />);
    fireEvent.click(screen.getByRole('button', { name: /start/i }));
    await screen.findByRole('button', { name: /stop/i }); // mic landed → armed run

    // Hook reports the run started, then finished (running flips true → false).
    hookState = { ...hookState, running: true };
    rerender(<SongTraining score={SCORE} />);
    hookState = { ...hookState, running: false };
    rerender(<SongTraining score={SCORE} />);

    // Natural completion (loop off) must stop the mic track and drop back to Start.
    expect(trackStop).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /start/i })).toBeTruthy();
  });
});
