import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import WaveformPanel from './WaveformPanel';
import * as api from '../../services/api';

vi.mock('../../services/api', () => ({
  drawWaveform: vi.fn(),
  renderTrackWaveform: vi.fn(),
}));

const drawn = {
  version: 1,
  title: 'Glass Tide',
  durationSec: 1,
  shapes: { glass: [0, 0.8, 1, 0.3, 0, -0.5, -1, -0.2] },
  voices: [
    { name: 'lead', shape: 'glass', gain: 0.6, notes: [{ t: 0, d: 0.5, hz: 440, pitch: 'A4', v: 0.8 }] },
    { name: 'hats', shape: 'noise', gain: 0.6, notes: [{ t: 0.5, d: 0.05, hz: 12000, v: 0.8 }] },
  ],
};

// Minimal Web Audio double: the panel plays the synthesized PCM through one
// AudioBufferSourceNode on the shared context.
const audio = vi.hoisted(() => ({ sources: [] }));
function FakeAudioContext() {
  this.state = 'running';
  this.currentTime = 0;
  this.destination = {};
  this.createBuffer = (_channels, length, sampleRate) => {
    const data = new Float32Array(length);
    return { length, sampleRate, getChannelData: () => data };
  };
  this.createBufferSource = () => {
    const source = { connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null };
    audio.sources.push(source);
    return source;
  };
}

const renderPanel = (props = {}) => render(
  <WaveformPanel
    trackId="track-1"
    description="glassy tidal ambient"
    lyrics=""
    title=""
    providerId="provider-a"
    model="model-a"
    effort=""
    providerPicker={<div data-testid="picker" />}
    {...props}
  />,
);

describe('<WaveformPanel>', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    audio.sources = [];
    vi.stubGlobal('AudioContext', FakeAudioContext);
    api.drawWaveform.mockResolvedValue({ sketch: drawn, llm: { provider: 'provider-a', model: 'model-a' } });
    api.renderTrackWaveform.mockResolvedValue({ track: { id: 'track-1' }, filename: 'music-x.wav', durationSec: 1 });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('draws from the description with the chosen provider, shows the drawing, and remembers it', async () => {
    renderPanel();
    expect(screen.getByText(/Nothing drawn yet/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Drawing guidance (optional)'), { target: { value: 'lots of glide' } });
    fireEvent.click(screen.getByRole('button', { name: /Draw it/ }));

    await screen.findByText('Glass Tide');
    expect(api.drawWaveform).toHaveBeenCalledWith({
      description: 'glassy tidal ambient',
      lyrics: undefined,
      guidance: 'lots of glide',
      durationSec: 20,
      providerId: 'provider-a',
      model: 'model-a',
      effort: undefined,
    }, { silent: true });
    expect(screen.getByTestId('waveform-shapes').textContent).toContain('glass');
    expect(screen.getByText(/2 voices · 2 strokes/)).toBeTruthy();

    // A remount (reload) of the same draft restores the drawing without a call.
    cleanup();
    renderPanel();
    expect(screen.getByText('Glass Tide')).toBeTruthy();
    expect(api.drawWaveform).toHaveBeenCalledTimes(1);

    // …but a different draft starts blank.
    cleanup();
    renderPanel({ trackId: 'track-2' });
    expect(screen.getByText(/Nothing drawn yet/)).toBeTruthy();
  });

  it('revises by sending the current drawing back', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /Draw it/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Revise drawing/ }));
    await waitFor(() => expect(api.drawWaveform).toHaveBeenCalledTimes(2));
    expect(api.drawWaveform.mock.calls[1][0].current).toEqual(drawn);
  });

  it('plays and stops the synthesized drawing', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /Draw it/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Play drawing/ }));

    await screen.findByRole('button', { name: /Stop/ });
    const [source] = audio.sources;
    expect(source.start).toHaveBeenCalled();
    expect(source.buffer.length).toBe(44100);

    fireEvent.click(screen.getByRole('button', { name: /Stop/ }));
    expect(source.stop).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Play drawing/ })).toBeTruthy();
  });

  it('saves the drawing as a take, titled from the drawing when the user gave none', async () => {
    const onRendered = vi.fn();
    renderPanel({ onRendered });
    fireEvent.click(screen.getByRole('button', { name: /Draw it/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Save as take/ }));

    await waitFor(() => expect(onRendered).toHaveBeenCalledWith({ id: 'track-1' }));
    expect(api.renderTrackWaveform).toHaveBeenCalledWith('track-1', {
      sketch: drawn, prompt: 'glassy tidal ambient', title: 'Glass Tide',
    }, { silent: true });
  });
});
