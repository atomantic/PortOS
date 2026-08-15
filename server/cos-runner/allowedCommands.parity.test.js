/**
 * Parity pin for the AI Providers editor's runner-allowlist warning (#4143).
 *
 * The client never carries its own copy of the allowlist — it receives it as
 * `runnerAllowedCommands` on `GET /api/providers`, so the list itself cannot
 * drift. What it DOES mirror is the normalization `isAllowedCommand` applies
 * before the membership test (strip directory prefix, strip a trailing
 * `.exe`), and that mirror is what this file pins.
 */

import { describe, it, expect } from 'vitest';
import { ALLOWED_COMMANDS, isAllowedCommand } from './allowedCommands.js';
import { isRunnerAllowedCommand } from '../../client/src/utils/providers.js';

const allowlist = [...ALLOWED_COMMANDS].sort();
const sampleAllowed = allowlist[0];

describe('runner allowlist client mirror', () => {
  // Forward-slash / bare-name / .exe forms only: `path.basename` is
  // platform-specific, so a backslash is NOT a separator on a POSIX host while
  // the client mirror always treats it as one. That deliberate divergence is
  // documented on `runnerCommandBaseName` and asserted separately below.
  const cases = [
    sampleAllowed,
    `/usr/local/bin/${sampleAllowed}`,
    `./${sampleAllowed}`,
    `${sampleAllowed}.exe`,
    `${sampleAllowed}.EXE`,
    `/opt/bin/${sampleAllowed}.exe`,
    `${sampleAllowed}/`,
    `${sampleAllowed}.cmd`,
    `${sampleAllowed}.bat`,
    `${sampleAllowed} `,
    `my-${sampleAllowed}`,
    'definitely-not-a-real-agent-cli',
    '/usr/bin/rm',
    'rm -rf /',
    '/',
  ];

  it.each(cases)('agrees with isAllowedCommand for %j', (command) => {
    // The client's third state (`null` = list not fetched / field blank) never
    // occurs here: a real list is passed and every case is non-blank.
    expect(isRunnerAllowedCommand(command, allowlist)).toBe(isAllowedCommand(command));
  });

  it('reports every shipped allowlist entry as allowed', () => {
    for (const command of allowlist) {
      expect(isRunnerAllowedCommand(command, allowlist)).toBe(true);
    }
  });

  it('returns null (not false) when the allowlist has not been fetched', () => {
    expect(isRunnerAllowedCommand(sampleAllowed, null)).toBeNull();
    expect(isRunnerAllowedCommand(sampleAllowed, undefined)).toBeNull();
    expect(isRunnerAllowedCommand(sampleAllowed, [])).toBeNull();
  });

  it('returns null (not false) for a blank command field', () => {
    expect(isRunnerAllowedCommand('', allowlist)).toBeNull();
    expect(isRunnerAllowedCommand('   ', allowlist)).toBeNull();
    expect(isRunnerAllowedCommand(null, allowlist)).toBeNull();
  });

  it('treats a backslash as a separator even where POSIX path.basename would not', () => {
    // Client-only behavior, by design: this drives an informational warning,
    // and a false warning about a Windows path on a Windows install would be
    // worse than a missing one for a path shape POSIX cannot spawn anyway.
    expect(isRunnerAllowedCommand(`C:\\bin\\${sampleAllowed}.exe`, allowlist)).toBe(true);
  });
});
