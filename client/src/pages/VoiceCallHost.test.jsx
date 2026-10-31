import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../services/socket', () => {
  const handlers = new Map();
  return {
    default: {
      emit: vi.fn(),
      connected: true,
      on: vi.fn((event, fn) => handlers.set(event, fn)),
      off: vi.fn((event) => handlers.delete(event)),
      __fire: (event, payload) => handlers.get(event)?.(payload),
    },
  };
});

import socket from '../services/socket';
import VoiceCallHost from './VoiceCallHost';

const grantCapabilities = () => {
  vi.stubGlobal('AudioWorkletNode', function worklet() {});
  window.HTMLMediaElement.prototype.setSinkId = () => Promise.resolve();
  navigator.mediaDevices = { enumerateDevices: vi.fn(), getUserMedia: vi.fn() };
  // Mirrors the real API: the returned promise settles with the CALLBACK's
  // result, so a held lock never resolves it. `defineProperty` rather than a plain
  // assignment — `navigator.locks` is a getter-only accessor in some DOM
  // implementations, where assigning to it throws (#6144).
  Object.defineProperty(navigator, 'locks', {
    value: { request: vi.fn((_name, _options, fn) => Promise.resolve(fn(true))) },
    configurable: true,
    writable: true,
  });
};

const devices = [
  { label: 'BlackHole 16ch', kind: 'audioinput', deviceId: 'in-1' },
  { label: 'BlackHole 2ch', kind: 'audiooutput', deviceId: 'out-1' },
];

const exclusiveLock = () => {
  let held = false;
  navigator.locks.request = vi.fn((_name, _options, fn) => {
    if (held) return Promise.resolve(fn(null));
    held = true;
    return Promise.resolve(fn(true)).then(() => { held = false; });
  });
};

const workletNodes = [];
const audioContext = ({ addModule = () => Promise.resolve() } = {}) => {
  const close = vi.fn(() => Promise.resolve());
  vi.stubGlobal('AudioContext', function FakeAudioContext() {
    this.sampleRate = 48000;
    this.audioWorklet = { addModule };
    this.createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() });
    this.close = close;
  });
  vi.stubGlobal('AudioWorkletNode', function FakeAudioWorkletNode() {
    this.port = { close: vi.fn() };
    this.disconnect = vi.fn();
    workletNodes.push(this);
  });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:call-host-worklet');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  return { close };
};

// Opens a full session (stream, context, lock) the way a real attach does, so
// server snapshots are received by the tab that owns the devices.
const startSession = async (label = 'Attach call host') => {
  exclusiveLock();
  navigator.mediaDevices.enumerateDevices.mockResolvedValue(devices);
  const track = { stop: vi.fn() };
  navigator.mediaDevices.getUserMedia.mockResolvedValue({ getTracks: () => [track] });
  const { close } = audioContext();
  const view = render(<VoiceCallHost />, {
    wrapper: ({ children }) => <MemoryRouter initialEntries={[label === 'Start capture' ? '/?mode=capture' : '/']}>{children}</MemoryRouter>,
  });
  await act(async () => { fireEvent.click(screen.getByText(label)); });
  return { track, close, ...view };
};

