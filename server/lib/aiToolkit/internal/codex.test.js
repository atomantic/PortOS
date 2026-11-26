import { describe, it, expect } from 'vitest';
import { CODEX_COMMAND, CODEX_CLI_ID, CODEX_TUI_ID, isCodexCommand } from './codex.js';
import { CODEX_COMMAND as HOST_COMMAND, isCodexCommand as hostIsCodexCommand } from '../../codex.js';
import { CODEX_APP_SERVER_COMMAND } from '../../codexAccount.js';

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

  it('matches the app-server binary and exposes the shipped provider ids', () => {
    expect(CODEX_COMMAND).toBe(CODEX_APP_SERVER_COMMAND);
    expect(CODEX_CLI_ID).toBe('codex');
    expect(CODEX_TUI_ID).toBe('codex-tui');
  });

  it('re-exports the toolkit binary name and command matcher from the host module', () => {
    expect(HOST_COMMAND).toBe(CODEX_COMMAND);
    expect(hostIsCodexCommand).toBe(isCodexCommand);
  });
});
