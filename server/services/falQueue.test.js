import { describe, it, expect, vi, afterEach } from 'vitest';
import { cancelFalRequest, submitFalRequest, awaitFalCompletion, createFalRequestEntry, hostFalDataUri } from './falQueue.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

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

  // The status read is allowed to start in the last moments of the budget.
  // COMPLETED that arrives after `deadline` is still a finished render (#12053).
  it('keeps a COMPLETED status that resolves after the deadline', async () => {
    vi.useFakeTimers();
    const start = Date.now();
    let releaseStatus;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => {
      releaseStatus = resolve;
    })));
    const entry = createFalRequestEntry('test-key');
    entry.cancelUrl = 'https://queue.fal.run/example/requests/abc/cancel';
    const pending = awaitFalCompletion({
      entry,
      statusUrl: 'https://queue.fal.run/example/status',
      apiKey: 'test-key',
      deadline: start + 50,
      timeoutMs: 50,
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(200);
    releaseStatus({ ok: true, json: async () => ({ status: 'COMPLETED' }) });

    await expect(pending).resolves.toEqual({ outcome: 'completed' });
    expect(entry.remoteTerminal).toBe(true);
    expect(entry.canceledRemote).toBeFalsy();
  });
});

describe('hostFalDataUri', () => {
  const dummyDataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  it('retries on transient failure and returns uploaded file url on retry', async () => {
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      callCount += 1;
      if (url.includes('/storage/upload/initiate')) {
        if (callCount === 1) {
          return { ok: false, status: 502, json: async () => ({}) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            upload_url: 'https://fal.media/upload/target',
            file_url: 'https://fal.media/files/uploaded.png',
          }),
        };
      }
      if (url === 'https://fal.media/upload/target' && opts.method === 'PUT') {
        return { ok: true, status: 200 };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const result = await hostFalDataUri({
      apiKey: 'test-key',
      dataUri: dummyDataUri,
      fileName: 'test-img',
      maxRetries: 2,
    });

    expect(result).toBe('https://fal.media/files/uploaded.png');
    expect(callCount).toBe(3); // 1st initiate (failed) + 2nd initiate (ok) + PUT (ok)
  });

  it('aborts immediately and does not retry when signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(hostFalDataUri({
      apiKey: 'test-key',
      dataUri: dummyDataUri,
      fileName: 'test-img',
      signal: controller.signal,
    })).rejects.toThrow();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts retry backoff sleep when signal aborts during delay', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => {
      setTimeout(() => controller.abort(), 10);
      return { ok: false, status: 502, json: async () => ({}) };
    }));

    const start = Date.now();
    await expect(hostFalDataUri({
      apiKey: 'test-key',
      dataUri: dummyDataUri,
      fileName: 'test-img',
      signal: controller.signal,
    })).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(350);
  });

  it('retries when reading initiate response body suffers a transient network failure', async () => {
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      callCount += 1;
      if (url.includes('/storage/upload/initiate')) {
        if (callCount === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => {
              const err = new Error('fetch failed');
              err.cause = new Error('UND_ERR_SOCKET');
              throw err;
            },
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            upload_url: 'https://fal.media/upload/target',
            file_url: 'https://fal.media/files/uploaded.png',
          }),
        };
      }
      if (url === 'https://fal.media/upload/target' && opts.method === 'PUT') {
        return { ok: true, status: 200 };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const result = await hostFalDataUri({
      apiKey: 'test-key',
      dataUri: dummyDataUri,
      fileName: 'test-img',
      maxRetries: 2,
    });
    expect(result).toBe('https://fal.media/files/uploaded.png');
    expect(callCount).toBe(3);
  });

  it('throws without retry on malformed JSON response body', async () => {
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      callCount += 1;
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token in JSON');
        },
      };
    }));

    await expect(hostFalDataUri({
      apiKey: 'test-key',
      dataUri: dummyDataUri,
      fileName: 'test-img',
    })).rejects.toThrow(/malformed JSON response/);

    expect(callCount).toBe(1);
  });

  it('throws without retry on permanent error like 400', async () => {
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      callCount += 1;
      return { ok: false, status: 400, json: async () => ({ detail: 'invalid' }) };
    }));

    await expect(hostFalDataUri({
      apiKey: 'test-key',
      dataUri: dummyDataUri,
      fileName: 'test-img',
    })).rejects.toThrow(/HTTP 400/);

    expect(callCount).toBe(1);
  });
});
