import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import WaveformPanel from './WaveformPanel';
import * as api from '../../services/api';
import { renderSketchPreview } from '../../lib/waveSketchSynthWorker.js';

vi.mock('../../services/api', () => ({
  drawTrackWaveform: vi.fn(),
  getTrack: vi.fn(),
  renderTrackWaveform: vi.fn(),
}));

// A v2 painted canvas (#8464): one tonal and one noise stroke.
const painted = {
  version: 2,
  title: 'Glass Tide',
  durationSec: 1,
  sections: [{ start: 0, end: 1 }],
  strokes: [
    { name: 'line', overtones: [0.4], path: [{ t: 0, hz: 440, a: 0.6 }, { t: 0.5, hz: 660, a: 0.4, overtones: [0.1, 0.5] }] },
    { name: 'air', width: 1200, pan: -0.5, path: [{ t: 0.4, hz: 5000, a: 0.2 }, { t: 1, hz: 4000, a: 0 }] },
  ],
};

// A v1 drawing stored before #8464.
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
  this.createBuffer = (numberOfChannels, length, sampleRate) => {
    const data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
    return { numberOfChannels, length, sampleRate, getChannelData: (c) => data[c] };
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
      stored.set(trackId, painted);
      return { sketch: painted, llm: { provider: 'provider-a', model: 'model-a' }, track: { id: trackId, waveSketch: painted } };
    });
    api.getTrack.mockImplementation(async (trackId) => ({ id: trackId, waveSketch: stored.get(trackId) ?? null }));
    api.renderTrackWaveform.mockResolvedValue({ track: { id: 'track-1' }, filename: 'music-x.wav', durationSec: 1 });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('paints from the description with the chosen provider, stores it on the track, and reloads it', async () => {
    const onTrackUpdate = vi.fn();
    renderPanel({ onTrackUpdate });
    expect(screen.getByText(/Nothing painted yet/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Painting guidance (optional)'), { target: { value: 'lots of glide' } });
    fireEvent.click(screen.getByRole('button', { name: /Paint it/ }));

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
    expect(screen.getByTestId('waveform-canvas-summary').textContent).toContain('2 strokes (1 noise) · 4 keyframes · 1 passage');
    expect(screen.getByRole('img', { name: /Spectrogram of the painting: 2 strokes over 1 seconds/ })).toBeTruthy();
    expect(onTrackUpdate).toHaveBeenCalledWith({ id: 'track-1', waveSketch: painted });

    // A remount (reload) of the same draft loads the stored drawing — no LLM call.
    cleanup();
    renderPanel();
    await screen.findByText('Glass Tide');
    expect(api.drawTrackWaveform).toHaveBeenCalledTimes(1);

    // …but a different draft starts blank.
    cleanup();
    renderPanel({ trackId: 'track-2' });
    await waitFor(() => expect(api.getTrack).toHaveBeenCalledWith('track-2', { silent: true }));
    expect(screen.getByText(/Nothing painted yet/)).toBeTruthy();
  });

  it('opens on the host track\'s stored painting without fetching, and revises it at its own length', async () => {
    renderPanel({ track: { id: 'track-1', waveSketch: { ...painted, durationSec: 95 } } });
    expect(screen.getByText('Glass Tide')).toBeTruthy();
    expect(api.getTrack).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Length (sec)').value).toBe('95');
    fireEvent.click(screen.getByRole('button', { name: /Revise painting/ }));
    await waitFor(() => expect(api.drawTrackWaveform).toHaveBeenCalledTimes(1));
    expect(api.drawTrackWaveform.mock.calls[0][1]).toMatchObject({ revise: true, durationSec: 95 });
  });

  it('still shows, plays, and saves a v1 drawing, which is repainted rather than revised', async () => {
    renderPanel({ track: { id: 'track-1', waveSketch: drawn } });
    expect(screen.getByTestId('waveform-shapes').textContent).toContain('glass');
    expect(screen.getByText(/2 voices · 2 strokes/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Revise/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Paint from scratch/ })).toBeTruthy();
    const playButton = await screen.findByRole('button', { name: /Play drawing/ });
    await act(async () => {
      fireEvent.click(playButton);
      await Promise.resolve();
    });
    await screen.findByRole('button', { name: /Stop/ });
    expect(audio.sources[0].buffer.numberOfChannels).toBe(1);
  });

  it('renders the preview off the main thread and never plays a superseded sketch\'s audio', async () => {
    // A Worker double: the test decides when (and whether) each render lands.
    const workers = [];
    vi.stubGlobal('Worker', function FakeWorker() {
      this.messages = [];
      this.terminated = false;
      this.postMessage = (msg) => this.messages.push(msg);
      this.terminate = () => { this.terminated = true; };
      workers.push(this);
    });
    const reply = (worker) => act(async () => {
      const [{ id, sketch, columns }] = worker.messages;
      worker.onmessage({ data: { id, ...renderSketchPreview(sketch, columns) } });
    });

    renderPanel({ track: { id: 'track-1', waveSketch: drawn } });
    const pending = screen.getByRole('button', { name: /Rendering preview/ });
    expect(pending.disabled).toBe(true);
    expect(workers[0].messages[0].sketch.version).toBe(1);

    // Repaint while the v1 render is still in flight: the stale render is killed.
    fireEvent.click(screen.getByRole('button', { name: /Paint from scratch/ }));
    await screen.findByTestId('waveform-canvas-summary');
    expect(workers[0].terminated).toBe(true);
    expect(workers[1].messages[0].sketch.version).toBe(2);

    // The stale worker answering late changes nothing.
    await reply(workers[0]);
    expect(screen.getByRole('button', { name: /Rendering preview/ }).disabled).toBe(true);

    await reply(workers[1]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Play painting/ }));
      await Promise.resolve();
    });
    await screen.findByRole('button', { name: /Stop/ });
    expect(audio.sources).toHaveLength(1);
    expect(audio.sources[0].buffer.numberOfChannels).toBe(2);
  });

  it('sends the typed length, clamped to the supported range', async () => {
    renderPanel();
    const length = screen.getByLabelText('Length (sec)');
    fireEvent.change(length, { target: { value: '1' } });
    fireEvent.change(length, { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: /Paint it/ }));
    await waitFor(() => expect(api.drawTrackWaveform).toHaveBeenCalledTimes(1));
    expect(api.drawTrackWaveform.mock.calls[0][1].durationSec).toBe(12);

    fireEvent.change(length, { target: { value: '9999' } });
    fireEvent.click(await screen.findByRole('button', { name: /Paint from scratch/ }));
    await waitFor(() => expect(api.drawTrackWaveform).toHaveBeenCalledTimes(2));
    expect(api.drawTrackWaveform.mock.calls[1][1].durationSec).toBe(600);
  });

  it('revises the stored painting (the server holds it, so only the intent is sent), with an opt-in look-and-repaint pass', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /Paint it/ }));
    fireEvent.click(screen.getByLabelText(/Look and repaint/));
    fireEvent.click(await screen.findByRole('button', { name: /Revise painting/ }));
    await waitFor(() => expect(api.drawTrackWaveform).toHaveBeenCalledTimes(2));
    expect(api.drawTrackWaveform.mock.calls[0][1].revise).toBeUndefined();
    expect(api.drawTrackWaveform.mock.calls[0][1].review).toBeUndefined();
    expect(api.drawTrackWaveform.mock.calls[1][1]).toMatchObject({ revise: true, review: true });
    expect(api.drawTrackWaveform.mock.calls[1][1].current).toBeUndefined();
  });

  it('plays and stops the synthesized painting in stereo', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /Paint it/ }));
    const playButton = await screen.findByRole('button', { name: /Play painting/ });
    await act(async () => {
      fireEvent.click(playButton);
      await Promise.resolve();
    });

    await screen.findByRole('button', { name: /Stop/ });
    const [source] = audio.sources;
    expect(source.start).toHaveBeenCalled();
    expect(source.buffer.length).toBe(44100);
    expect(source.buffer.numberOfChannels).toBe(2);

    fireEvent.click(screen.getByRole('button', { name: /Stop/ }));
    expect(source.stop).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Play painting/ })).toBeTruthy();
  });

  it('saves the stored painting as a take, titled from the painting when the user gave none', async () => {
    const onRendered = vi.fn();
    renderPanel({ onRendered });
    fireEvent.click(screen.getByRole('button', { name: /Paint it/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Save as take/ }));

    await waitFor(() => expect(onRendered).toHaveBeenCalledWith({ id: 'track-1' }));
    expect(api.renderTrackWaveform).toHaveBeenCalledWith('track-1', {
      prompt: 'glassy tidal ambient', title: 'Glass Tide',
    }, { silent: true });
  });
});
