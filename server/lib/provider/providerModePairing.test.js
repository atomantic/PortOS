import { describe, it, expect } from 'vitest';
import { tuiModeAddition } from './providerModePairing.js';

// The refusal matrix and its status codes are asserted through the endpoint
// that answers them (`routes/providers.tuiMode.test.js`), which runs this same
// function. What only a unit test can pin cheaply is where the sibling's ARGV
// comes from — a detail no HTTP response shape makes visible.

const CLAUDE_CLI = { id: 'claude-code', name: 'Claude Code', type: 'cli', command: 'claude' };

describe('tuiModeAddition argv defaults', () => {
  it('starts a known harness at its recipe’s proven interactive argv', () => {
    // Not a guess and not empty: `--dangerously-skip-permissions` is what the
    // Claude row declares for its TUI mode, and a sibling minted without it
    // stops at a permission prompt the moment the Shell page launches it.
    expect(tuiModeAddition(CLAUDE_CLI, [CLAUDE_CLI])).toEqual({ ok: true, args: ['--dangerously-skip-permissions'] });
  });

  it('hands back a fresh array, not the frozen recipe row every later mint reads', () => {
    tuiModeAddition(CLAUDE_CLI, [CLAUDE_CLI]).args.push('--tampered');
    expect(tuiModeAddition(CLAUDE_CLI, [CLAUDE_CLI]).args).toEqual(['--dangerously-skip-permissions']);
  });

  it('lets an UNKNOWN harness through with empty argv rather than a guess', () => {
    const custom = { id: 'my-agent', name: 'My Agent', type: 'cli', command: '/opt/bin/my-agent' };
    expect(tuiModeAddition(custom, [custom])).toEqual({ ok: true, args: [] });
  });
});
