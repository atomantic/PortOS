import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { isAllowedCommand } from './allowedCommands.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Every `command` declared by a provider in a shipped provider catalog. */
function shippedProviderCommands(relativePath) {
  const catalog = JSON.parse(readFileSync(join(REPO_ROOT, relativePath), 'utf8'));
  return Object.entries(catalog.providers || {})
    .filter(([, p]) => typeof p?.command === 'string' && p.command)
    .map(([id, p]) => ({ id, command: p.command }));
}

describe('isAllowedCommand', () => {
  describe('permitted commands via full absolute path', () => {
    it('allows /usr/bin/claude', () => {
      expect(isAllowedCommand('/usr/bin/claude')).toBe(true);
    });

    it('allows /usr/local/bin/codex', () => {
      expect(isAllowedCommand('/usr/local/bin/codex')).toBe(true);
    });

    it('allows /home/user/.local/bin/aider', () => {
      expect(isAllowedCommand('/home/user/.local/bin/aider')).toBe(true);
    });

    it('allows opencode (so headless OpenCode Ollama agents run under CoS Runner mode)', () => {
      expect(isAllowedCommand('opencode')).toBe(true);
      expect(isAllowedCommand('/opt/homebrew/bin/opencode')).toBe(true);
    });
  });

  describe('Windows .exe stripping', () => {
    it('allows claude.exe', () => {
      expect(isAllowedCommand('claude.exe')).toBe(true);
    });

    it('allows claude.EXE (case-insensitive extension)', () => {
      expect(isAllowedCommand('claude.EXE')).toBe(true);
    });

    // Deterministic on EVERY OS: a POSIX-style absolute path whose basename is
    // "claude.exe". path.basename('/opt/tools/claude.exe') === 'claude.exe' on
    // both win32 and posix, so after the .exe strip the result is 'claude' and
    // the command is allowed regardless of the host running the test. This
    // enforces the "strip .exe after basename" contract on all platforms —
    // it fails concretely (not via typeof) if the .exe stripping regresses.
    it('allows a full path ending in claude.exe on all OSes (/opt/tools/claude.exe)', () => {
      expect(isAllowedCommand('/opt/tools/claude.exe')).toBe(true);
    });

    it('rejects a full path ending in a non-allowed .exe (/opt/tools/bash.exe)', () => {
      expect(isAllowedCommand('/opt/tools/bash.exe')).toBe(false);
    });

    // The real Windows backslash form. path.basename is platform-specific:
    // on win32 it splits on "\\" → 'claude.exe' → strip → 'claude' (allowed);
    // on posix backslashes are ordinary chars so basename returns the whole
    // string → 'C:\\...\\claude' after strip → not allowed. Assert the concrete
    // expected boolean per-platform so a regression in EITHER direction fails
    // here — never `typeof result === 'boolean'`, which passes for any boolean.
    it('resolves a Windows backslash .exe path per-platform', () => {
      const windowsPath = 'C:\\Users\\user\\AppData\\Local\\claude.exe';
      const expected = process.platform === 'win32';
      expect(isAllowedCommand(windowsPath)).toBe(expected);
    });
  });

  describe('blocked commands', () => {
    it('rejects an arbitrary command "bash"', () => {
      expect(isAllowedCommand('bash')).toBe(false);
    });

    it('rejects "rm"', () => {
      expect(isAllowedCommand('rm')).toBe(false);
    });

    it('rejects "python"', () => {
      expect(isAllowedCommand('python')).toBe(false);
    });

    it('rejects "node"', () => {
      expect(isAllowedCommand('node')).toBe(false);
    });
  });

  describe('path traversal / embedded-name attacks', () => {
    it('rejects /tmp/claude-evil because basename is "claude-evil", not "claude"', () => {
      // The whole point of using basename: a path that contains an allowed
      // name as a SEGMENT or PREFIX does NOT slip through.
      expect(isAllowedCommand('/tmp/claude-evil')).toBe(false);
    });

    it('rejects /usr/bin/claude/../bash — basename is "bash"', () => {
      // path.basename of a path ending with a non-allowed segment rejects it.
      expect(isAllowedCommand('/usr/bin/claude/../bash')).toBe(false);
    });

    it('rejects a path that embeds the allowed name in a subdirectory: /claude/evil', () => {
      // basename('/claude/evil') → 'evil', not 'claude'
      expect(isAllowedCommand('/claude/evil')).toBe(false);
    });

    it('rejects a path whose basename is an allowed name prefix: /bin/claudeX', () => {
      expect(isAllowedCommand('/bin/claudeX')).toBe(false);
    });
  });

  // Regression guard. `grok` (and `kimi`) shipped as enabled-able providers while
  // absent from this allowlist, so selecting grok-tui 400'd at the runner's
  // /spawn-tui, the agent never got a PTY, and the zombie reaper finalized it a
  // minute later as "Agent process terminated unexpectedly" — the user saw a task
  // that simply never produced a shell. Any future provider added to a shipped
  // catalog without an allowlist entry fails here instead.
  describe('parity with shipped provider catalogs', () => {
    describe.each([
      ['data.reference/providers.json'],
      ['server/lib/aiToolkit/defaults/providers.sample.json'],
    ])('%s', (catalogPath) => {
      const providers = shippedProviderCommands(catalogPath);

      it('declares at least one provider command (guards against a silently empty parse)', () => {
        expect(providers.length).toBeGreaterThan(0);
      });

      it.each(providers.map(({ id, command }) => [id, command]))(
        'provider "%s" runs allowlisted command "%s"',
        (_id, command) => {
          expect(isAllowedCommand(command)).toBe(true);
        }
      );
    });
  });

  describe('invalid / edge inputs', () => {
    it('returns false for null', () => {
      expect(isAllowedCommand(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isAllowedCommand(undefined)).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isAllowedCommand('')).toBe(false);
    });

    it('returns false for a number', () => {
      expect(isAllowedCommand(42)).toBe(false);
    });

    it('returns false for an object', () => {
      expect(isAllowedCommand({})).toBe(false);
    });

    it('returns false for an array', () => {
      expect(isAllowedCommand(['claude'])).toBe(false);
    });
  });
});
