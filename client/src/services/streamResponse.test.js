// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import { openStreamResponse, readStreamFrames } from './streamResponse.js';

const encode = (text) => new TextEncoder().encode(text);

function respond(chunks, { keepOpen = false } = {}) {
  const cancel = vi.fn();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encode(chunk) : chunk);
      if (!keepOpen) controller.close();
    },
    cancel,
  });
  const getReader = vi.spyOn(body, 'getReader');
  return { response: new Response(body), cancel, getReader };
}

describe('openStreamResponse', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('opens a readable successful response', async () => {
    const { response, getReader } = respond([]);
    await expect(openStreamResponse(Promise.resolve(response))).resolves.toBe(response);
    expect(getReader).not.toHaveBeenCalled();
  });

  it('rejects a successful response whose body is unavailable', async () => {
    await expect(openStreamResponse(Promise.resolve(new Response(null, { status: 204 })))).rejects.toThrow('cannot read a streamed response');
  });

  it('preserves the original fetch abort', async () => {
    const abort = new DOMException('Cancelled', 'AbortError');
    await expect(openStreamResponse(Promise.reject(abort))).rejects.toBe(abort);
  });

  it('reports other fetch failures consistently with request()', async () => {
    await expect(openStreamResponse(Promise.reject(new TypeError('Failed to fetch')))).rejects.toMatchObject({
      code: 'SERVER_UNREACHABLE',
      message: 'Server unreachable — check your connection and try again',
    });
  });

  it('preserves the error envelope and redirects expired sessions', async () => {
    const replace = vi.fn();
    vi.stubGlobal('window', { location: { pathname: '/models', search: '?tab=local', replace } });
    const response = new Response(JSON.stringify({ code: 'AUTH_REQUIRED', error: 'Sign in' }), { status: 401 });
    await expect(openStreamResponse(Promise.resolve(response))).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      status: 401,
      message: 'Sign in',
    });
    expect(replace).toHaveBeenCalledWith('/login?next=%2Fmodels%3Ftab%3Dlocal');
  });
});

describe('readStreamFrames', () => {
  it('reads mixed SSE boundaries, joins data lines and flushes a split UTF-8 character and final frame', async () => {
    const bytes = encode(': keepalive\r\n\r\nevent: progress\r\ndata: café\r\ndata:  second\r\n\r\ndata: plain\n\ndata: final');
    const split = bytes.indexOf(0xc3) + 1;
    const { response } = respond([bytes.slice(0, split), bytes.slice(split)]);
    const onFrame = vi.fn();

    await expect(readStreamFrames(response, { format: 'sse', onFrame })).resolves.toBe(false);
    expect(onFrame.mock.calls).toEqual([
      [{ event: 'progress', data: 'café\n second' }],
      [{ event: 'message', data: 'plain' }],
      [{ event: 'message', data: 'final' }],
    ]);
    expect(response.body.locked).toBe(false);
  });

  it('reads non-blank NDJSON lines including an unterminated final line', async () => {
    const { response } = respond([' {"type":"token"}\r', '\n\r\n \n{"type":"result"}']);
    const onFrame = vi.fn();

    await readStreamFrames(response, { format: 'ndjson', onFrame });
    expect(onFrame.mock.calls).toEqual([
      [{ event: 'message', data: ' {"type":"token"}' }],
      [{ event: 'message', data: '{"type":"result"}' }],
    ]);
  });

  it('cancels after a stop and skips remaining frames in the same chunk', async () => {
    const { response, cancel } = respond(['data: stop\n\ndata: ignored\n\n'], { keepOpen: true });
    const onFrame = vi.fn().mockReturnValue(true);

    await expect(readStreamFrames(response, { format: 'sse', onFrame })).resolves.toBe(true);
    expect(onFrame.mock.calls).toEqual([[{ event: 'message', data: 'stop' }]]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body.locked).toBe(false);
  });

  it('cancels even when the caller throws', async () => {
    const { response, cancel } = respond(['data: fail\n\n'], { keepOpen: true });
    const failure = new Error('callback failed');

    await expect(readStreamFrames(response, { format: 'sse', onFrame: () => { throw failure; } })).rejects.toBe(failure);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body.locked).toBe(false);
  });

  it('cancels on an aborted read and preserves the abort when cancellation rejects', async () => {
    const controller = new AbortController();
    const { response, getReader } = respond([], { keepOpen: true });
    const reader = response.body.getReader();
    getReader.mockReturnValue(reader);
    vi.spyOn(reader, 'read').mockImplementation(() => new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    }));
    const cancel = vi.spyOn(reader, 'cancel').mockRejectedValue(new Error('connection already closed'));
    const onFrame = vi.fn();

    const pending = readStreamFrames(response, { format: 'sse', onFrame });
    controller.abort();
    await expect(pending).rejects.toBe(controller.signal.reason);
    expect(cancel).toHaveBeenCalledOnce();
    expect(onFrame).not.toHaveBeenCalled();
    expect(response.body.locked).toBe(false);
  });

  it('throws on incomplete UTF-8 when the fatal decoder flushes', async () => {
    const { response } = respond([new Uint8Array([...encode('data: final '), 0xc3])]);
    const onFrame = vi.fn();

    await expect(readStreamFrames(response, { format: 'sse', fatal: true, onFrame })).rejects.toMatchObject({
      code: 'INVALID_STREAM_UTF8',
    });
    expect(onFrame).not.toHaveBeenCalled();
    expect(response.body.locked).toBe(false);
  });
});
