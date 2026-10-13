import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import PerformanceEvidence from './PerformanceEvidence.jsx';

const instruction = {
  speaker: 'Example Singer', audio: { conditioning: { source: 'clean-singer-stem', filename: 'singer.wav', voiceIsolation: 'unverified' } },
  audioWindow: { startSec: 10 }, edit: { inSec: 2 },
  cues: [{ text: 'hello world', startSec: 2, endSec: 4, words: [{ text: 'hello', startSec: 2, endSec: 3 }, { text: 'world', startSec: 3, endSec: 4 }] }],
};
describe('PerformanceEvidence', () => {
  it('synchronizes recorded source play, seek and pause, and seeks words/evidence on their distinct timebases', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const temporal = { status: 'verified', analyzer: { id: 'example-analyzer', version: '1' },
      spans: [{ startSec: 1, endSec: 2, status: 'verified', offsetSec: 0.02, confidence: 0.9 }] };
    const { container } = render(<PerformanceEvidence clipSrc="/example.mp4" instruction={instruction} temporal={temporal} excerptStartSec={12} />);
    const video = container.querySelector('video');
    const audio = container.querySelector('audio');
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(2);
    expect(audio.currentTime).toBe(12);
    fireEvent.play(video);
    expect(play.mock.instances).toContain(audio);
    video.currentTime = 2.5;
    fireEvent.timeUpdate(video);
    expect(audio.currentTime).toBe(12.5);
    fireEvent.click(screen.getByRole('button', { name: /world/ }));
    expect(video.currentTime).toBe(3);
    expect(audio.currentTime).toBe(13);
    fireEvent.click(screen.getByRole('button', { name: /0:13/ }));
    expect(video.currentTime).toBe(3);
    fireEvent.pause(video);
    expect(pause.mock.instances).toContain(audio);
    expect(screen.getByText(/example-analyzer 1/)).toBeTruthy();
    play.mockRejectedValueOnce(new Error('blocked'));
    fireEvent.play(video);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Source playback failed'));
    vi.restoreAllMocks();
  });

  it('says when the recorded source is missing', () => {
    render(<PerformanceEvidence clipSrc="/example.mp4" instruction={{}} />);
    expect(screen.getByText(/Recorded source unavailable/)).toBeTruthy();
  });

  // Shot 19 of a music video: a 2.33 s shot inside a 5 s take showed blank word chips, the
  // next line's words, and "review needed" lines no one could act on without an analyzer.
  it('lists only the shot\'s own words, explains the longer take, stops at the out point and stays quiet without an analyzer', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const take = {
      audio: { conditioning: { source: 'vocal-stem', filename: 'singer.wav' } },
      audioWindow: { startSec: 40, durationSec: 5 }, edit: { inSec: 1, outSec: 3.33 }, capability: { minAudioSec: 5 },
      cues: [
        { text: 'this line', startSec: 0.9, endSec: 3.2, words: [{ w: 'this', startSec: 0.9, endSec: 1.6 }, { text: 'line', startSec: 1.7, endSec: 3.2 }] },
        { text: 'the next line', startSec: 4.3, endSec: 5 },
      ],
    };
    const { container } = render(<PerformanceEvidence clipSrc="/example.mp4" instruction={take}
      repair={{ ok: false, message: 'Review needed: complete measured temporal evidence is required' }} onRepair={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'this' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'line' })).toBeTruthy();
    expect(screen.queryByText(/the next line/)).toBeNull();
    expect(screen.getByText(/needs at least 5 s of song/)).toBeTruthy();
    expect(screen.getByText(/Audio: vocal stem/)).toBeTruthy();
    expect(screen.queryByText(/Review needed|unverified/i)).toBeNull();
    const video = container.querySelector('video');
    fireEvent.loadedMetadata(video);
    fireEvent.play(video);
    pause.mockClear();
    video.currentTime = 3.4;
    fireEvent.timeUpdate(video);
    expect(pause.mock.instances).toContain(video);
    vi.restoreAllMocks();
  });
});

// This interaction verifies the spend/boundary shown before the explicit
// submission, and that inconclusive evidence cannot expose a repair action.
it('shows the accepted boundary and next spend, disables duplicate clicks, and requires a conclusive repair plan', () => {
  const onRepair = vi.fn();
  const repair = { ok: true, boundarySec: 14, endSec: 24, costUsd: 1.6 };
  const view = render(<PerformanceEvidence clipSrc="/example.mp4" instruction={instruction} repair={repair} onRepair={onRepair} />);
  expect(screen.getByText(/Continue only 0:14.00–0:24.00/)).toBeTruthy();
  expect(screen.getByText(/Next spend: \$1.60/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Repair from here' }));
  expect(onRepair).toHaveBeenCalledTimes(1);
  view.rerender(<PerformanceEvidence instruction={instruction} repair={repair} onRepair={onRepair} repairBusy />);
  expect(screen.getByRole('button', { name: 'Repairing…' }).disabled).toBe(true);
  view.rerender(<PerformanceEvidence instruction={instruction} temporal={{ status: 'unverified', analyzer: { id: 'example-analyzer', version: '1' }, spans: [] }}
    repair={{ ok: false, message: 'Review needed: evidence is inconclusive' }} onRepair={onRepair} />);
  expect(screen.queryByRole('button', { name: 'Repair from here' })).toBeNull();
  expect(screen.getByText(/evidence is inconclusive/)).toBeTruthy();
});
