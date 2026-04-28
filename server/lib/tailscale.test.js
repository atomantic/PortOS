import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('fs', () => ({
  existsSync: vi.fn()
}));

import { existsSync } from 'fs';
import { findTailscale } from './tailscale.js';

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
      : '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
    existsSync.mockImplementation((p) => p === expected);
    expect(findTailscale()).toBe(expected);
  });

  it('falls back to a later candidate when earlier ones are missing', () => {
    const isWin = process.platform === 'win32';
    const target = isWin
      ? 'C:\\Program Files (x86)\\Tailscale\\tailscale.exe'
      : '/opt/homebrew/bin/tailscale';
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
