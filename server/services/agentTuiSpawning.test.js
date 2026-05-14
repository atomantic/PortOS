import { describe, it, expect } from 'vitest';
import { buildTuiSpawnConfig } from './agentTuiSpawning.js';

describe('agent TUI spawning', () => {
  it('builds a codex TUI command without a model flag for the configured-default sentinel', () => {
    const config = buildTuiSpawnConfig({
      id: 'codex-tui',
      name: 'Codex TUI',
      type: 'tui',
      command: 'codex',
      args: []
    }, 'codex-configured-default');

    expect(config.command).toBe('codex');
    expect(config.args).toEqual([]);
    expect(config.commandLine).toBe('codex');
  });

  it('quotes TUI arguments and carries idle timing config', () => {
    const config = buildTuiSpawnConfig({
      id: 'claude-code-tui',
      name: 'Claude TUI',
      type: 'tui',
      command: 'claude',
      args: ['--dangerously-skip-permissions', '--add-dir', '/tmp/with space'],
      tuiPromptDelayMs: 1000,
      tuiIdleTimeoutMs: 30000
    }, 'claude-sonnet');

    expect(config.args).toEqual([
      '--dangerously-skip-permissions',
      '--add-dir',
      '/tmp/with space',
      '--model',
      'claude-sonnet'
    ]);
    expect(config.commandLine).toBe("claude --dangerously-skip-permissions --add-dir '/tmp/with space' --model claude-sonnet");
    expect(config.promptDelayMs).toBe(1000);
    expect(config.idleTimeoutMs).toBe(30000);
  });
});
