import { describe, it, expect } from 'vitest';
import { CODEX_COMMAND, CODEX_CLI_ID, CODEX_TUI_ID, isCodexCommand } from './codex.js';
import { CODEX_APP_SERVER_COMMAND as UPSTREAM_COMMAND } from '../../codexAccount.js';

describe('isCodexCommand', () => {
  it('matches the bare binary, an absolute path, and a Windows .exe', () => {
    expect(isCodexCommand('codex')).toBe(true);
    expect(isCodexCommand('/opt/homebrew/bin/codex')).toBe(true);
    expect(isCodexCommand('C:\\Tools\\codex.exe')).toBe(true);
    expect(isCodexCommand('CODEX')).toBe(true);
  });

  it('rejects other binaries', () => {
    expect(isCodexCommand('cursor-agent')).toBe(false);
    expect(isCodexCommand('claude')).toBe(false);
    expect(isCodexCommand('agy')).toBe(false);
    expect(isCodexCommand(null)).toBe(false);
    expect(isCodexCommand('')).toBe(false);
  });

  it('stays in lockstep with upstream command constant', () => {
    expect(CODEX_COMMAND).toBe(UPSTREAM_COMMAND);
    expect(CODEX_CLI_ID).toBe('codex');
    expect(CODEX_TUI_ID).toBe('codex-tui');
  });
});
