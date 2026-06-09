import { describe, it, expect, afterEach, vi } from 'vitest';
import { resolveBashBinary, _resetBashResolverCache } from './bashResolver.js';

// IS_WIN32 is captured at module-eval time, so these tests exercise whichever
// branch the host platform selects (Linux/macOS CI: the non-Windows path).
// Platform-specific assertions are gated on process.platform so the suite is
// correct on every runner.
const IS_WIN32 = process.platform === 'win32';

afterEach(() => {
  _resetBashResolverCache();
  delete process.env.PORTOS_BASH;
  vi.restoreAllMocks();
});

describe('resolveBashBinary', () => {
  it('returns a non-empty string', () => {
    expect(typeof resolveBashBinary()).toBe('string');
    expect(resolveBashBinary().length).toBeGreaterThan(0);
  });

  it('memoizes — repeated calls return the same value', () => {
    const first = resolveBashBinary();
    expect(resolveBashBinary()).toBe(first);
  });

  it('on non-Windows resolves to bare `bash` and ignores PORTOS_BASH', () => {
    if (IS_WIN32) return; // branch not taken on Windows
    process.env.PORTOS_BASH = '/nonexistent/custom/bash';
    expect(resolveBashBinary()).toBe('bash');
  });

  it('on Windows honors an existing PORTOS_BASH override', () => {
    if (!IS_WIN32) return; // branch not taken off Windows
    // Any real existing executable proves the override path is taken; the
    // resolver only checks existsSync, not that it's really bash.
    process.env.PORTOS_BASH = process.execPath; // node.exe — guaranteed to exist
    expect(resolveBashBinary()).toBe(process.execPath);
  });

  it('ignores a PORTOS_BASH override that does not exist', () => {
    process.env.PORTOS_BASH = '/definitely/not/here/bash.exe';
    // Falls through to Git Bash / bare bash — never the bogus override.
    expect(resolveBashBinary()).not.toBe('/definitely/not/here/bash.exe');
  });
});
