import { afterEach, describe, expect, it, vi } from 'vitest';
import { maintenance } from '../lib/maintenanceAdmission.js';
vi.mock('../services/maintenanceControl.js', async original => ({
  ...await original(), resumeMaintenance: async input => maintenance.resume(input),
}));
const { getAgentRecord, getTaskById } = vi.hoisted(() => ({ getAgentRecord: vi.fn(), getTaskById: vi.fn() }));
vi.mock('../services/cos/cosAgentLifecycle.js', () => ({ getAgentRecord }));
vi.mock('../services/cos/cosTaskStore.js', () => ({ getTaskById }));
import router from './maintenance.js';
import { hostControlRouteGate } from '../services/authGate.js';
const session = { enabled: true, authenticated: true, method: 'session' };
// hostControlRouteGate (#16018) is what refuses these writes to a non-operator caller.
const call = (method, path, body, auth = session, address = '192.0.2.10') => new Promise(resolve => {
  const req = { app: { get: () => null }, method, url: path, path: `/api/system${path}`, body, headers: {}, socket: { remoteAddress: address }, portosAuthContext: auth };
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { resolve({ status: this.statusCode, body: value }); } };
  const fail = err => resolve({ status: err?.status || 404, error: err });
  hostControlRouteGate(req, res, err => (err ? fail(err) : router.handle(req, res, fail)));
});
afterEach(() => {
  const hold = maintenance.status().hold;
  if (hold) maintenance.resume({ id: hold.id, revision: hold.revision });
});
describe('maintenance authority and stale mutations', () => {
  it('returns terminal runner evidence only to an operator under a normal hold', async () => {
    const path = '/maintenance/runner-owner/agent-fixture';
    expect((await call('GET', path)).status).toBe(409);
    const { body: { hold } } = await call('POST', '/maintenance', { reason: 'Recovery' });
    expect((await call('GET', path, null, { ...session, method: 'peer' })).status).toBe(403);
    expect((await call('GET', path, null, { enabled: false })).status).toBe(403);
    expect(getAgentRecord).not.toHaveBeenCalled();
    const owner = { id: 'agent-fixture', pid: 42, completedAt: '2026-01-01T00:00:00Z' };
    getAgentRecord.mockResolvedValueOnce({ ...owner, status: 'running' });
    expect((await call('GET', path)).body.owner).toBeNull();
    getAgentRecord.mockResolvedValue({ ...owner, status: 'completed', taskId: 'task-fixture', workspacePath: '/work/example',
      metadata: { providerId: 'provider-fixture' }, output: 'private output' });
    getTaskById.mockResolvedValueOnce({ id: 'task-fixture', taskType: 'user', description: 'Review and publish a release' });
    expect((await call('GET', path)).body.owner).toBeNull();
    getTaskById.mockResolvedValueOnce({ id: 'task-fixture', taskType: 'user', description: 'Review documentation' });
    expect(await call('GET', path)).toEqual({ status: 200, body: { hold: { id: hold.id, revision: hold.revision },
      owner: { ...owner, workspacePath: '/work/example', metadata: { providerId: 'provider-fixture' } } } });
  });
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
