import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Mock the metronome engine — jsdom has no Web Audio. Track instances so the
// test can assert start/stop and setBpm wiring without driving the audio clock.
const engine = vi.hoisted(() => ({ instances: [], opts: [] }));
vi.mock('../../lib/metronome.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual, // keep the real clampBpm / timeSignatureFromScore pure helpers
    createMetronome: (opts) => {
      engine.opts.push(opts);
      const m = { start: vi.fn(() => Promise.resolve()), stop: vi.fn(), setBpm: vi.fn() };
      engine.instances.push(m);
      return m;
    },
  };
});
vi.mock('../ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

import Metronome from './Metronome.jsx';

describe('Metronome component', () => {
  beforeEach(() => {
    engine.instances = [];
    engine.opts = [];
  });

  it('defaults the BPM input from the song tempo', () => {
    render(<Metronome tempo={68} score="time: 4/4" />);
    expect(screen.getByLabelText('Tempo (BPM)')).toHaveValue(68);
  });

  it('shows the time signature derived from the score header', () => {
    render(<Metronome tempo={90} score={'time: 3/4\n| C4q D4q E4q |'} />);
    expect(screen.getByText('3/4')).toBeInTheDocument();
  });

  it('starts and stops the metronome, passing tempo + time-sig + count-in', async () => {
    render(<Metronome tempo={120} score="time: 4/4" />);
    fireEvent.click(screen.getByRole('button', { name: /start/i }));

    await waitFor(() => expect(engine.instances).toHaveLength(1));
    expect(engine.instances[0].start).toHaveBeenCalled();
    expect(engine.opts[0]).toMatchObject({ bpm: 120, beatsPerBar: 4, countInBars: 1 });

    // Once running, the control flips to Stop and tears the engine down on click.
    fireEvent.click(await screen.findByRole('button', { name: /stop/i }));
    expect(engine.instances[0].stop).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /start/i })).toBeInTheDocument();
  });

  it('clamps the BPM input into the supported band', () => {
    render(<Metronome tempo={120} score="time: 4/4" />);
    const input = screen.getByLabelText('Tempo (BPM)');
    fireEvent.change(input, { target: { value: '5000' } });
    expect(input).toHaveValue(320);
  });

  it('omits the count-in when the toggle is unchecked', async () => {
    render(<Metronome tempo={100} score="time: 4/4" />);
    fireEvent.click(screen.getByLabelText(/count-in/i));
    fireEvent.click(screen.getByRole('button', { name: /start/i }));
    await waitFor(() => expect(engine.opts).toHaveLength(1));
    expect(engine.opts[0].countInBars).toBe(0);
  });
});