beforeEach(() => {
  vi.clearAllMocks();
  workletNodes.length = 0;
  socket.connected = true;
  grantCapabilities();
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('VoiceCallHost', () => {
  it('says nothing reaches PortOS until the host is attached', () => {
    render(<VoiceCallHost />, { wrapper: MemoryRouter });
    expect(screen.getByText(/Not attached — no call audio reaches PortOS/)).toBeTruthy();
    expect(socket.emit).not.toHaveBeenCalledWith('voice:call:attach');
  });

  it('names every missing browser API at once instead of one per reload', async () => {
    vi.stubGlobal('AudioWorkletNode', undefined);
    window.HTMLMediaElement.prototype.setSinkId = undefined;
    render(<VoiceCallHost />, { wrapper: MemoryRouter });

    await act(async () => { fireEvent.click(screen.getByText('Attach call host')); });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/AudioWorklet/);
    expect(alert.textContent).toMatch(/setSinkId/);
    // Nothing was opened and nothing was claimed on a browser that cannot do it.
    expect(navigator.mediaDevices.enumerateDevices).not.toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalledWith('voice:call:attach');
  });

  it('refuses to open a device when another tab holds the lock', async () => {
    navigator.locks.request = vi.fn((_name, _options, fn) => Promise.resolve(fn(false)));
    render(<VoiceCallHost />, { wrapper: MemoryRouter });

    await act(async () => { fireEvent.click(screen.getByText('Attach call host')); });

    expect((await screen.findByRole('alert')).textContent).toMatch(/Another tab owns the call host/);
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('reports the specific missing device rather than a generic failure', async () => {
    navigator.mediaDevices.enumerateDevices.mockResolvedValue([devices[1]]);
    render(<VoiceCallHost />, { wrapper: MemoryRouter });

    await act(async () => { fireEvent.click(screen.getByText('Attach call host')); });

    expect((await screen.findByRole('alert')).textContent).toMatch(/BlackHole 16ch/);
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('releases the lock after a missing device so a retry can open it', async () => {
    exclusiveLock();
    navigator.mediaDevices.enumerateDevices.mockResolvedValueOnce([devices[1]]).mockResolvedValue(devices);
    navigator.mediaDevices.getUserMedia.mockRejectedValue(new Error('permission denied'));
    render(<VoiceCallHost />, { wrapper: MemoryRouter });

    await act(async () => { fireEvent.click(screen.getByText('Attach call host')); });
    expect((await screen.findByRole('alert')).textContent).toMatch(/BlackHole 16ch/);
    await act(async () => { fireEvent.click(screen.getByText('Attach call host')); });

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect((await screen.findByRole('alert')).textContent).toMatch(/permission denied/);
  });

  it('releases the lock after permission denial so a retry requests permission again', async () => {
    exclusiveLock();
    navigator.mediaDevices.enumerateDevices.mockResolvedValue(devices);
    navigator.mediaDevices.getUserMedia.mockRejectedValue(new Error('permission denied'));
    render(<VoiceCallHost />, { wrapper: MemoryRouter });

    await act(async () => { fireEvent.click(screen.getByText('Attach call host')); });
    await act(async () => { fireEvent.click(screen.getByText('Attach call host')); });

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
    expect((await screen.findByRole('alert')).textContent).toMatch(/permission denied/);
  });

  it('stops a stream resolved after unmount without attaching a host', async () => {
    exclusiveLock();
    navigator.mediaDevices.enumerateDevices.mockResolvedValue(devices);
    let resolveStream;
    navigator.mediaDevices.getUserMedia.mockReturnValue(new Promise((resolve) => { resolveStream = resolve; }));
    const track = { stop: vi.fn() };
    const { unmount } = render(<VoiceCallHost />, { wrapper: MemoryRouter });

    await act(async () => { fireEvent.click(screen.getByText('Attach call host')); });
    unmount();
    await act(async () => { resolveStream({ getTracks: () => [track] }); });

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(socket.emit).not.toHaveBeenCalledWith('voice:call:attach');
    expect(socket.emit).not.toHaveBeenCalledWith('voice:capture:start');
  });

  it('cleans up a failed worklet load and releases the lock for retry', async () => {
    exclusiveLock();
    navigator.mediaDevices.enumerateDevices.mockResolvedValue(devices);
    const track = { stop: vi.fn() };
    navigator.mediaDevices.getUserMedia.mockResolvedValue({ getTracks: () => [track] });
    const { close } = audioContext({ addModule: () => Promise.reject(new Error('worklet unavailable')) });
    render(<VoiceCallHost />, { wrapper: MemoryRouter });

    await act(async () => { fireEvent.click(screen.getByText('Attach call host')); });
    expect((await screen.findByRole('alert')).textContent).toMatch(/worklet unavailable/);
    await act(async () => { fireEvent.click(screen.getByText('Attach call host')); });

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
    expect(track.stop).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
    expect(socket.emit).not.toHaveBeenCalledWith('voice:call:attach');
  });

  it('opens the exact device with every processing stage off', async () => {
    navigator.mediaDevices.enumerateDevices.mockResolvedValue(devices);
    // getUserMedia succeeding is as far as jsdom goes; the AudioContext work
    // after it belongs to the browser, so the assertion is the constraint set.
    navigator.mediaDevices.getUserMedia.mockRejectedValue(new Error('no audio hardware'));
    render(<VoiceCallHost />, { wrapper: MemoryRouter });

    await act(async () => { fireEvent.click(screen.getByText('Attach call host')); });

    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: {
        deviceId: { exact: 'in-1' },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/no audio hardware/);
  });

  it('surfaces the server refusing a second host', async () => {
    render(<VoiceCallHost />, { wrapper: MemoryRouter });

    act(() => socket.__fire('voice:call:state', { error: 'host-taken' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/Another tab owns the call host/);
  });

  it('reflects live call state once the server reports it attached', async () => {
    await startSession();

    act(() => socket.__fire('voice:call:state', { hostAttached: true, state: 'listening', active: true, turns: 2 }));

    expect(await screen.findByText(/Attached · call listening · 2 turns/)).toBeTruthy();
    expect(screen.getByText('Detach call host')).toBeTruthy();
  });

  it('pauses call audio when the server cancels a timed-out voice turn', async () => {
    const makeElement = () => ({
      addEventListener: vi.fn(),
      play: vi.fn(() => Promise.resolve()),
      pause: vi.fn(),
      setSinkId: vi.fn(() => Promise.resolve()),
      src: '',
    });
    const [first, second] = [makeElement(), makeElement()];
    const elements = [first, second];
    vi.stubGlobal('Audio', function FakeAudio() { return elements.shift(); });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:call-audio'),
      revokeObjectURL,
    });
    render(<VoiceCallHost />, { wrapper: MemoryRouter });

    act(() => {
      socket.__fire('voice:call:tts', { wav: new ArrayBuffer(8) });
      socket.__fire('voice:call:tts', { wav: new ArrayBuffer(8) });
    });
    await waitFor(() => expect(first.play).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(second.play).toHaveBeenCalledTimes(1));
    act(() => socket.__fire('voice:tts:cancel'));

    expect(first.pause).toHaveBeenCalledTimes(1);
    expect(second.pause).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it('detaches on unmount so a closed tab does not leave a phantom host', () => {
    const { unmount } = render(<VoiceCallHost />, { wrapper: MemoryRouter });
    unmount();
    expect(socket.emit).toHaveBeenCalledWith('voice:call:detach');
  });

  it('keeps one tab stop on the mode tabs and locks both once a host is attached (#7244)', async () => {
    render(<VoiceCallHost />, { wrapper: MemoryRouter });

    const call = screen.getByRole('tab', { name: 'Call' });
    const capture = screen.getByRole('tab', { name: 'Capture system audio' });
    expect(call).toHaveAttribute('tabindex', '0');
    expect(capture).toHaveAttribute('tabindex', '-1');

    // ArrowRight moves the tab stop and the mode together.
    call.focus();
    fireEvent.keyDown(call, { key: 'ArrowRight' });
    expect(capture).toHaveAttribute('aria-selected', 'true');
    expect(capture).toHaveAttribute('tabindex', '0');
    expect(document.activeElement).toBe(capture);
    expect(await screen.findByText('Start capture')).toBeTruthy();

  });

  it('locks both mode tabs while this tab owns an attached host (#7244)', async () => {
    await startSession();
    act(() => socket.__fire('voice:call:state', { hostAttached: true, state: 'listening' }));
    expect(screen.getByRole('tab', { name: 'Call' })).toBeDisabled();
    expect(screen.getByRole('tab', { name: 'Capture system audio' })).toBeDisabled();
  });

  describe('server refusal after start() (#14257)', () => {
    it('releases stream, context and lock on host-taken so a second Attach reaches getUserMedia', async () => {
      const { track, close } = await startSession();
      expect(socket.emit).toHaveBeenCalledWith('voice:call:attach');

      await act(async () => socket.__fire('voice:call:state', { error: 'host-taken' }));

      expect(track.stop).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(socket.emit).not.toHaveBeenCalledWith('voice:call:detach');
      await act(async () => { fireEvent.click(screen.getByText('Attach call host')); });
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
      expect(screen.queryByText(/Another tab owns the call host\. Close it/)).toBeNull();
    });

    it('releases on a capture-mode call-active refusal', async () => {
      const { track, close } = await startSession('Start capture');
      expect(socket.emit).toHaveBeenCalledWith('voice:capture:start');

      await act(async () => socket.__fire('voice:capture:state', { error: 'call-active' }));

      expect(track.stop).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      await act(async () => { fireEvent.click(screen.getByText('Start capture')); });
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
    });

    it('releases and shows the server message when voice mode is disabled', async () => {
      const { track, close } = await startSession();

      act(() => socket.__fire('voice:error', { stage: 'call', message: 'voice mode disabled' }));

      expect(track.stop).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect((await screen.findByRole('alert')).textContent).toMatch(/Voice mode is off/);
      await act(async () => { fireEvent.click(screen.getByText('Attach call host')); });
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
    });

    it('releases when a snapshot reports the host detached while this tab owns a session', async () => {
      const { track } = await startSession();
      act(() => socket.__fire('voice:call:state', { hostAttached: false, state: 'idle' }));
      expect(track.stop).toHaveBeenCalledTimes(1);
    });

    it('ignores the other mode\'s snapshot and unrelated voice errors', async () => {
      const { track } = await startSession();
      act(() => socket.__fire('voice:capture:state', { hostAttached: false }));
      act(() => socket.__fire('voice:error', { stage: 'turn', message: 'audio is required' }));
      expect(track.stop).not.toHaveBeenCalled();
    });

    it('never renders a tab that opened no device as attached to another tab\'s host', () => {
      render(<VoiceCallHost />, { wrapper: MemoryRouter });

      act(() => socket.__fire('voice:call:state', { hostAttached: true, state: 'listening' }));

      expect(screen.getByText(/Not attached/)).toBeTruthy();
      expect(screen.getByText('Attach call host')).toBeEnabled();
    });
  });
});

describe('socket reconnect while hosting (#14258)', () => {
  const reconnect = () => {
    act(() => { socket.connected = false; socket.__fire('disconnect'); });
    act(() => { socket.connected = true; socket.__fire('connect'); });
  };

  it('re-sends voice:capture:start after a reconnect and shows the resumed notice', async () => {
    await startSession('Start capture');
    act(() => socket.__fire('voice:capture:state', { hostAttached: true, active: true, turns: 1 }));
    socket.emit.mockClear();

    reconnect();

    expect(socket.emit).toHaveBeenCalledWith('voice:capture:start');
    expect(screen.getByText(/capture resumed/)).toBeTruthy();
  });

  it('re-sends voice:call:attach after a reconnect in call mode', async () => {
    await startSession();
    act(() => socket.__fire('voice:call:state', { hostAttached: true, state: 'listening' }));
    socket.emit.mockClear();

    reconnect();

    expect(socket.emit).toHaveBeenCalledWith('voice:call:attach');
  });

  it('does not re-attach on a connect that follows no drop', async () => {
    await startSession('Start capture');
    socket.emit.mockClear();
    act(() => socket.__fire('connect'));
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it('emits no audio frames while the socket is offline', async () => {
    await startSession();
    const onmessage = workletNodes[0].port.onmessage;
    const block = [new Float32Array(48000).fill(0.5)];
    socket.connected = false;
    act(() => onmessage({ data: block }));
    expect(socket.emit).not.toHaveBeenCalledWith('voice:call:audio', expect.anything());
    socket.connected = true;
    act(() => onmessage({ data: block }));
    expect(socket.emit).toHaveBeenCalledWith('voice:call:audio', expect.anything());
  });

  it('releases the session and shows the dropped notice when the re-attach is refused', async () => {
    const { track, close } = await startSession('Start capture');
    act(() => socket.__fire('voice:capture:state', { hostAttached: true, turns: 2 }));
    reconnect();

    await act(async () => socket.__fire('voice:capture:state', { error: 'host-taken' }));

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/capture before the drop was filed/)).toBeTruthy();
    expect(screen.queryByText(/Capturing/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('ignores the old socket\'s detach broadcast while the re-attach is pending', async () => {
    const { track } = await startSession();
    act(() => socket.__fire('voice:call:state', { hostAttached: true, state: 'listening' }));
    reconnect();
    act(() => socket.__fire('voice:call:state', { hostAttached: false, state: 'idle' }));
    expect(track.stop).not.toHaveBeenCalled();
    act(() => socket.__fire('voice:call:state', { hostAttached: true, state: 'listening' }));
    expect(screen.getByText(/Attached · call listening/)).toBeTruthy();
  });

  it('removes the connect/disconnect handlers and detaches once on unmount', async () => {
    const { unmount } = await startSession('Start capture');
    socket.emit.mockClear();
    unmount();
    expect(socket.off).toHaveBeenCalledWith('connect', expect.any(Function));
    expect(socket.off).toHaveBeenCalledWith('disconnect', expect.any(Function));
    expect(socket.emit.mock.calls.filter(([e]) => e === 'voice:capture:stop')).toHaveLength(1);
  });
});

describe('VoiceCallHost — meeting capture mode', () => {
  const renderCapturing = () => render(<VoiceCallHost />, {
    wrapper: ({ children }) => <MemoryRouter initialEntries={['/?mode=capture']}>{children}</MemoryRouter>,
  });

  it('is reachable by URL, needs no output device, and emits voice:capture:start (not voice:call:attach)', async () => {
    // Only the input half of the bridge exists — capture never plays a reply
    // back, so it must not block on a missing BlackHole 2ch. jsdom has no
    // real Web Audio API, so the pieces past getUserMedia are minimally
    // stubbed here (the existing call-mode tests instead stop the flow by
    // making getUserMedia reject — that would hide the emitted event name).
    navigator.mediaDevices.enumerateDevices.mockResolvedValue([
      { label: 'BlackHole 16ch', kind: 'audioinput', deviceId: 'in-1' },
    ]);
    navigator.mediaDevices.getUserMedia.mockResolvedValue({});
    vi.stubGlobal('AudioContext', function FakeAudioContext() {
      this.sampleRate = 48000;
      this.audioWorklet = { addModule: () => Promise.resolve() };
      this.createMediaStreamSource = () => ({ connect: () => {} });
      this.close = () => {};
    });
    vi.stubGlobal('AudioWorkletNode', function FakeAudioWorkletNode() {
      this.port = {};
      this.disconnect = () => {};
    });
    renderCapturing();

    await act(async () => { fireEvent.click(screen.getByText('Start capture')); });

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: {
        deviceId: { exact: 'in-1' },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(socket.emit).toHaveBeenCalledWith('voice:capture:start');
    expect(socket.emit).not.toHaveBeenCalledWith('voice:call:attach');
  });

  it('still requires the input device by name', async () => {
    navigator.mediaDevices.enumerateDevices.mockResolvedValue([]);
    renderCapturing();

    await act(async () => { fireEvent.click(screen.getByText('Start capture')); });

    expect((await screen.findByRole('alert')).textContent).toMatch(/microphone access/);
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('hides the test tone control — capture never plays anything back', () => {
    renderCapturing();
    expect(screen.queryByText('Test tone')).toBeNull();
  });

  it('reflects live capture state once the server reports it attached', async () => {
    await startSession('Start capture');

    act(() => socket.__fire('voice:capture:state', { hostAttached: true, active: true, turns: 3 }));

    expect(await screen.findByText(/Capturing · 3 utterances transcribed/)).toBeTruthy();
    expect(screen.getByText('Stop capture')).toBeTruthy();
  });

  it('surfaces the mutual-exclusion refusal when a call is active on this tab', async () => {
    renderCapturing();

    act(() => socket.__fire('voice:capture:state', { error: 'call-active' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/FaceTime call is active/);
  });

  it('stops the capture (not the call) on unmount', () => {
    const { unmount } = renderCapturing();
    unmount();
    expect(socket.emit).toHaveBeenCalledWith('voice:capture:stop');
    expect(socket.emit).not.toHaveBeenCalledWith('voice:call:detach');
  });
});
