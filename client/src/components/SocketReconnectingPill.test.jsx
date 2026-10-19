import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';

// Drive the shared socket's connect/disconnect handlers by hand so the test
// pins the pill's timing without a transport.
const handlers = new Map();
const socketState = { connected: false };
vi.mock('../services/socket', () => ({
  default: {
    get connected() { return socketState.connected; },
    on: (event, fn) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(fn);
    },
    off: (event, fn) => { handlers.get(event)?.delete(fn); },
  },
}));

const { default: SocketReconnectingPill, RECONNECTING_PILL_DELAY_MS } = await import('./SocketReconnectingPill.jsx');

const fire = (event) => act(() => {
  socketState.connected = event === 'connect';
  for (const fn of [...(handlers.get(event) || [])]) fn();
});
const advance = (ms) => act(() => { vi.advanceTimersByTime(ms); });
const pill = () => screen.queryByText('Reconnecting…');

beforeEach(() => {
  vi.useFakeTimers();
  handlers.clear();
  socketState.connected = false;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('SocketReconnectingPill', () => {
  it('appears only after the socket has been down for the full delay, and clears on reconnect', () => {
    render(<SocketReconnectingPill />);
    expect(pill()).toBeNull();

    advance(RECONNECTING_PILL_DELAY_MS - 1);
    expect(pill()).toBeNull();
    advance(1);
    expect(pill()).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting…');

    fire('connect');
    expect(pill()).toBeNull();
  });

  it('stays hidden for a blip that reconnects inside the delay', () => {
    socketState.connected = true;
    render(<SocketReconnectingPill />);
    advance(RECONNECTING_PILL_DELAY_MS * 2);
    expect(pill()).toBeNull();

    fire('disconnect');
    advance(RECONNECTING_PILL_DELAY_MS / 2);
    fire('connect');
    advance(RECONNECTING_PILL_DELAY_MS * 2);
    expect(pill()).toBeNull();
  });
});
