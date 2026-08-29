import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../services/socket', () => {
  const handlers = new Map();
  return {
    default: {
      emit: vi.fn(),
      on: vi.fn((event, fn) => handlers.set(event, fn)),
      off: vi.fn((event) => handlers.delete(event)),
      __fire: (event, payload) => handlers.get(event)?.(payload),
    },
  };
});

import socket from '../services/socket';
import VoiceCallHost from './VoiceCallHost';

const grantCapabilities = () => {
  vi.stubGlobal('MediaStreamTrackProcessor', function processor() {});
  vi.stubGlobal('MediaStreamTrackGenerator', function generator() {});
  vi.stubGlobal('AudioWorkletNode', function worklet() {});
  window.HTMLMediaElement.prototype.setSinkId = () => Promise.resolve();
  navigator.mediaDevices = { enumerateDevices: vi.fn(), getUserMedia: vi.fn() };
  // Mirrors the real API: the returned promise settles with the CALLBACK's
  // result, so a held lock never resolves it.
  navigator.locks = { request: vi.fn((_name, _options, fn) => Promise.resolve(fn(true))) };
};

const devices = [
  { label: 'BlackHole 16ch', kind: 'audioinput', deviceId: 'in-1' },
  { label: 'BlackHole 2ch', kind: 'audiooutput', deviceId: 'out-1' },
];

beforeEach(() => {
  vi.clearAllMocks();
  grantCapabilities();
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('VoiceCallHost', () => {
  it('says nothing reaches PortOS until the host is attached', () => {
    render(<VoiceCallHost />);
    expect(screen.getByText(/Not attached — no call audio reaches PortOS/)).toBeTruthy();
    expect(socket.emit).not.toHaveBeenCalledWith('voice:call:attach');
  });

  it('names every missing browser API at once instead of one per reload', async () => {
    vi.stubGlobal('MediaStreamTrackProcessor', undefined);
    vi.stubGlobal('AudioWorkletNode', undefined);
    render(<VoiceCallHost />);

    await act(async () => { fireEvent.click(screen.getByText('Attach call host')); });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/MediaStreamTrackProcessor/);
    expect(alert.textContent).toMatch(/AudioWorklet/);
    // Nothing was opened and nothing was claimed on a browser that cannot do it.
    expect(navigator.mediaDevices.enumerateDevices).not.toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalledWith('voice:call:attach');
  });

  it('refuses to open a device when another tab holds the lock', async () => {
    navigator.locks.request = vi.fn((_name, _options, fn) => Promise.resolve(fn(false)));
    render(<VoiceCallHost />);

    await act(async () => { fireEvent.click(screen.getByText('Attach call host')); });

    expect((await screen.findByRole('alert')).textContent).toMatch(/Another tab owns the call host/);
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('reports the specific missing device rather than a generic failure', async () => {
    navigator.mediaDevices.enumerateDevices.mockResolvedValue([devices[1]]);
    render(<VoiceCallHost />);

    await act(async () => { fireEvent.click(screen.getByText('Attach call host')); });

    expect((await screen.findByRole('alert')).textContent).toMatch(/BlackHole 16ch/);
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('opens the exact device with every processing stage off', async () => {
    navigator.mediaDevices.enumerateDevices.mockResolvedValue(devices);
    // getUserMedia succeeding is as far as jsdom goes; the AudioContext work
    // after it belongs to the browser, so the assertion is the constraint set.
    navigator.mediaDevices.getUserMedia.mockRejectedValue(new Error('no audio hardware'));
    render(<VoiceCallHost />);

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
    render(<VoiceCallHost />);

    act(() => socket.__fire('voice:call:state', { error: 'host-taken' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/Another tab owns the call host/);
  });

  it('reflects live call state once the server reports it attached', async () => {
    render(<VoiceCallHost />);

    act(() => socket.__fire('voice:call:state', { hostAttached: true, state: 'listening', active: true, turns: 2 }));

    expect(await screen.findByText(/Attached · call listening · 2 turns/)).toBeTruthy();
    expect(screen.getByText('Detach call host')).toBeTruthy();
  });

  it('detaches on unmount so a closed tab does not leave a phantom host', () => {
    const { unmount } = render(<VoiceCallHost />);
    unmount();
    expect(socket.emit).toHaveBeenCalledWith('voice:call:detach');
  });
});
