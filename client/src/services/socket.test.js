import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The transport is the one thing under test, so socket.io-client is replaced
// with a fake that records its options and exposes `connected` + `connect()`.
// Everything else socket.js wires at import (build-drift watcher, auth bounce)
// is mocked to its exported surface only.
const fake = vi.hoisted(() => ({ socket: null, ioOptions: null, guestRoute: false }));

vi.mock('socket.io-client', () => ({
  io: vi.fn((options) => {
    fake.ioOptions = options;
    fake.socket = {
      connected: false,
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
      connect: vi.fn(),
    };
    return fake.socket;
  }),
}));
vi.mock('../lib/publicGuestRoutes', () => ({ isPublicGuestRoute: () => fake.guestRoute }));
vi.mock('./apiSystem', () => ({ getSystemBuild: vi.fn(() => new Promise(() => {})) }));
vi.mock('./staleBuildToast', () => ({ showStaleBuildToast: vi.fn() }));
vi.mock('../components/ui/Toast', () => ({ default: { dismiss: vi.fn() } }));

const setVisibility = (state) => {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
};

const loadSocket = async () => {
  vi.resetModules();
  await import('./socket.js');
  return fake.socket;
};

beforeEach(() => {
  fake.guestRoute = false;
  setVisibility('visible');
});
afterEach(() => {
  // The module registers window/document listeners at import; a fresh module
  // per test adds another set, so drop the old socket's reach by replacing it.
  fake.socket = null;
});

describe('services/socket reconnect policy (#12027)', () => {
  it('retries forever with a capped backoff instead of giving up after ten attempts', async () => {
    await loadSocket();
    expect(fake.ioOptions).toMatchObject({
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelayMax: 10000,
    });
  });

  it('reconnects when the browser comes back online while the socket is down', async () => {
    const socket = await loadSocket();
    // The state the old attempt cap left behind: manager gave up, nothing
    // scheduled, `connected` false for the rest of the tab's life.
    socket.connected = false;
    window.dispatchEvent(new Event('online'));
    expect(socket.connect).toHaveBeenCalledTimes(1);
  });

  it('reconnects when the tab becomes visible while the socket is down', async () => {
    const socket = await loadSocket();
    socket.connected = false;
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(socket.connect).not.toHaveBeenCalled();

    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(socket.connect).toHaveBeenCalledTimes(1);
  });

  it('leaves a live socket alone', async () => {
    const socket = await loadSocket();
    socket.connected = true;
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(socket.connect).not.toHaveBeenCalled();
  });

  it('never opens the private socket from a hosted-audience route', async () => {
    fake.guestRoute = true;
    const socket = await loadSocket();
    expect(fake.ioOptions.autoConnect).toBe(false);
    socket.connected = false;
    window.dispatchEvent(new Event('online'));
    expect(socket.connect).not.toHaveBeenCalled();
  });
});
