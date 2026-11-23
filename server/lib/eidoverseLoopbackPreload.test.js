import { describe, expect, it, vi } from 'vitest';
import { installLoopbackServe } from './eidoverseLoopbackPreload.js';

const wrapped = (env = {}) => {
  const serve = vi.fn((options) => options);
  const bun = { serve };
  installLoopbackServe(bun, env);
  return { bun, serve };
};

describe('Eidoverse loopback preload', () => {
  it.each([
    ['an explicit port', { port: 8940, hostname: '0.0.0.0' }, {}],
    ['a string port', { port: '8940', hostname: '0.0.0.0' }, {}],
    ['no hostname', { port: 8940 }, {}],
    ['the PORT fallback', { hostname: '::' }, { PORT: '8940' }],
  ])('forces loopback for the sequencer with %s', (_label, options, env) => {
    const { bun, serve } = wrapped(env);
    const fetch = () => {};
    expect(bun.serve({ ...options, fetch })).toMatchObject({ hostname: '127.0.0.1', fetch });
    expect(serve.mock.contexts[0]).toBe(bun);
  });

  it('leaves any other listener unchanged', () => {
    const { bun } = wrapped({ PORT: '8940' });
    const options = { port: 4000, hostname: '0.0.0.0' };
    expect(bun.serve(options)).toBe(options);
  });
});
