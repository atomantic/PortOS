import { describe, it, expect } from 'vitest';
import { parseBuildCommand, hasShellUnsafeArg, ALLOWED_BUILD_CMDS } from './appBuilder.js';

describe('appBuilder.parseBuildCommand', () => {
  it('defaults to "npm run build" when no command is provided', () => {
    const result = parseBuildCommand(undefined);
    expect(result).toEqual({ ok: true, cmd: 'npm', args: ['run', 'build'], buildCommand: 'npm run build' });
  });

  it('accepts an allowlisted command and splits cmd/args', () => {
    const result = parseBuildCommand('npx vite build');
    expect(result).toEqual({ ok: true, cmd: 'npx', args: ['vite', 'build'], buildCommand: 'npx vite build' });
  });

  it('accepts all allowlisted native build tools', () => {
    for (const cmd of ALLOWED_BUILD_CMDS) {
      expect(parseBuildCommand(`${cmd} build`).ok).toBe(true);
    }
  });

  it('rejects a non-allowlisted command with INVALID_BUILD_COMMAND', () => {
    const result = parseBuildCommand('rm -rf /');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVALID_BUILD_COMMAND');
    expect(result.message).toContain("'rm' is not allowed");
  });

  it.skipIf(process.platform !== 'win32')('rejects shell-unsafe args for npm/npx on Windows', () => {
    const result = parseBuildCommand('npm run build&whoami');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVALID_BUILD_COMMAND');
  });
});

describe('appBuilder.hasShellUnsafeArg', () => {
  // Platform-independent so the cmd.exe metacharacter check has real coverage
  // on every CI runner, not only win32 (where parseBuildCommand applies it).
  it.each(['&', '|', '<', '>', '^', '%', '!', '(', ')'])('flags arg containing %s', (ch) => {
    expect(hasShellUnsafeArg([`build${ch}whoami`])).toBe(true);
  });

  it('passes plain args', () => {
    expect(hasShellUnsafeArg(['run', 'build'])).toBe(false);
  });

  it('returns false for no args', () => {
    expect(hasShellUnsafeArg([])).toBe(false);
  });
});
