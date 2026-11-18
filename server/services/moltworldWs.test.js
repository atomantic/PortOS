import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAccountWithCredentials } from './platformAccounts.js';
import { connect, disconnect, getStatus, moltworldWsEvents } from './moltworldWs.js';

vi.mock('./platformAccounts.js', () => ({ getAccountWithCredentials: vi.fn() }));
vi.mock('./agent/agentActivity.js', () => ({ logActivity: vi.fn() }));

const sockets = [];
const credentials = {
  platform: 'moltworld',
  status: 'active',
  credentials: { agentId: 'example-agent', username: 'Example Agent' }
};

function MockWebSocket() {
  const socket = new EventTarget();
  socket.readyState = MockWebSocket.CONNECTING;
  socket.send = vi.fn();
  socket.close = () => {
    socket.readyState = MockWebSocket.CLOSED;
    socket.dispatchEvent(new CloseEvent('close', { code: 1000 }));
  };
  socket.open = () => {
    socket.readyState = MockWebSocket.OPEN;
    socket.dispatchEvent(new Event('open'));
  };
  socket.acknowledgeHello = () => {
    socket.dispatchEvent(new MessageEvent('message', { data: '{"type":"hello_ack"}' }));
  };
  sockets.push(socket);
  return socket;
}

MockWebSocket.CONNECTING = 0;
MockWebSocket.OPEN = 1;
MockWebSocket.CLOSED = 3;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', MockWebSocket);
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  getAccountWithCredentials.mockResolvedValue(credentials);
});

afterEach(() => {
  disconnect();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  sockets.length = 0;
});

async function beginConnection() {
  const result = connect('example-account');
  await Promise.resolve();
  return { result, socket: sockets.at(-1) };
}

