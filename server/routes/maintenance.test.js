import { afterEach, describe, expect, it, vi } from 'vitest';
import { maintenance } from '../lib/maintenanceAdmission.js';
vi.mock('../services/maintenanceControl.js', () => ({ resumeMaintenance: async input => maintenance.resume(input) }));
import router from './maintenance.js';
const session = { enabled: true, authenticated: true, method: 'session' };
const call = (method, path, body, auth = session, address = '192.0.2.10') => new Promise(resolve => {
  const req = { app: { get: () => null }, method, url: path, body, headers: {}, socket: { remoteAddress: address }, portosAuthContext: auth };
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { resolve({ status: this.statusCode, body: value }); } };
  router.handle(req, res, err => resolve({ status: err?.status || 404, error: err }));
});
afterEach(() => {
  const hold = maintenance.status().hold;
  if (hold) maintenance.resume({ id: hold.id, revision: hold.revision });
});
describe('maintenance authority and stale mutations', () => {
  it.each(['peer', 'basic'])('does not grant host control to %s credentials', async method => {
    const result = await call('POST', '/maintenance', { reason: 'Work' }, { ...session, method });
    expect(result.status).toBe(403);
    expect(maintenance.status().state).toBe('normal');
  });
  it('requires local transport for a password-free installation', async () => {
    expect((await call('POST', '/maintenance', { reason: 'Work' }, { enabled: false })).status).toBe(403);
    const result = await call('POST', '/maintenance', { reason: 'Work' }, { enabled: false }, '127.0.0.1');
    expect(result.body).toMatchObject({ state: 'ready', hold: { owner: 'Local operator' } });
  });
  it('derives owner from authenticated context and refuses stale resume', async () => {
    expect((await call('POST', '/maintenance', { reason: 'Work', owner: 'Forged' })).status).toBe(400);
    const first = (await call('POST', '/maintenance', { reason: 'Work' })).body.hold;
    expect(first.owner).toBe('Operator session');
    const token = { id: first.id, revision: first.revision };
    expect((await call('POST', '/maintenance/resume', token)).body.state).toBe('normal');
    await call('POST', '/maintenance', { reason: 'Next work' });
    expect((await call('POST', '/maintenance/resume', token)).status).toBe(409);
    expect(maintenance.status().hold.reason).toBe('Next work');
  });
});
