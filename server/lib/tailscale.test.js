import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('fs', () => ({
  existsSync: vi.fn()
}));

import { existsSync } from 'fs';
import {
  findTailscale,
  isSandboxedTailscale,
  hasOnlySandboxedTailscale,
  MACOS_TAILSCALE_APP_BUNDLE
} from './tailscale.js';

describe('findTailscale', () => {
  let originalPath;

  beforeEach(() => {
    originalPath = process.env.PATH;
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it('returns the first matching candidate path', () => {
    const isWin = process.platform === 'win32';
    const expected = isWin
      ? 'C:\\Program Files\\Tailscale\\tailscale.exe'
      : '/opt/homebrew/bin/tailscale';
    existsSync.mockImplementation((p) => p === expected);
    expect(findTailscale()).toBe(expected);
  });

  it('falls back to a later candidate when earlier ones are missing', () => {
    const isWin = process.platform === 'win32';
    const target = isWin
      ? 'C:\\Program Files (x86)\\Tailscale\\tailscale.exe'
      : '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
    existsSync.mockImplementation((p) => p === target);
    expect(findTailscale()).toBe(target);
  });

  it('scans PATH directories when no candidate is found', () => {
    const isWin = process.platform === 'win32';
    const sep = isWin ? ';' : ':';
    const dir = isWin ? 'D:\\custom\\bin' : '/custom/bin';
    const bin = isWin ? 'tailscale.exe' : 'tailscale';
    process.env.PATH = `${dir}${sep}${isWin ? 'D:\\foo' : '/foo'}`;
    existsSync.mockImplementation((p) => p === `${dir}${isWin ? '\\' : '/'}${bin}`);
    expect(findTailscale()).toContain(bin);
  });

  it('returns null when no tailscale binary is anywhere on the system', () => {
    process.env.PATH = '/nowhere';
    existsSync.mockReturnValue(false);
    expect(findTailscale()).toBeNull();
  });

  it('handles an empty PATH gracefully', () => {
    process.env.PATH = '';
    existsSync.mockReturnValue(false);
    expect(findTailscale()).toBeNull();
  });

  it('skips empty path segments produced by adjacent separators', () => {
    const sep = process.platform === 'win32' ? ';' : ':';
    process.env.PATH = `${sep}${sep}`;
    existsSync.mockReturnValue(false);
    expect(findTailscale()).toBeNull();
    const callsWithBin = existsSync.mock.calls.filter(([p]) => /tailscale(\.exe)?$/.test(p));
    expect(callsWithBin.length).toBeGreaterThan(0);
  });
});

describe('isSandboxedTailscale', () => {
  it('returns true for the App bundle path', () => {
    expect(isSandboxedTailscale(MACOS_TAILSCALE_APP_BUNDLE)).toBe(true);
  });

  it('returns false for Homebrew, /usr/bin, and arbitrary paths', () => {
    expect(isSandboxedTailscale('/opt/homebrew/bin/tailscale')).toBe(false);
    expect(isSandboxedTailscale('/usr/local/bin/tailscale')).toBe(false);
    expect(isSandboxedTailscale('/usr/bin/tailscale')).toBe(false);
    expect(isSandboxedTailscale('/some/random/path/tailscale')).toBe(false);
    expect(isSandboxedTailscale(null)).toBe(false);
  });
});

describe('hasOnlySandboxedTailscale', () => {
  let originalPath;
  let originalPlatform;

  beforeEach(() => {
    originalPath = process.env.PATH;
    originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    process.env.PATH = '';
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('returns false on non-darwin platforms', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    existsSync.mockReturnValue(true);
    expect(hasOnlySandboxedTailscale()).toBe(false);
  });

  it('returns false when the App bundle is absent', () => {
    existsSync.mockReturnValue(false);
    expect(hasOnlySandboxedTailscale()).toBe(false);
  });

  it('returns true when only the App bundle exists', () => {
    existsSync.mockImplementation((p) => p === MACOS_TAILSCALE_APP_BUNDLE);
    expect(hasOnlySandboxedTailscale()).toBe(true);
  });

  it('returns false when Homebrew tailscale is also present', () => {
    existsSync.mockImplementation((p) =>
      p === MACOS_TAILSCALE_APP_BUNDLE || p === '/opt/homebrew/bin/tailscale'
    );
    expect(hasOnlySandboxedTailscale()).toBe(false);
  });

  it('returns false when an unsandboxed tailscale is on PATH and no App-bundle is present', () => {
    // findTailscale walks candidates first, App-bundle last; PATH scan only
    // runs if NO candidate matches. So this case (no candidates + PATH match)
    // resolves to the PATH binary and the helper reports unsandboxed.
    process.env.PATH = '/some/custom/bin';
    existsSync.mockImplementation((p) => p === '/some/custom/bin/tailscale');
    expect(hasOnlySandboxedTailscale()).toBe(false);
  });
});