describe('Moltworld WebSocket connection lifecycle', () => {
  it('discards non-object JSON and continues dispatching valid frames', async () => {
    const { result, socket } = await beginConnection();
    socket.open();
    await result;
    socket.acknowledgeHello();

    const onEvent = vi.fn();
    const onPresence = vi.fn();
    moltworldWsEvents.on('event', onEvent);
    moltworldWsEvents.on('presence', onPresence);
    try {
      const status = getStatus();
      await vi.advanceTimersByTimeAsync(1);
      for (const value of [null, [], 'presence', 42, true]) {
        socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
      }
      expect(getStatus()).toEqual(status);
      expect(socket.readyState).toBe(MockWebSocket.OPEN);
      expect(onEvent).not.toHaveBeenCalled();
      expect(onPresence).not.toHaveBeenCalled();

      const presence = { type: 'presence', agents: [] };
      socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(presence) }));
      expect(onEvent).toHaveBeenCalledExactlyOnceWith(presence);
      expect(onPresence).toHaveBeenCalledExactlyOnceWith(presence);
      expect(getStatus().lastEvent).toBe(Date.now());
    } finally {
      moltworldWsEvents.off('event', onEvent);
      moltworldWsEvents.off('presence', onPresence);
    }
  });

  it('recovers after an established socket errors and ignores its later close', async () => {
    const { result, socket } = await beginConnection();
    socket.open();
    await result;
    socket.acknowledgeHello();

    socket.dispatchEvent(new Event('error'));
    socket.close();
    expect(getStatus()).toMatchObject({ status: 'reconnecting', reconnectAttempts: 1, connectedAt: null });

    await vi.advanceTimersByTimeAsync(1500);
    expect(sockets).toHaveLength(2);
    const retry = sockets.at(-1);
    retry.open();
    expect(retry.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'hello', agentId: 'example-agent', name: 'Example Agent'
    }));
    retry.acknowledgeHello();
    expect(getStatus()).toMatchObject({ status: 'connected', reconnectAttempts: 0 });
  });

  it('rejects an initial hello send failure and never emits a connected status', async () => {
    const { result, socket } = await beginConnection();
    socket.send.mockImplementation(() => { throw new Error('transport failed'); });
    const statusListener = vi.fn();
    moltworldWsEvents.on('status', statusListener);
    try {
      socket.open();
      await expect(result).rejects.toThrow('WebSocket hello failed: transport failed');
      expect(statusListener.mock.calls.map(([state]) => state.status)).toEqual(['disconnected']);
      expect(getStatus()).toMatchObject({ status: 'disconnected', connectedAt: null });
      expect(socket.readyState).toBe(MockWebSocket.CLOSED);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      moltworldWsEvents.off('status', statusListener);
    }
  });

  it('rejects a close before hello and clears the handshake timeout', async () => {
    const { result, socket } = await beginConnection();
    socket.close();
    await expect(result).rejects.toThrow('WebSocket closed before hello');
    expect(getStatus().status).toBe('disconnected');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('continues backoff when a retry times out or its hello send fails', async () => {
    const { result, socket } = await beginConnection();
    socket.open();
    await result;
    socket.dispatchEvent(new Event('error'));

    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(10000);
    expect(getStatus()).toMatchObject({ status: 'reconnecting', reconnectAttempts: 2 });

    await vi.advanceTimersByTimeAsync(3000);
    const retry = sockets.at(-1);
    retry.send.mockImplementation(() => { throw new Error('transport failed'); });
    retry.open();
    expect(retry.readyState).toBe(MockWebSocket.CLOSED);
    expect(getStatus()).toMatchObject({ status: 'reconnecting', reconnectAttempts: 3 });
  });

  it('caps unrefed, jittered retries when the relay closes without acknowledging hello', async () => {
    const { result, socket } = await beginConnection();
    socket.open();
    await result;
    const timer = vi.spyOn(globalThis, 'setTimeout');
    socket.close();
    const firstRetry = timer.mock.results.at(-1).value;
    expect(firstRetry.hasRef()).toBe(false);

    await vi.advanceTimersByTimeAsync(1499);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);

    // All retries open the transport but fail to establish the application session.
    for (let retry = 1; retry <= 10; retry++) {
      const pending = sockets.at(-1);
      pending.open();
      pending.close();
      if (retry < 10) {
        await vi.advanceTimersToNextTimerAsync();
      }
    }
    expect(sockets).toHaveLength(11);
    expect(getStatus()).toMatchObject({ status: 'disconnected', reconnectAttempts: 10, connectedAt: null });
    expect(vi.getTimerCount()).toBe(0);
    expect(timer.mock.calls.map(([, delay]) => delay)).toContain(45000);
    expect(timer.mock.calls.every(([, delay]) => delay <= 60000)).toBe(true);
  });

  it('cancels a pending connection and stops a scheduled retry on disconnect', async () => {
    const pending = await beginConnection();
    disconnect();
    await expect(pending.result).rejects.toThrow('WebSocket connection cancelled');
    expect(pending.socket.readyState).toBe(MockWebSocket.CLOSED);
    expect(vi.getTimerCount()).toBe(0);

    const { result, socket } = await beginConnection();
    socket.open();
    await result;
    socket.dispatchEvent(new Event('error'));
    disconnect();
    socket.dispatchEvent(new Event('error'));
    await vi.advanceTimersByTimeAsync(60000);
    expect(sockets).toHaveLength(2);
    expect(getStatus()).toMatchObject({ status: 'disconnected', reconnectAttempts: 0 });
  });

  it('ignores a credential lookup superseded by a later connect', async () => {
    const lookup = Promise.withResolvers();
    getAccountWithCredentials.mockReturnValueOnce(lookup.promise);
    const superseded = connect('example-old-account');
    const { result, socket } = await beginConnection();
    socket.open();
    await result;
    lookup.resolve(credentials);

    await expect(superseded).rejects.toThrow('WebSocket connection cancelled');
    expect(sockets).toHaveLength(1);
    expect(getStatus()).toMatchObject({ status: 'connected', accountId: 'example-account' });
  });
});
