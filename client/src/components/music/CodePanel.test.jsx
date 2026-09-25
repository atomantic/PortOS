import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import CodePanel from './CodePanel';
import * as api from '../../services/api';

vi.mock('../../services/api', () => ({
  writeMusicCode: vi.fn(),
  renderTrackCode: vi.fn(),
}));

// The real frame document loads Strudel from a CDN; the tests stub the frame
// and speak its postMessage protocol directly.
vi.mock('./strudelFrame', () => ({
  CODE_FRAME_SOURCE: 'portos-code-frame',
  STRUDEL_VERSION: '0.0.0-test',
  buildStrudelFrameDoc: () => '<!doctype html><title>stub</title>',
}));

const CODE = 'setcps(0.5)\nnote("c3 e3 g3").s("sawtooth")';

const renderPanel = (props = {}) => render(
  <CodePanel
    trackId="track-1"
    description="neon synthwave drive"
    lyrics=""
    title="Night Drive"
    providerId="provider-a"
    model="model-a"
    effort=""
    providerPicker={<div data-testid="picker" />}
    {...props}
  />,
);

const frame = () => screen.getByTitle(/Strudel .* player/);
// Deliver a message as if the frame had posted it.
const fromFrame = (data, source = frame().contentWindow) => act(() => {
  window.dispatchEvent(new MessageEvent('message', { data: { source: 'portos-code-frame', ...data }, source }));
});

describe('<CodePanel>', () => {
  let posted;
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    api.writeMusicCode.mockResolvedValue({ language: 'strudel', code: CODE, llm: { provider: 'provider-a', model: 'model-a' } });
    api.renderTrackCode.mockResolvedValue({ track: { id: 'track-1' }, filename: 'music-x.wav', durationSec: 4 });
  });
  afterEach(() => { cleanup(); });

  const mountReady = async (props) => {
    renderPanel(props);
    posted = vi.spyOn(frame().contentWindow, 'postMessage').mockImplementation(() => {});
    await fromFrame({ type: 'ready' });
  };

  it('runs the code only in an opaque-origin sandboxed frame', () => {
    renderPanel();
    // allow-same-origin would hand LLM code the PortOS origin: cookies, storage, and API.
    expect(frame().getAttribute('sandbox')).toBe('allow-scripts');
  });

  it('ships a frame document that blocks network access and pins the bundle by hash', async () => {
    const real = await vi.importActual('./strudelFrame');
    const doc = new DOMParser().parseFromString(real.buildStrudelFrameDoc(), 'text/html');
    const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    // connect-src none is what stops frame code from calling the PortOS API.
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("default-src 'none'");
    const bundle = doc.querySelector('script[src]');
    expect(bundle.getAttribute('src')).toBe(real.STRUDEL_BUNDLE_URL);
    expect(bundle.getAttribute('integrity')).toMatch(/^sha384-/);
  });

  it('writes code from the description with the chosen provider, then revises the edited code', async () => {
    await mountReady();
    fireEvent.change(screen.getByLabelText('Code guidance (optional)'), { target: { value: '124 BPM' } });
    fireEvent.click(screen.getByRole('button', { name: /Write the code/ }));

    await waitFor(() => expect(screen.getByLabelText('Strudel code')).toHaveValue(CODE));
    expect(api.writeMusicCode).toHaveBeenCalledWith({
      description: 'neon synthwave drive',
      lyrics: undefined,
      guidance: '124 BPM',
      language: 'strudel',
      providerId: 'provider-a',
      model: 'model-a',
      effort: undefined,
    }, { silent: true });

    const edited = `${CODE}.lpf(800)`;
    fireEvent.change(screen.getByLabelText('Strudel code'), { target: { value: edited } });
    fireEvent.click(screen.getByRole('button', { name: /Revise code/ }));
    await waitFor(() => expect(api.writeMusicCode).toHaveBeenCalledTimes(2));
    expect(api.writeMusicCode.mock.calls[1][0].current).toBe(edited);
  });

  it('plays and stops through the frame, and shows a thrown error inline', async () => {
    window.localStorage.setItem('portos.musicDesigner.strudelCode', JSON.stringify({ trackId: 'track-1', code: CODE }));
    await mountReady();
    expect(screen.getByLabelText('Strudel code')).toHaveValue(CODE);

    fireEvent.click(screen.getByRole('button', { name: /^Play$/ }));
    expect(posted).toHaveBeenLastCalledWith({ type: 'play', code: CODE }, '*');
    await fromFrame({ type: 'state', state: 'playing' });
    fireEvent.click(screen.getByRole('button', { name: /^Stop$/ }));
    expect(posted).toHaveBeenLastCalledWith({ type: 'stop' }, '*');

    await fromFrame({ type: 'error', message: 'note(...).nope is not a function' });
    expect(screen.getByRole('alert')).toHaveTextContent('note(...).nope is not a function');
    // A message from anywhere but our frame is ignored.
    await fromFrame({ type: 'error', message: 'spoofed' }, window);
    expect(screen.getByRole('alert')).not.toHaveTextContent('spoofed');
  });

  it('records the take in the frame and uploads it as a WAV to the draft track', async () => {
    window.localStorage.setItem('portos.musicDesigner.strudelCode', JSON.stringify({ trackId: 'track-1', code: CODE }));
    const onRendered = vi.fn();
    await mountReady({ onRendered });
    fireEvent.change(screen.getByLabelText('Take length (sec)'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: /Save as take/ }));
    expect(posted).toHaveBeenLastCalledWith({ type: 'record', code: CODE, seconds: 4 }, '*');
    expect(screen.getByRole('button', { name: /Recording/ })).toBeDisabled();

    await fromFrame({ type: 'recorded', wav: new ArrayBuffer(64), durationSec: 4 });
    await waitFor(() => expect(onRendered).toHaveBeenCalledWith({ id: 'track-1' }));
    const [trackId, form] = api.renderTrackCode.mock.calls[0];
    expect(trackId).toBe('track-1');
    expect(form.get('track').type).toBe('audio/wav');
    expect(form.get('prompt')).toBe('neon synthwave drive');
    expect(form.get('title')).toBe('Night Drive');
  });

  it('ends a failed recording without uploading', async () => {
    window.localStorage.setItem('portos.musicDesigner.strudelCode', JSON.stringify({ trackId: 'track-1', code: CODE }));
    await mountReady();
    fireEvent.click(screen.getByRole('button', { name: /Save as take/ }));
    await fromFrame({ type: 'error', message: 'The code played only silence, so there is nothing to save.' });
    expect(screen.getByRole('button', { name: /Save as take/ })).toBeEnabled();
    expect(api.renderTrackCode).not.toHaveBeenCalled();
  });
});
