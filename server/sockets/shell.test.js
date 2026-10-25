import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';

const createShellSession = vi.fn(() => 'sess-1');
const resizeSession = vi.fn(() => true);
vi.mock('../services/shell.js', () => ({
  createShellSession,
  resizeSession,
  submitToSession: vi.fn(),
  attachSession: vi.fn(),
  detachSocketSessions: vi.fn()
}));
vi.mock('../lib/aiToolkit/internal/codexModelListProbe.js', () => ({ probeCodexModelsViaAppServer: vi.fn() }));
vi.mock('../services/providers.js', () => ({ getProviderById: vi.fn() }));

const { getProviderById } = await import('../services/providers.js');
const { probeCodexModelsViaAppServer } = await import('../lib/aiToolkit/internal/codexModelListProbe.js');
const { registerShellHandlers } = await import('./shell.js');

const setup = () => {
  const handlers = {};
  const socket = { on: (event, fn) => { handlers[event] = fn; }, emit: vi.fn() };
  registerShellHandlers(socket, {});
  return { handlers, socket };
};

describe('shell:start payload validation', () => {
  beforeEach(() => createShellSession.mockClear());

  it('validates the saved shell speed, records only the request and refuses unsupported authentication', async () => {
    const provider = { id: 'codex-tui', type: 'tui', command: 'codex', codexAuthMode: 'chatgpt', defaultModel: 'alpha', executionOptions: { serviceTier: 'fast' } };
    getProviderById.mockResolvedValue(provider);
    probeCodexModelsViaAppServer.mockResolvedValue({ accountType: 'chatgpt', requirements: null, config: {}, models: [{ id: 'alpha', serviceTiers: [{ id: 'fast' }] }] });
    const { handlers, socket } = setup();
    await handlers['shell:start']({ providerId: provider.id });
    expect(createShellSession).toHaveBeenCalledWith(socket, expect.objectContaining({ executionOptions: expect.objectContaining({ requested: { serviceTier: 'fast' }, effective: {}, confirmation: 'requested/unconfirmed' }) }));
    createShellSession.mockClear();
    probeCodexModelsViaAppServer.mockResolvedValue({ accountType: 'apiKey', config: {}, models: [] });
    await handlers['shell:start']({ providerId: provider.id });
    expect(createShellSession).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('shell:error', expect.objectContaining({ error: expect.stringContaining('ChatGPT') }));
  });

  it('rejects a non-string cwd on shell:error without creating a session', async () => {
    const { handlers, socket } = setup();
    await handlers['shell:start']({ cwd: { not: 'a string' } });
    expect(createShellSession).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('shell:error', expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });

  it('still starts a session for an absent payload', async () => {
    const { handlers, socket } = setup();
    await handlers['shell:start'](undefined);
    expect(createShellSession).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenCalledWith('shell:started', { sessionId: 'sess-1' });
  });

  it('starts the default shell across Socket.IO when the client emits undefined options', async () => {
    const http = createServer();
    const server = new Server(http);
    server.on('connection', registerShellHandlers);
    let client;
    try {
      http.listen(0, '127.0.0.1');
      await once(http, 'listening');
      client = connect(`http://127.0.0.1:${http.address().port}`, {
        transports: ['websocket'], reconnection: false
      });
      await once(client, 'connect');
      const started = once(client, 'shell:started', { signal: AbortSignal.timeout(2000) });
      // This is the Shell page's empty-options emit: the wire turns undefined into null.
      client.emit('shell:start', undefined);
      expect(await started).toEqual([{ sessionId: 'sess-1' }]);
      expect(createShellSession).toHaveBeenCalledTimes(1);
    } finally {
      client?.disconnect();
      await new Promise(resolve => server.close(resolve));
    }
  });
});

describe('shell:resize handler', () => {
  beforeEach(() => resizeSession.mockClear());

  it('resizes session when resizeSession succeeds', () => {
    resizeSession.mockReturnValueOnce(true);
    const { handlers, socket } = setup();
    handlers['shell:resize']({ sessionId: 'sess-1', cols: 100, rows: 30 });
    expect(resizeSession).toHaveBeenCalledWith('sess-1', 100, 30);
    expect(socket.emit).not.toHaveBeenCalledWith('shell:error', expect.anything());
  });

  it('emits shell:error when resizeSession returns false', () => {
    resizeSession.mockReturnValueOnce(false);
    const { handlers, socket } = setup();
    handlers['shell:resize']({ sessionId: 'sess-1', cols: 100, rows: 30 });
    expect(resizeSession).toHaveBeenCalledWith('sess-1', 100, 30);
    expect(socket.emit).toHaveBeenCalledWith('shell:error', {
      sessionId: 'sess-1',
      error: 'Session not found or resize failed'
    });
  });
});
