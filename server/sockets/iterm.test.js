import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const bridge = {
  subscribeItermList: vi.fn(),
  unsubscribeItermList: vi.fn(),
  attachItermViewer: vi.fn(),
  detachItermViewer: vi.fn(),
  sendItermInput: vi.fn(),
  detachItermSocket: vi.fn()
};
vi.mock('../services/itermBridge.js', () => bridge);

const { registerItermHandlers, detachItermSocket } = await import('./iterm.js');

const ID = 'iterm-1A2B3C4D-0000-1111-2222-333344445555';

const setup = () => {
  const handlers = {};
  const socket = { on: (event, fn) => { handlers[event] = fn; }, emit: vi.fn() };
  registerItermHandlers(socket);
  return { handlers, socket };
};

const expectValidationError = (socket, id) => {
  expect(socket.emit).toHaveBeenCalledTimes(1);
  const [channel, body] = socket.emit.mock.calls[0];
  expect(channel).toBe('iterm:error');
  expect(body.code).toBe('VALIDATION_ERROR');
  expect(body.id).toBe(id);
};

describe('iterm socket handlers', () => {
  beforeEach(() => {
    for (const fn of Object.values(bridge)) fn.mockReset();
    bridge.subscribeItermList.mockResolvedValue();
    bridge.unsubscribeItermList.mockResolvedValue();
  });

  describe('iterm:list / iterm:unlist', () => {
    it('delegates to the bridge with the socket', () => {
      const { handlers, socket } = setup();
      handlers['iterm:list']();
      handlers['iterm:unlist']();
      expect(bridge.subscribeItermList).toHaveBeenCalledWith(socket);
      expect(bridge.unsubscribeItermList).toHaveBeenCalledWith(socket);
    });

    describe('rejection containment', () => {
      let errorSpy;
      let unhandled;
      const onUnhandled = (reason) => { unhandled.push(reason); };
      beforeEach(() => {
        unhandled = [];
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        process.on('unhandledRejection', onUnhandled);
      });
      afterEach(() => {
        process.off('unhandledRejection', onUnhandled);
        errorSpy.mockRestore();
      });

      it('logs a rejected subscribe/unsubscribe without an unhandled rejection', async () => {
        bridge.subscribeItermList.mockRejectedValue(new Error('bridge down'));
        bridge.unsubscribeItermList.mockRejectedValue(new Error('bridge gone'));
        const { handlers } = setup();
        handlers['iterm:list']();
        handlers['iterm:unlist']();
        await new Promise((resolve) => setImmediate(resolve));
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[iterm:list]: bridge down'));
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[iterm:unlist]: bridge gone'));
        expect(unhandled).toEqual([]);
      });
    });
  });

  describe('iterm:attach', () => {
    it('emits iterm:attached with the bridge result', () => {
      const attached = { id: ID, title: 'zsh' };
      bridge.attachItermViewer.mockReturnValue(attached);
      const { handlers, socket } = setup();
      handlers['iterm:attach']({ id: ID });
      expect(bridge.attachItermViewer).toHaveBeenCalledWith(ID, socket);
      expect(socket.emit).toHaveBeenCalledWith('iterm:attached', attached);
    });

    it('emits iterm:error when the session is missing', () => {
      bridge.attachItermViewer.mockReturnValue(null);
      const { handlers, socket } = setup();
      handlers['iterm:attach']({ id: ID });
      expect(socket.emit).toHaveBeenCalledTimes(1);
      expect(socket.emit).toHaveBeenCalledWith('iterm:error', { id: ID, error: 'iTerm2 session not found' });
    });

    it.each([undefined, null, {}, { id: 'shell-123' }, { id: 'iterm-' }, { id: `iterm-${'a'.repeat(65)}` }, { id: 42 }])(
      'rejects an invalid payload %j without touching the bridge',
      (payload) => {
        const { handlers, socket } = setup();
        handlers['iterm:attach'](payload);
        expectValidationError(socket, typeof payload?.id === 'string' ? payload.id : undefined);
        expect(bridge.attachItermViewer).not.toHaveBeenCalled();
      }
    );
  });

  describe('iterm:detach', () => {
    it('delegates a valid payload to the bridge', () => {
      const { handlers, socket } = setup();
      handlers['iterm:detach']({ id: ID });
      expect(bridge.detachItermViewer).toHaveBeenCalledWith(ID, socket);
      expect(socket.emit).not.toHaveBeenCalled();
    });

    it.each([undefined, {}, { id: '../etc' }])('rejects an invalid payload %j without touching the bridge', (payload) => {
      const { handlers, socket } = setup();
      handlers['iterm:detach'](payload);
      expectValidationError(socket, typeof payload?.id === 'string' ? payload.id : undefined);
      expect(bridge.detachItermViewer).not.toHaveBeenCalled();
    });
  });

  describe('iterm:input', () => {
    it('forwards authorized input as (id, data, socket) and emits nothing', () => {
      bridge.sendItermInput.mockReturnValue(true);
      const { handlers, socket } = setup();
      handlers['iterm:input']({ id: ID, data: 'ls -la\r' });
      expect(bridge.sendItermInput).toHaveBeenCalledWith(ID, 'ls -la\r', socket);
      expect(socket.emit).not.toHaveBeenCalled();
    });

    it('emits a not-viewing error when the bridge refuses the input', () => {
      bridge.sendItermInput.mockReturnValue(false);
      const { handlers, socket } = setup();
      handlers['iterm:input']({ id: ID, data: 'rm -rf /\r' });
      expect(socket.emit).toHaveBeenCalledTimes(1);
      expect(socket.emit).toHaveBeenCalledWith('iterm:error', { id: ID, error: 'Not viewing this iTerm2 session' });
    });

    it.each([
      ['missing data', { id: ID }],
      ['non-string data', { id: ID, data: 7 }],
      ['oversized data', { id: ID, data: 'x'.repeat(1_000_001) }],
      ['bad id', { id: 'shell-1', data: 'a' }],
      ['absent payload', undefined]
    ])('rejects %s without forwarding keystrokes', (_label, payload) => {
      const { handlers, socket } = setup();
      handlers['iterm:input'](payload);
      expectValidationError(socket, typeof payload?.id === 'string' ? payload.id : undefined);
      expect(bridge.sendItermInput).not.toHaveBeenCalled();
    });
  });

  it('detachItermSocket forwards the socket to the bridge', () => {
    bridge.detachItermSocket.mockReturnValue('detached');
    const socket = {};
    expect(detachItermSocket(socket)).toBe('detached');
    expect(bridge.detachItermSocket).toHaveBeenCalledWith(socket);
  });
});
