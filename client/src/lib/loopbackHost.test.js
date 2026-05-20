import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  isLoopbackHost,
  isLoopbackOrigin,
  describeMicAvailability,
} from './loopbackHost.js';

describe('isLoopbackHost', () => {
  it.each([
    ['localhost', true],
    ['LOCALHOST', true],
    ['LocalHost', true],
    ['127.0.0.1', true],
    ['127.0.0.5', true],
    ['127.1.2.3', true],
    ['127.255.255.254', true],
    ['::1', true],
    ['[::1]', true],
    ['0.0.0.0', false],
    ['10.0.0.1', false],
    ['100.111.11.146', false],
    ['192.168.1.1', false],
    ['portos.tailnet.ts.net', false],
    ['126.0.0.1', false],
    ['128.0.0.1', false],
    ['', false],
    [null, false],
    [undefined, false],
    [42, false],
  ])('isLoopbackHost(%p) === %p', (input, expected) => {
    expect(isLoopbackHost(input)).toBe(expected);
  });
});

describe('isLoopbackOrigin', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns false when window is undefined', () => {
    vi.stubGlobal('window', undefined);
    expect(isLoopbackOrigin()).toBe(false);
  });

  it('returns true for localhost', () => {
    vi.stubGlobal('window', { location: { hostname: 'localhost', protocol: 'http:' } });
    expect(isLoopbackOrigin()).toBe(true);
  });

  it('returns true for any 127.x.x.x', () => {
    vi.stubGlobal('window', { location: { hostname: '127.5.6.7', protocol: 'http:' } });
    expect(isLoopbackOrigin()).toBe(true);
  });

  it('returns true for [::1] (browser bracketed form)', () => {
    vi.stubGlobal('window', { location: { hostname: '[::1]', protocol: 'http:' } });
    expect(isLoopbackOrigin()).toBe(true);
  });

  it('returns false for Tailscale hostname', () => {
    vi.stubGlobal('window', { location: { hostname: 'void.taile8179.ts.net', protocol: 'http:' } });
    expect(isLoopbackOrigin()).toBe(false);
  });
});

describe('describeMicAvailability', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns unknown when window is undefined', () => {
    vi.stubGlobal('window', undefined);
    expect(describeMicAvailability()).toEqual({ available: true, reason: 'unknown' });
  });

  it('reports https when protocol is https', () => {
    vi.stubGlobal('window', {
      location: { hostname: 'portos.tailnet.ts.net', protocol: 'https:' },
    });
    expect(describeMicAvailability()).toEqual({ available: true, reason: 'https' });
  });

  it('reports loopback for http on localhost', () => {
    vi.stubGlobal('window', { location: { hostname: 'localhost', protocol: 'http:' } });
    expect(describeMicAvailability()).toEqual({ available: true, reason: 'loopback' });
  });

  it('reports loopback for http on 127.x.x.x', () => {
    vi.stubGlobal('window', { location: { hostname: '127.0.0.42', protocol: 'http:' } });
    expect(describeMicAvailability()).toEqual({ available: true, reason: 'loopback' });
  });

  it('reports insecure-context for http on a non-loopback origin', () => {
    vi.stubGlobal('window', {
      location: { hostname: '100.111.11.146', protocol: 'http:' },
    });
    expect(describeMicAvailability()).toEqual({ available: false, reason: 'insecure-context' });
  });
});
