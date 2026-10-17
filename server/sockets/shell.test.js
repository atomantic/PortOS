import { describe, it, expect, vi, beforeEach } from 'vitest';

const createShellSession = vi.fn(() => 'sess-1');
vi.mock('../services/shell.js', () => ({
  createShellSession,
  submitToSession: vi.fn(),
  attachSession: vi.fn(),
  detachSocketSessions: vi.fn()
}));
vi.mock('../services/providers.js', () => ({ getProviderById: vi.fn() }));

const { registerShellHandlers } = await import('./shell.js');

const setup = () => {
  const handlers = {};
  const socket = { on: (event, fn) => { handlers[event] = fn; }, emit: vi.fn() };
  registerShellHandlers(socket, {});
  return { handlers, socket };
};

describe('shell:start payload validation', () => {
  beforeEach(() => createShellSession.mockClear());

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
});
