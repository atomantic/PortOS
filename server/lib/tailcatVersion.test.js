import { describe, it, expect } from 'vitest';
import {
  MIN_TAILCAT_VERSION,
  parseTailcatVersion,
  isTailcatVersionAtLeast,
  tailcatVersionTooOldMessage,
} from './tailcatVersion.js';

describe('tailcatVersion', () => {
  it('exposes the PSK-compatible floor', () => {
    expect(MIN_TAILCAT_VERSION).toBe('0.6.0');
  });

  it.each([
    ['v0.6.0', '0.6.0'],
    ['0.6.0', '0.6.0'],
    ['v0.5.0', '0.5.0'],
    ['tailcat version v0.6.0\n', '0.6.0'],
    ['v0.6.0-rc.1', '0.6.0-rc.1'],
    ['v0.6.0+build.1', '0.6.0+build.1'],
  ])('parseTailcatVersion(%j) → %j', (input, expected) => {
    expect(parseTailcatVersion(input)).toBe(expected);
  });

  it('parseTailcatVersion returns null for garbage', () => {
    expect(parseTailcatVersion(null)).toBeNull();
    expect(parseTailcatVersion(undefined)).toBeNull();
    expect(parseTailcatVersion('')).toBeNull();
    expect(parseTailcatVersion('not-a-version')).toBeNull();
    expect(parseTailcatVersion(42)).toBeNull();
  });

  it('rejects versions below the floor', () => {
    expect(isTailcatVersionAtLeast('0.5.0')).toBe(false);
    expect(isTailcatVersionAtLeast('0.5.9')).toBe(false);
    expect(isTailcatVersionAtLeast('0.6.0-rc.1')).toBe(false);
    expect(isTailcatVersionAtLeast(null)).toBe(false);
    expect(isTailcatVersionAtLeast('')).toBe(false);
  });

  it('accepts versions at or above the floor', () => {
    expect(isTailcatVersionAtLeast('0.6.0')).toBe(true);
    expect(isTailcatVersionAtLeast('0.6.1')).toBe(true);
    expect(isTailcatVersionAtLeast('1.0.0')).toBe(true);
  });

  it('names the floor and upgrade path in the operator error', () => {
    const darwin = tailcatVersionTooOldMessage({ version: '0.5.0', platform: 'darwin' });
    expect(darwin).toContain('0.6.0+');
    expect(darwin).toContain('found 0.5.0');
    expect(darwin).toContain('brew upgrade tailcat');
    expect(darwin).toContain('Do not set --psk=false');

    const linux = tailcatVersionTooOldMessage({ version: null, platform: 'linux' });
    expect(linux).toContain('could not determine version');
    expect(linux).toContain('go install');
    expect(linux).toContain('https://github.com/tailscale/tailcat/releases');
  });
});
