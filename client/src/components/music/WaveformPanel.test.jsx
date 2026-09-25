import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import WaveformPanel from './WaveformPanel';
import * as api from '../../services/api';

vi.mock('../../services/api', () => ({
  drawTrackWaveform: vi.fn(),
  getTrack: vi.fn(),
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
    // The server stores what it drew; getTrack serves it back (a reload).
    const stored = new Map();
    api.drawTrackWaveform.mockImplementation(async (trackId) => {
      stored.set(trackId, drawn);
      return { sketch: drawn, llm: { provider: 'provider-a', model: 'model-a' }, track: { id: trackId, waveSketch: drawn } };
    });
    api.getTrack.mockImplementation(async (trackId) => ({ id: trackId, waveSketch: stored.get(trackId) ?? null }));
    api.renderTrackWaveform.mockResolvedValue({ track: { id: 'track-1' }, filename: 'music-x.wav', durationSec: 1 });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('draws from the description with the chosen provider, stores it on the track, and reloads it', async () => {
    const onTrackUpdate = vi.fn();
    renderPanel({ onTrackUpdate });
    expect(screen.getByText(/Nothing drawn yet/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Drawing guidance (optional)'), { target: { value: 'lots of glide' } });
    fireEvent.click(screen.getByRole('button', { name: /Draw it/ }));

    await screen.findByText('Glass Tide');
    expect(api.drawTrackWaveform).toHaveBeenCalledWith('track-1', {
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
    expect(onTrackUpdate).toHaveBeenCalledWith({ id: 'track-1', waveSketch: drawn });

    // A remount (reload) of the same draft loads the stored drawing — no LLM call.
    cleanup();
    renderPanel();
    await screen.findByText('Glass Tide');
    expect(api.drawTrackWaveform).toHaveBeenCalledTimes(1);

    // …but a different draft starts blank.
    cleanup();
    renderPanel({ trackId: 'track-2' });
    await waitFor(() => expect(api.getTrack).toHaveBeenCalledWith('track-2', { silent: true }));
    expect(screen.getByText(/Nothing drawn yet/)).toBeTruthy();
  });

  it('opens on the host track\'s stored drawing without fetching', () => {
    renderPanel({ track: { id: 'track-1', waveSketch: drawn } });
    expect(screen.getByText('Glass Tide')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Revise drawing/ })).toBeTruthy();
    expect(api.getTrack).not.toHaveBeenCalled();
  });

  it('sends the typed length, clamped to the supported range', async () => {
    renderPanel();
    const length = screen.getByLabelText('Length (sec)');
    fireEvent.change(length, { target: { value: '1' } });
    fireEvent.change(length, { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: /Draw it/ }));
    await waitFor(() => expect(api.drawTrackWaveform).toHaveBeenCalledTimes(1));
    expect(api.drawTrackWaveform.mock.calls[0][1].durationSec).toBe(12);

    fireEvent.change(length, { target: { value: '999' } });
    fireEvent.click(await screen.findByRole('button', { name: /Draw from scratch/ }));
    await waitFor(() => expect(api.drawTrackWaveform).toHaveBeenCalledTimes(2));
    expect(api.drawTrackWaveform.mock.calls[1][1].durationSec).toBe(60);
  });

  it('revises the stored drawing (the server holds it, so only the intent is sent)', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /Draw it/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Revise drawing/ }));
    await waitFor(() => expect(api.drawTrackWaveform).toHaveBeenCalledTimes(2));
    expect(api.drawTrackWaveform.mock.calls[0][1].revise).toBeUndefined();
    expect(api.drawTrackWaveform.mock.calls[1][1]).toMatchObject({ revise: true });
    expect(api.drawTrackWaveform.mock.calls[1][1].current).toBeUndefined();
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

  it('saves the stored drawing as a take, titled from the drawing when the user gave none', async () => {
    const onRendered = vi.fn();
    renderPanel({ onRendered });
    fireEvent.click(screen.getByRole('button', { name: /Draw it/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Save as take/ }));

    await waitFor(() => expect(onRendered).toHaveBeenCalledWith({ id: 'track-1' }));
    expect(api.renderTrackWaveform).toHaveBeenCalledWith('track-1', {
      prompt: 'glassy tidal ambient', title: 'Glass Tide',
    }, { silent: true });
  });
});
