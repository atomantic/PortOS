// The Security monitor pipes the host's microphone stream through its own
// AudioContext to the speakers. On iOS the document's default `auto` session is
// silenced by the hardware ring/silent switch, so a remote listen-in goes quiet
// while the level meter keeps moving — the page has to claim `playback` for as
// long as that graph is live, and hand it back the moment it isn't (#4131).
//
// jsdom has neither Web Audio nor a working HTMLMediaElement, so both are
// stubbed; the assertions read the declared session type off the stubbed
// `navigator.audioSession` the arbiter writes to.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

vi.mock('../services/api', () => ({
  default: {
    get: vi.fn(async () => ({ data: { video: [{ id: 'cam-1', name: 'Camera 1' }], audio: [{ id: 'mic-1', name: 'Mic 1' }] } })),
    post: vi.fn(async () => ({ data: {} })),
  },
}));

import Security from './Security.jsx';

class FakeAnalyser {
  constructor() { this.fftSize = 256; }
  getByteTimeDomainData() {}
  connect() { return this; }
}

class FakeAudioContext {
  constructor() { this.state = 'running'; this.destination = {}; this.closed = false; }
  createAnalyser() { return new FakeAnalyser(); }
  createMediaElementSource() { return { connect() { return this; } }; }
  resume() { return Promise.resolve(); }
  close() { this.closed = true; }
}

const sessionType = () => navigator.audioSession.type;

// Render, settle the mount-time device fetch, then start the stream — which is
// what builds the AudioContext graph the claim is scoped to.
const startMonitor = async () => {
  const view = render(<Security />);
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: /Start Media/i }));
  await waitFor(() => expect(sessionType()).toBe('playback'));
  return view;
};

describe('Security monitor iOS audio session', () => {
  beforeEach(() => {
    window.AudioContext = FakeAudioContext;
    navigator.audioSession = { type: 'auto' };
    // The level meter's rAF loop would otherwise run forever under jsdom.
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    window.HTMLMediaElement.prototype.play = vi.fn(async () => {});
    window.HTMLMediaElement.prototype.pause = vi.fn(() => {});
  });

  afterEach(() => {
    delete window.AudioContext;
    delete navigator.audioSession;
    vi.unstubAllGlobals();
  });

  it('claims playback once the monitor graph is live', async () => {
    await startMonitor();
    expect(sessionType()).toBe('playback');
  });

  // Holding it would follow the user (SPA, no reload) onto every other page and
  // refuse the globally-mounted VoiceWidget's microphone.
  it('hands the session back when the stream is stopped', async () => {
    await startMonitor();
    fireEvent.click(screen.getByRole('button', { name: /Stop Media/i }));
    await waitFor(() => expect(sessionType()).toBe('auto'));
  });

  it('hands the session back when the page unmounts while streaming', async () => {
    const { unmount } = await startMonitor();
    unmount();
    expect(sessionType()).toBe('auto');
  });
});
