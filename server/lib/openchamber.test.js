import { describe, it, expect } from 'vitest';
import { buildCliArgs, prepareCliPrompt } from './cliProviderArgs.js';
import { isOpenchamberCommand, isOpenchamberModelId, ensureOpenchamberHeadlessArgs } from './openchamber.js';
import { applyCommandDefaults } from './providerVendors.js';
import { harnessForProvider, harnessSupportsMode } from './providerHarnesses.js';
import { isAllowedCommand } from '../cos-runner/allowedCommands.js';

const HEADLESS = ['session', 'create', '--wait', '--last-assistant', '--quiet'];

describe('OpenChamber provider boundaries', () => {
  it('builds the session-create argv and leaves the directory and prompt to spawn time', () => {
    const provider = {
      id: 'openchamber-cli', type: 'cli', command: 'openchamber', args: [],
      defaultModel: 'anthropic/claude-opus-5',
    };
    const args = buildCliArgs(provider);
    expect(args).toEqual([...HEADLESS, '--model', 'anthropic/claude-opus-5']);
    expect(args).not.toContain('--dir');
    expect(args).not.toContain('--prompt');
  });

  it('delivers the prompt and the run cwd as argv, never stdin', () => {
    const prepared = prepareCliPrompt('openchamber', [...HEADLESS], 'review this', { cwd: '/example/worktree' });
    expect(prepared.useStdin).toBe(false);
    expect(prepared.args).toEqual([...HEADLESS, '--dir', '/example/worktree', '--prompt', 'review this']);
  });

  it('honors a record already addressing a project instead of a directory', () => {
    const pinned = ['session', 'create', '--project', 'proj-1', '--prompt', 'pinned'];
    const prepared = prepareCliPrompt('openchamber', pinned, 'ignored', { cwd: '/example/worktree' });
    expect(prepared.args).toEqual(pinned);
  });

  it('drops a model id the control CLI would reject before doing any work', () => {
    // `--model` is validated as `provider/model`; a bare id exits with a usage
    // error, so pinning one must omit the flag rather than fail the run.
    expect(isOpenchamberModelId('claude-opus-5')).toBe(false);
    expect(isOpenchamberModelId('anthropic/claude-opus-5')).toBe(true);
    expect(ensureOpenchamberHeadlessArgs([], 'claude-opus-5')).toEqual(HEADLESS);
  });

  it('adds nothing twice when the saved args already pin the action and flags', () => {
    expect(ensureOpenchamberHeadlessArgs(HEADLESS, null)).toEqual(HEADLESS);
    expect(ensureOpenchamberHeadlessArgs(['session', 'send', '--session', 's1'], null))
      .toEqual(['session', 'send', '--session', 's1', '--wait', '--last-assistant', '--quiet']);
  });

  it('is a headless-only harness with no interactive argv to spawn in a PTY', () => {
    const provider = { id: 'openchamber-cli', type: 'cli', command: 'openchamber' };
    expect(harnessForProvider(provider).id).toBe('openchamber');
    expect(harnessSupportsMode('openchamber', 'cli')).toBe(true);
    expect(harnessSupportsMode('openchamber', 'tui')).toBe(false);
    // No `tuiArgs` row: `applyCommandDefaults` must not invent an argv that
    // would launch the OpenChamber SERVER inside a PTY and call it an agent.
    expect(applyCommandDefaults('openchamber', ['session'])).toEqual(['session']);
  });

  it('never collides with OpenCode despite the shared prefix', () => {
    expect(isOpenchamberCommand('openchamber')).toBe(true);
    expect(isOpenchamberCommand('/opt/bin/openchamber.exe')).toBe(true);
    expect(isOpenchamberCommand('opencode')).toBe(false);
    expect(harnessForProvider({ type: 'cli', command: 'opencode' }).id).toBe('opencode');
    expect(isAllowedCommand('openchamber')).toBe(true);
  });
});
