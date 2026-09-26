import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../services/api', () => ({
  getLoops: vi.fn(() => Promise.resolve([])),
  getLoopProviders: vi.fn(() => Promise.resolve({ providers: [] })),
  createLoop: vi.fn(() => Promise.resolve({})),
  stopLoop: vi.fn(() => Promise.resolve({})),
  resumeLoop: vi.fn(() => Promise.resolve({})),
  deleteLoop: vi.fn(() => Promise.resolve({})),
  triggerLoop: vi.fn(() => Promise.resolve({})),
}));

vi.mock('../services/socket', () => ({
  default: { connected: true, on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));

import Loops from './Loops';
import socket from '../services/socket';
import * as api from '../services/api';

describe('Loops reconnect resubscribe (#8110)', () => {
  // The server rebuilds an empty per-socket subscriber Set on every reconnect
  // (restart, self-update, sleep, a network blip). Without a reconnect-driven
  // re-subscribe, the live output and status streams went silent for the rest
  // of the tab's life after the first reconnect.
  it('re-subscribes loops:* and refetches the list on a socket reconnect', async () => {
    render(<Loops />);
    await screen.findByText('No loops yet');
    expect(socket.emit).toHaveBeenCalledWith('loops:subscribe');
    const getLoopsCalls = api.getLoops.mock.calls.length;

    const connectHandler = socket.on.mock.calls.find(([event]) => event === 'connect')?.[1];
    expect(connectHandler).toBeTypeOf('function');
    socket.emit.mockClear();
    await act(async () => connectHandler());

    expect(socket.emit).toHaveBeenCalledWith('loops:subscribe');
    await waitFor(() => expect(api.getLoops.mock.calls.length).toBeGreaterThan(getLoopsCalls));
  });
});

describe('Loops new-loop form label associations', () => {
  it('pairs the Interval label with the custom-interval input via explicit htmlFor/id', async () => {
    render(<Loops />);
    const input = await screen.findByLabelText('Interval');
    const label = screen.getByText('Interval');
    expect(input.tagName).toBe('INPUT');
    expect(input.getAttribute('placeholder')).toBe('custom');
    // Prove the explicit htmlFor/id pairing (not merely an aria-label match).
    expect(input.id).toBeTruthy();
    expect(label.getAttribute('for')).toBe(input.id);
  });
});

describe('Loops index empty state', () => {
  it('offers a call to action that focuses the new-loop prompt', async () => {
    render(<Loops />);
    expect(await screen.findByText('No loops yet')).toBeInTheDocument();
    const cta = screen.getByRole('button', { name: 'Describe your first loop' });
    await userEvent.click(cta);
    expect(screen.getByLabelText('Loop prompt')).toHaveFocus();
  });
});
