// @vitest-environment node
/**
 * Streaming and Video Gen raw-fetch helpers must honor
 * the apiCore error envelope: session-expiry redirect plus .code/.status/.context.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const respond = (status, body) => ({
  ok: false,
  status,
  json: async () => {
    if (body === undefined) throw new SyntaxError('no body');
    return body;
  },
});

const callers = {
  streamAskTurn: async () => (await import('./apiAsk.js')).streamAskTurn({ question: 'q' }, { onEvent: vi.fn() }),
  streamOpenClawMessage: async () => (await import('./apiOpenClaw.js')).streamOpenClawMessage('s1', { message: 'hi' }),
  installAudioModel: async () => (await import('./apiMusic.js')).installAudioModel({ engine: 'musicgen', repo: 'example/model' }),
  streamLocalLlmTest: async () => (await import('./apiLocalLlm.js')).streamLocalLlmTest({ prompt: 'hi' }),
  installLoraFromHuggingfaceStream: async () => (await import('./apiImageVideo.js')).installLoraFromHuggingfaceStream({ url: 'https://example.com/model' }),
  generateVideo: async () => (await import('./apiImageVideo.js')).generateVideo({ prompt: 'p' }),
};

describe.each(Object.entries(callers))('%s non-OK responses', (_name, call) => {
  let replace;
  beforeEach(() => {
    vi.resetModules();
    replace = vi.fn();
    vi.stubGlobal('window', { location: { pathname: '/ask', search: '', replace } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('redirects to /login on 401 AUTH_REQUIRED and keeps code/status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(401, { error: 'Sign in', code: 'AUTH_REQUIRED' })));
    await expect(call()).rejects.toMatchObject({ message: 'Sign in', code: 'AUTH_REQUIRED', status: 401 });
    expect(replace).toHaveBeenCalledWith('/login?next=%2Fask');
  });

  it('reports a bodyless 503 as SERVER_UNREACHABLE', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(503)));
    await expect(call()).rejects.toMatchObject({ code: 'SERVER_UNREACHABLE', status: 503 });
    expect(replace).not.toHaveBeenCalled();
  });
});

describe.each(['streamAskTurn', 'streamOpenClawMessage'])('%s validation detail', (name) => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it('folds field details into the message and forwards context', async () => {
    const context = { details: [{ path: 'question', message: 'required' }] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(400, { error: 'Validation failed', code: 'VALIDATION_ERROR', context })));
    await expect(callers[name]()).rejects.toMatchObject({
      message: 'Validation failed — question: required',
      code: 'VALIDATION_ERROR',
      status: 400,
      context,
    });
  });

  it('propagates AbortError', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort));
    await expect(callers[name]()).rejects.toBe(abort);
  });
});
