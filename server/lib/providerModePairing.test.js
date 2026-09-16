import { describe, it, expect } from 'vitest';
import { canAddTuiMode, tuiModeAddition } from './providerModePairing.js';

// One verdict feeds both the card's button and the endpoint's refusal, so what
// matters here is that each refusal keeps its OWN answer: an unsupported record
// and a taken sibling id are different failures to a caller, and a known
// harness and an unknown one differ in what argv the sibling starts with.

const CLAUDE_CLI = { id: 'claude-code', name: 'Claude Code', type: 'cli', command: 'claude' };

describe('tuiModeAddition', () => {
  it('starts a known harness at its recipe’s proven interactive argv', () => {
    // Not a guess and not empty: `--dangerously-skip-permissions` is what the
    // Claude row declares for its TUI mode, and a sibling minted without it
    // stops at a permission prompt the moment the Shell page launches it.
    expect(tuiModeAddition(CLAUDE_CLI, [CLAUDE_CLI])).toEqual({ ok: true, args: ['--dangerously-skip-permissions'] });
    // A fresh array each call — a caller storing it must not be able to mutate
    // the frozen recipe row every later mint reads.
    const first = tuiModeAddition(CLAUDE_CLI, [CLAUDE_CLI]);
    first.args.push('--tampered');
    expect(tuiModeAddition(CLAUDE_CLI, [CLAUDE_CLI]).args).toEqual(['--dangerously-skip-permissions']);
  });

  it('lets an UNKNOWN harness through with empty argv rather than a guess', () => {
    const custom = { id: 'my-agent', name: 'My Agent', type: 'cli', command: '/opt/bin/my-agent' };
    expect(tuiModeAddition(custom, [custom])).toEqual({ ok: true, args: [] });
  });

  it('refuses a KNOWN harness that declares no interactive mode', () => {
    // OpenChamber is CLI-only in the registry. Minting a TUI record for it
    // would store a mode the program does not have.
    const openchamber = { id: 'openchamber', name: 'OpenChamber', type: 'cli', command: 'openchamber' };
    expect(tuiModeAddition(openchamber, [openchamber])).toMatchObject({ ok: false, status: 400 });
  });

  it('refuses a TUI record and an api record', () => {
    // The CLI id is the stem, so minting it FROM the TUI half would rename the
    // record that already exists instead of adding one beside it.
    expect(canAddTuiMode({ id: 'claude-code-tui', name: 'Claude Code TUI', type: 'tui', command: 'claude' }, [])).toBe(false);
    expect(canAddTuiMode({ id: 'openai', name: 'OpenAI', type: 'api', endpoint: 'https://api.example.com' }, [])).toBe(false);
    expect(canAddTuiMode({ ...CLAUDE_CLI, command: '  ' }, [])).toBe(false);
  });

  it('answers 409 — not a suffixed id — when the sibling id is already taken', () => {
    // `mintRouteIds` suffixes a whole SET on collision because it owns both
    // halves. Here the CLI id is fixed, so `claude-code-tui` existing means
    // something else is standing in that slot; silently minting
    // `claude-code-tui-2` would produce a record nothing ever groups.
    const taken = { id: 'claude-code-tui', name: 'Something Else', type: 'tui', command: 'other' };
    const verdict = tuiModeAddition(CLAUDE_CLI, [CLAUDE_CLI, taken]);
    expect(verdict).toMatchObject({ ok: false, status: 409 });
    expect(verdict.message).toContain('claude-code-tui');
  });
});
