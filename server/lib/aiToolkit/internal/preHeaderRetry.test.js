import { describe, expect, it, vi } from 'vitest';
import {
  describeTransportError,
  fetchWithPreHeaderRetry,
  isReplaySafeTransportError,
  isReplaySafeLocalRequest,
  isTransientGatewayStatus,
  isUnprocessedGoawayError,
} from './preHeaderRetry.js';

const response = (status, cancel = vi.fn()) => ({ status, body: { cancel } });

describe('pre-header retry policy', () => {
  it('preserves nested transport codes that undici hides under fetch failed', () => {
    const socketError = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED', message: 'connect refused' },
    });

    expect(describeTransportError(socketError)).toBe('fetch failed: ECONNREFUSED: connect refused');
  });

  it('retries only the allowlisted gateway statuses and cancels failed bodies', async () => {
    const failed = response(503);
    const ok = response(200);
    const fetchAttempt = vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(ok);

    await expect(fetchWithPreHeaderRetry(fetchAttempt, { allowReplay: true, delay: vi.fn() })).resolves.toBe(ok);
    expect(fetchAttempt).toHaveBeenCalledTimes(2);
    expect(failed.body.cancel).toHaveBeenCalledOnce();
    expect([400, 401, 429, 500].some(isTransientGatewayStatus)).toBe(false);
    expect([502, 503, 504, 520, 521, 522, 523, 524].every(isTransientGatewayStatus)).toBe(true);
  });

  it('retries classified transport failures but not arbitrary errors', async () => {
    const socketError = Object.assign(new TypeError('fetch failed'), {
      cause: { cause: { code: 'UND_ERR_SOCKET' } },
    });
    const ok = response(200);
    const retrying = vi.fn().mockRejectedValueOnce(socketError).mockResolvedValueOnce(ok);

    await expect(fetchWithPreHeaderRetry(retrying, { allowReplay: true, delay: vi.fn() })).resolves.toBe(ok);
    expect(isReplaySafeTransportError(socketError)).toBe(true);

    const unsafe = Object.assign(new Error('certificate rejected'), { code: 'CERT_HAS_EXPIRED' });
    const noRetry = vi.fn().mockRejectedValue(unsafe);
    await expect(fetchWithPreHeaderRetry(noRetry, { delay: vi.fn() })).rejects.toBe(unsafe);
    expect(noRetry).toHaveBeenCalledOnce();
  });

  it('does not replay a completion unless the caller proves it is local and keyless', async () => {
    const failed = response(503);
    const fetchAttempt = vi.fn().mockResolvedValue(failed);

    await expect(fetchWithPreHeaderRetry(fetchAttempt, { delay: vi.fn() })).resolves.toBe(failed);
    expect(fetchAttempt).toHaveBeenCalledOnce();
    expect(isReplaySafeLocalRequest({ endpoint: 'http://localhost:11434/v1' })).toBe(true);
    expect(isReplaySafeLocalRequest({ endpoint: 'http://127.0.0.42:1234/v1' })).toBe(true);
    expect(isReplaySafeLocalRequest({ endpoint: 'http://[::1]:1234/v1' })).toBe(true);
    expect(isReplaySafeLocalRequest({ endpoint: 'http://0.0.0.0:1234/v1' })).toBe(true);
    expect(isReplaySafeLocalRequest({ endpoint: 'http://[::]:1234/v1' })).toBe(true);
    expect(isReplaySafeLocalRequest({ endpoint: 'https://api.example.com/v1' })).toBe(false);
    expect(isReplaySafeLocalRequest({ endpoint: 'http://localhost:11434/v1', apiKey: 'secret' })).toBe(false);
  });

  it('stops promptly when aborted during backoff', async () => {
    const controller = new AbortController();
    const fetchAttempt = vi.fn().mockResolvedValue(response(502));
    const delay = vi.fn((_ms, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const pending = fetchWithPreHeaderRetry(fetchAttempt, { allowReplay: true, signal: controller.signal, delay });

    controller.abort(new Error('stopped'));
    await expect(pending).rejects.toThrow('stopped');
    expect(fetchAttempt).toHaveBeenCalledOnce();
  });

  it('replays a GOAWAY once even for a billable remote provider', async () => {
    // The regression: a gateway recycling an idle pooled connection failed the
    // run in ~0ms because GOAWAY was gated behind the local-and-keyless proof.
    const goaway = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('HTTP/2: "GOAWAY" frame received with code 0'), { code: 'UND_ERR_SOCKET' }),
    });
    const ok = response(200);
    const fetchAttempt = vi.fn().mockRejectedValueOnce(goaway).mockResolvedValueOnce(ok);

    await expect(fetchWithPreHeaderRetry(fetchAttempt, { delay: vi.fn() })).resolves.toBe(ok);
    expect(fetchAttempt).toHaveBeenCalledTimes(2);
  });

  it('gives up after the single GOAWAY replay a remote provider is allowed', async () => {
    const goaway = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('HTTP/2: "GOAWAY" frame received with code 0'), { code: 'UND_ERR_SOCKET' }),
    });
    const fetchAttempt = vi.fn().mockRejectedValue(goaway);

    await expect(fetchWithPreHeaderRetry(fetchAttempt, { delay: vi.fn() })).rejects.toBe(goaway);
    expect(fetchAttempt).toHaveBeenCalledTimes(2);
  });

  it('replays a GOAWAY the dead attempt held past the elapsed budget', async () => {
    // The regression: `maxElapsedMs` runs from the first attempt, so a gateway
    // draining a connection it had held open for ~5s spent the whole 2s budget
    // before the rejection even landed and the one promised replay never fired.
    const goaway = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('HTTP/2: "GOAWAY" frame received with code 0'), { code: 'UND_ERR_SOCKET' }),
    });
    const ok = response(200);
    const fetchAttempt = vi.fn().mockRejectedValueOnce(goaway).mockResolvedValueOnce(ok);
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(5121);

    await expect(fetchWithPreHeaderRetry(fetchAttempt, { now, delay: vi.fn() })).resolves.toBe(ok);
    expect(fetchAttempt).toHaveBeenCalledTimes(2);
  });

  it('still refuses the broad transport replay once the elapsed budget is spent', async () => {
    // The other half of the carve-out: a reset may already have been processed,
    // so a slow-failing host keeps its brake even for a local, keyless caller.
    const reset = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    });
    const fetchAttempt = vi.fn().mockRejectedValue(reset);
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(5121);

    await expect(fetchWithPreHeaderRetry(fetchAttempt, { allowReplay: true, now, delay: vi.fn() })).rejects.toBe(reset);
    expect(fetchAttempt).toHaveBeenCalledOnce();
  });

  it('never replays a GOAWAY past the caller attempt ceiling', async () => {
    const goaway = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('HTTP/2: "GOAWAY" frame received with code 0'), { code: 'UND_ERR_SOCKET' }),
    });
    const fetchAttempt = vi.fn().mockRejectedValue(goaway);

    await expect(fetchWithPreHeaderRetry(fetchAttempt, { maxAttempts: 1, delay: vi.fn() })).rejects.toBe(goaway);
    expect(fetchAttempt).toHaveBeenCalledOnce();
  });

  it('keeps the rest of the transport family behind the local-and-keyless proof', async () => {
    // A reset may land after the upstream accepted the request, so replaying it
    // against a billable provider could bill a second generation.
    const reset = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    });
    const fetchAttempt = vi.fn().mockRejectedValue(reset);

    await expect(fetchWithPreHeaderRetry(fetchAttempt, { delay: vi.fn() })).rejects.toBe(reset);
    expect(fetchAttempt).toHaveBeenCalledOnce();
    expect(isUnprocessedGoawayError(reset)).toBe(false);
    expect(isUnprocessedGoawayError(Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('HTTP/2: "GOAWAY" frame received with code 0'), { code: 'UND_ERR_SOCKET' }),
    }))).toBe(true);
  });

  it('returns the final retryable response intact when the attempt budget is exhausted', async () => {
    const final = response(504);
    const fetchAttempt = vi.fn().mockResolvedValue(final);

    await expect(fetchWithPreHeaderRetry(fetchAttempt, { maxAttempts: 1 })).resolves.toBe(final);
    expect(final.body.cancel).not.toHaveBeenCalled();
  });
});
