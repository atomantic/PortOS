import { describe, expect, it, vi } from 'vitest';
import { __testing } from './browserUpdateRestart.js';

const { createBrowserRestartController } = __testing;

const ready = proof => ({ state: 'restart-required', runningVersion: '1.0.0.1', installedVersion: '1.0.0.2', channel: 'stable', supervisorPid: 42, proof });
function fixture() {
  let clock = 1000;
  let count = 0;
  const readStatus = vi.fn().mockResolvedValue(ready('observed-identity'));
  const pm2Restart = vi.fn();
  const scheduled = [];
  const notify = vi.fn();
  const readSupervisor = vi.fn().mockResolvedValue({ status: 'online', pid: 43 });
  const restart = vi.fn(async ({ beforeRestart, afterRestart }) => {
    await beforeRestart();
    pm2Restart();
    return afterRestart({ connected: true });
  });
  const controller = createBrowserRestartController({ readStatus, restart, readSupervisor, now: () => clock, newToken: () => `ticket-${++count}`,
    schedule: callback => { scheduled.push(callback); }, notify });
  return { controller, readStatus, restart, pm2Restart, scheduled, notify, advance: ms => { clock += ms; } };
}

describe('browser update restart confirmation', () => {
  it('checks fresh local evidence and consumes the ticket before restarting', async () => {
    const { controller, readStatus, pm2Restart } = fixture();
    const preflight = await controller.prepare();
    expect(preflight).toMatchObject({ state: 'restart-required', ticket: 'ticket-1' });
    expect(preflight).not.toHaveProperty('proof');
    expect(preflight).not.toHaveProperty('supervisorPid');
    const result = await controller.confirm(preflight.ticket);
    expect(result).toMatchObject({ connected: true, updateVerification: { state: 'pending' } });
    expect(readStatus.mock.calls[0][0]).toEqual({ includePublished: false, includeProof: true });
    expect(pm2Restart).toHaveBeenCalledOnce();
    await expect(controller.confirm(preflight.ticket)).rejects.toMatchObject({ status: 409 });
    expect(pm2Restart).toHaveBeenCalledOnce();
  });

  it('invalidates cached update evidence even when a fresh check is unverified', async () => {
    const { controller, readStatus, notify } = fixture();
    readStatus.mockRejectedValue(new Error('not available'));
    expect(await controller.prepare()).toEqual({ state: 'unverified', ticket: null });
    expect(notify).toHaveBeenCalledOnce();
  });

  it('refuses expired, changed or unverified evidence without restarting', async () => {
    const expired = fixture();
    const old = await expired.controller.prepare();
    expired.advance(120_000);
    await expect(expired.controller.confirm(old.ticket)).rejects.toMatchObject({ status: 409 });
    expect(expired.pm2Restart).not.toHaveBeenCalled();

    const changed = fixture();
    const ticket = await changed.controller.prepare();
    changed.readStatus.mockResolvedValue({ state: 'unverified' });
    await expect(changed.controller.confirm(ticket.ticket)).rejects.toMatchObject({ status: 409 });
    expect(changed.pm2Restart).not.toHaveBeenCalled();
    expect(await changed.controller.prepare()).toEqual({ state: 'unverified', ticket: null });

    const replaced = fixture();
    const replacement = await replaced.controller.prepare();
    replaced.readStatus.mockResolvedValue(ready('different-identity'));
    await expect(replaced.controller.confirm(replacement.ticket)).rejects.toMatchObject({ status: 409 });
    expect(replaced.pm2Restart).not.toHaveBeenCalled();
  });

  it('rejects concurrent confirmations before either can start another restart', async () => {
    const { controller, readStatus, pm2Restart } = fixture();
    const first = await controller.prepare();
    const second = await controller.prepare();
    let finish;
    readStatus.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = controller.confirm(first.ticket);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await expect(controller.confirm(second.ticket)).rejects.toMatchObject({ status: 409 });
    expect(pm2Restart).not.toHaveBeenCalled();
    finish(ready('observed-identity'));
    await pending;
    expect(pm2Restart).toHaveBeenCalledOnce();
  });

  it('rejects a ticket that expires while its final check is in progress', async () => {
    const { controller, readStatus, pm2Restart, advance } = fixture();
    const preflight = await controller.prepare();
    let finish;
    readStatus.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = controller.confirm(preflight.ticket);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    advance(120_000);
    finish(ready('observed-identity'));
    await expect(pending).rejects.toMatchObject({ status: 409 });
    expect(pm2Restart).not.toHaveBeenCalled();
  });

  it('detects a delayed restart that loads an older installed browser than the reviewed version', async () => {
    const { controller, readStatus, scheduled, notify } = fixture();
    const preflight = await controller.prepare();
    await controller.confirm(preflight.ticket);
    const older = { state: 'current', runningVersion: '1.0.0.1', installedVersion: '1.0.0.1', channel: 'stable', supervisorPid: 43, proof: 'post-restart-identity' };
    readStatus.mockResolvedValueOnce({ ...older, state: 'configuration-mismatch' }).mockResolvedValueOnce(older);
    await scheduled.shift()();
    expect(controller.annotate(older)).not.toHaveProperty('restartVerification');
    await scheduled.shift()();
    expect(controller.annotate(older).restartVerification).toEqual({ state: 'older', expectedVersion: '1.0.0.2', expectedChannel: 'stable' });
    expect(controller.annotate(older)).not.toHaveProperty('proof');
    expect(controller.annotate(older)).not.toHaveProperty('supervisorPid');
    expect(notify).toHaveBeenCalledTimes(2);

    readStatus.mockResolvedValueOnce(ready('new-review'));
    const later = await controller.prepare();
    readStatus.mockResolvedValueOnce(ready('changed-before-restart'));
    await expect(controller.confirm(later.ticket)).rejects.toMatchObject({ status: 409 });
    expect(controller.annotate(older).restartVerification.state).toBe('older');

    expect(controller.annotate({ ...older, proof: 'a-later-browser-instance' })).not.toHaveProperty('restartVerification');
    expect(controller.annotate(older)).not.toHaveProperty('restartVerification');
  });

  it('does not attribute a later lifecycle action or supervisor to an earlier restart', async () => {
    const first = fixture();
    const preflight = await first.controller.prepare();
    await first.controller.confirm(preflight.ticket);
    first.controller.invalidate();
    await first.scheduled.shift()();
    expect(first.notify).toHaveBeenCalledOnce();

    const second = fixture();
    const ticket = await second.controller.prepare();
    await second.controller.confirm(ticket.ticket);
    second.readStatus.mockResolvedValue({ ...ready('other-supervisor'), supervisorPid: 44 });
    await second.scheduled.shift()();
    expect(second.controller.annotate({ ...ready('other-supervisor'), supervisorPid: 44 })).not.toHaveProperty('restartVerification');
  });

  it('ignores an in-flight follow-up after a different supervisor is observed', async () => {
    const { controller, readStatus, scheduled, notify } = fixture();
    const preflight = await controller.prepare();
    await controller.confirm(preflight.ticket);
    let finish;
    readStatus.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = scheduled.shift()();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    controller.annotate({ ...ready('different-supervisor'), supervisorPid: 44 });
    finish({ ...ready('old-supervisor'), supervisorPid: 43 });
    await expect(pending).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledOnce();
  });
});
