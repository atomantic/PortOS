import { afterEach, describe, expect, it, vi } from 'vitest';
import { installAudioModel, setupSuperCollider } from './apiMusic.js';
import { maybeRedirectToLogin } from './apiCore.js';

vi.mock('./apiCore.js', () => ({ request: vi.fn(), maybeRedirectToLogin: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

const respond = (chunks) => vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
  ok: true,
  body: new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
    controller.close();
  } }),
}));

for (const [name, start] of [
  ['audio model', (onEvent) => installAudioModel({ engine: 'musicgen', repo: 'example/model' }, onEvent)],
  ['SuperCollider', (onEvent) => setupSuperCollider({}, onEvent)],
]) describe(`${name} installation transport`, () => {
  it.each(['', 'data: {"type":"log","message":"working"}\n\n', 'data: {"type":"progress","progress":0.5}\n\n'])(
    'rejects an incomplete stream %j without retrying', async (body) => {
      respond([body]);
      await expect(start(vi.fn())).rejects.toThrow('before completion');
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it('rejects the explicit terminal error even if completion follows', async () => {
    respond(['data: {"type":"error","message":"Download failed"}\n\ndata: {"type":"complete"}\n\n']);
    await expect(start(vi.fn())).rejects.toThrow('Download failed');
  });
  it('accepts fragmented CRLF framing and flushes the final buffered completion', async () => {
    respond(['data: {"type":"log","message":"working"}\r', '\n\r\ndata: {"type":', '"complete"}']);
    const events = vi.fn();
    await expect(start(events)).resolves.toBeUndefined();
    expect(events.mock.calls.map(([event]) => event.type)).toEqual(['log', 'complete']);
  });
  it('rejects undecodable completion bytes without a success callback, preserving earlier progress', async () => {
    const encode = (text) => new TextEncoder().encode(text);
    respond([
      'data: {"type":"progress","progress":0.5}\n\n',
      new Uint8Array([...encode('data: {"type":"complete","message":"'), 0xff, ...encode('"}\n\n')]),
    ]);
    const events = vi.fn();
    await expect(start(events)).rejects.toThrow('invalid UTF-8');
    expect(events.mock.calls.map(([event]) => event.type)).toEqual(['progress']);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not interpret malformed completion as success', async () => {
    respond(['data: {"type":"complete"\n\n']);
    await expect(start(vi.fn())).rejects.toThrow();
  });
});

it('preserves authentication redirect handling', async () => {
  const response = { ok: false, status: 401, text: async () => JSON.stringify({ code: 'AUTH_REQUIRED', error: 'Sign in' }) };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  await expect(installAudioModel({ engine: 'musicgen', repo: 'example/model' })).rejects.toThrow('Sign in');
  expect(maybeRedirectToLogin).toHaveBeenCalledWith(response, { code: 'AUTH_REQUIRED', error: 'Sign in' });
});
