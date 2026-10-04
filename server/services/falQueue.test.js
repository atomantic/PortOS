import { describe, it, expect, vi, afterEach } from 'vitest';
import { cancelFalRequest, submitFalRequest, awaitFalCompletion, createFalRequestEntry } from './falQueue.js';

afterEach(() => vi.unstubAllGlobals());

describe('awaitFalCompletion', () => {
  it.each(['COMPLETED', 'ERROR'])('waits for cancellation transport when concurrent status reports %s', async remoteStatus => {
    let completeStatus;
    let completeCancel;
    vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise(resolve => {
      if (options.method === 'PUT') completeCancel = resolve;
      else completeStatus = resolve;
    })));
    const entry = createFalRequestEntry('test-key');
    entry.cancelUrl = 'https://queue.fal.run/example/requests/abc/cancel';
    let settled = false;
    const poll = awaitFalCompletion({ entry, statusUrl: 'https://queue.fal.run/example/status',
      apiKey: 'test-key', deadline: Date.now() + 60_000, timeoutMs: 60_000,
    }).then(result => { settled = true; return result; });
    entry.aborted = true;
    const canceling = cancelFalRequest(entry);
    completeStatus({ ok: true, json: async () => ({ status: remoteStatus }) });
    await vi.waitFor(() => expect(entry.remoteTerminal).toBe(true));
    expect(settled).toBe(false);
    completeCancel({ ok: true });
    expect(await poll).toMatchObject({ outcome: remoteStatus === 'ERROR' ? 'failed' : 'canceled' });
    await canceling;
  });

  it.each(['lost response', 'missing receipt'])('retains an ambiguous paid submission: %s', async failure => {
    const { maintenance } = await import('../lib/maintenanceAdmission.js');
    const owner = maintenance.admit('media', failure);
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (failure === 'lost response') throw new Error('Connection lost');
      return { ok: true, status: 200, json: async () => ({}) };
    }));
    await expect(owner.run(() => submitFalRequest({ apiKey: 'test-key', modelId: 'example', body: {} }))).rejects.toThrow();
    await owner.finish();
    expect(maintenance.status().blockers).toContainEqual(expect.objectContaining({ resource: failure, unsettled: true }));
  });

  it('joins an in-flight cancel and retains uncertain remote ownership', async () => {
    const { maintenance } = await import('../lib/maintenanceAdmission.js');
    let completeCancel;
    const transport = new Promise(resolve => { completeCancel = resolve; });
    const fetchMock = vi.fn(() => transport);
    vi.stubGlobal('fetch', fetchMock);
    const owner = maintenance.admit('media', 'fal-cancel-test');
    const entry = createFalRequestEntry('test-key');
    entry.cancelUrl = 'https://queue.fal.run/example/requests/abc/cancel';
    entry.aborted = true;
    const canceling = cancelFalRequest(entry);
    let settled = false;
    const poll = owner.run(() => awaitFalCompletion({
      entry, statusUrl: 'unused', apiKey: 'test-key',
      deadline: Date.now() + 60_000, timeoutMs: 60_000,
    })).then(() => { settled = true; });
    const status = maintenance.begin({ reason: 'cancel transport test', owner: 'test' });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(status.state).toBe('draining');
    completeCancel({ ok: true });
    await Promise.all([canceling, poll]);
    await owner.finish();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(maintenance.status().blockers).toContainEqual(expect.objectContaining({ resource: 'fal-cancel-test', unsettled: true }));
    maintenance.resume({ id: status.hold.id, revision: status.hold.revision });
  });

  // A cancel that lands while submit is in flight finds no cancel_url, so the
  // remote cancel is a no-op; the receipt arrives afterwards. The paid render
  // must still be cancelled remotely instead of left queued at fal.ai.
  it('sends the remote cancel when the job was cancelled before the receipt arrived', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const entry = createFalRequestEntry('test-key');
    entry.aborted = true;
    entry.cancelUrl = 'https://queue.fal.run/example/requests/abc/cancel';

    const result = await awaitFalCompletion({
      entry, statusUrl: 'https://queue.fal.run/example/requests/abc/status',
      apiKey: 'test-key', deadline: Date.now() + 60_000, timeoutMs: 60_000,
    });

    expect(result).toEqual({ outcome: 'canceled' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(entry.cancelUrl);
    expect(fetchMock.mock.calls[0][1].method).toBe('PUT');
  });
});
