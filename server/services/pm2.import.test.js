import { expect, it, vi } from 'vitest';

vi.mock('pm2', () => { throw new Error('Native PM2 client loaded before an RPC operation'); });

it('loads the service without constructing the socket-probing native PM2 singleton', async () => {
  const service = await import('./pm2.js');
  expect(service.getDaemonIdentity).toBeTypeOf('function');
  // The RPC boundary still loads the native client; it has not been disabled.
  await expect(service.stopApp('synthetic-process')).rejects.toThrow();
});
