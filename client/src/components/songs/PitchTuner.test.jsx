import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// Web Audio doesn't exist in jsdom, so mock the two lib seams the tuner uses:
// `createStreamAnalyser` (graph off a stream) and `createPitchTracker` (the rAF
// loop). We assert the component attaches and tears both down correctly without
// needing a real AudioContext.
const analyserClose = vi.fn();
const trackerStop = vi.fn();
let lastOnUpdate = null;

vi.mock('../../lib/audioRecorder.js', () => ({
  createStreamAnalyser: vi.fn(() => ({ analyser: { id: 'analyser' }, context: {}, close: analyserClose })),
}));

vi.mock('../../lib/pitchDetect.js', async (importActual) => {
  const actual = await importActual(); // keep the real tuningQuality
  return {
    ...actual,
    createPitchTracker: vi.fn((analyser, opts) => {
      lastOnUpdate = opts.onUpdate;
      return { stop: trackerStop };
    }),
  };
});

import PitchTuner from './PitchTuner.jsx';
import { createStreamAnalyser } from '../../lib/audioRecorder.js';
import { createPitchTracker } from '../../lib/pitchDetect.js';

const fakeStream = () => ({ getTracks: () => [{ stop: vi.fn() }] });

describe('PitchTuner', () => {
  beforeEach(() => {
    analyserClose.mockClear();
    trackerStop.mockClear();
    createStreamAnalyser.mockClear();
    createPitchTracker.mockClear();
    lastOnUpdate = null;
  });

  it('attaches to a provided recording stream (no second getUserMedia)', () => {
    const stream = fakeStream();
    render(<PitchTuner stream={stream} />);
    expect(createStreamAnalyser).toHaveBeenCalledWith(stream);
    expect(createPitchTracker).toHaveBeenCalledTimes(1);
    // Attached mode shows the live badge and hides the standalone Tune button.
    expect(screen.getByText(/live/)).toBeTruthy();
    expect(screen.queryByText('Tune')).toBeNull();
  });

  it('renders the detected note + cents from a tracker update', async () => {
    render(<PitchTuner stream={fakeStream()} />);
    // The tracker's onUpdate callback drives setState; invoke it inside act().
    act(() => lastOnUpdate({ note: { letter: 'A', accidental: '', octave: 4 }, cents: 3 }));
    await waitFor(() => expect(screen.getByText('A4')).toBeTruthy());
    expect(screen.getByText(/\+3¢ · In tune/)).toBeTruthy();
  });

  it('tears down tracker + analyser when the stream goes away', () => {
    const { rerender } = render(<PitchTuner stream={fakeStream()} />);
    expect(trackerStop).not.toHaveBeenCalled();
    rerender(<PitchTuner stream={null} />);
    expect(trackerStop).toHaveBeenCalled();
    expect(analyserClose).toHaveBeenCalled();
  });

  it('tears down on unmount', () => {
    const { unmount } = render(<PitchTuner stream={fakeStream()} />);
    unmount();
    expect(trackerStop).toHaveBeenCalled();
    expect(analyserClose).toHaveBeenCalled();
  });

  it('releases the standalone mic and switches when a recording stream arrives', async () => {
    const ownTracks = [{ stop: vi.fn() }];
    global.navigator.mediaDevices = { getUserMedia: vi.fn(() => Promise.resolve({ getTracks: () => ownTracks })) };

    const { rerender } = render(<PitchTuner />); // standalone
    fireEvent.click(screen.getByText('Tune'));
    await waitFor(() => expect(createStreamAnalyser).toHaveBeenCalledTimes(1));

    const recStream = fakeStream();
    rerender(<PitchTuner stream={recStream} />); // a take starts recording
    // The self-opened mic is released and the tuner re-attaches to the take's stream.
    expect(ownTracks[0].stop).toHaveBeenCalled();
    expect(createStreamAnalyser).toHaveBeenLastCalledWith(recStream);
    expect(screen.queryByText('Tune')).toBeNull();
  });

  it('standalone mode opens its own mic on Tune and closes it on Stop', async () => {
    const ownTracks = [{ stop: vi.fn() }];
    const getUserMedia = vi.fn(() => Promise.resolve({ getTracks: () => ownTracks }));
    global.navigator.mediaDevices = { getUserMedia };

    render(<PitchTuner />); // no stream → standalone
    expect(screen.getByText('Tune')).toBeTruthy();

    fireEvent.click(screen.getByText('Tune'));
    await waitFor(() => expect(createPitchTracker).toHaveBeenCalled());
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });

    fireEvent.click(screen.getByText('Stop'));
    expect(trackerStop).toHaveBeenCalled();
    expect(analyserClose).toHaveBeenCalled();
    expect(ownTracks[0].stop).toHaveBeenCalled(); // the mic we opened is released
  });
});
