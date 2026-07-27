import { describe, it, expect } from 'vitest';
import {
  SLASHDO_INVOCATION_STYLES,
  buildSlashdoSection,
  hostTypesSlashdoCommands,
  isValidSlashdoCommand,
  resolveSlashdoInvocation,
  resolveSlashdoStyle,
  slashdoSkillName,
} from './slashdoInvocation.js';
import { inferTuiCommand } from './providerModels.js';

describe('isValidSlashdoCommand', () => {
  it('accepts bare command names', () => {
    expect(isValidSlashdoCommand('next')).toBe(true);
    expect(isValidSlashdoCommand('plan-task')).toBe(true);
    expect(isValidSlashdoCommand('pr-better')).toBe(true);
  });

  it('rejects anything that could escape commands/do/', () => {
    expect(isValidSlashdoCommand('../../etc/passwd')).toBe(false);
    expect(isValidSlashdoCommand('do/plan-task')).toBe(false);
    expect(isValidSlashdoCommand('plan task')).toBe(false);
    expect(isValidSlashdoCommand('Plan-Task')).toBe(false);
    expect(isValidSlashdoCommand('-leading')).toBe(false);
    expect(isValidSlashdoCommand('trailing-')).toBe(false);
    expect(isValidSlashdoCommand('')).toBe(false);
    expect(isValidSlashdoCommand(null)).toBe(false);
    expect(isValidSlashdoCommand(undefined)).toBe(false);
    expect(isValidSlashdoCommand(42)).toBe(false);
  });
});

describe('slashdoSkillName', () => {
  it('mirrors the installer getSkillName mapping', () => {
    expect(slashdoSkillName('plan-task')).toBe('do-plan-task');
  });
});

describe('resolveSlashdoStyle', () => {
  it('gives Claude Code the namespaced slash command', () => {
    expect(resolveSlashdoStyle({ providerId: 'claude-code' })).toBe(SLASHDO_INVOCATION_STYLES.SLASH_NAMESPACED);
    expect(resolveSlashdoStyle({ providerId: 'claude-code-bedrock' })).toBe(SLASHDO_INVOCATION_STYLES.SLASH_NAMESPACED);
  });

  it('recognises a path-configured or renamed claude binary', () => {
    expect(resolveSlashdoStyle({ providerId: 'my-custom-agent', providerCommand: '/opt/homebrew/bin/claude' }))
      .toBe(SLASHDO_INVOCATION_STYLES.SLASH_NAMESPACED);
    expect(resolveSlashdoStyle({ providerId: 'my-custom-agent', providerCommand: 'C:\\tools\\claude.exe' }))
      .toBe(SLASHDO_INVOCATION_STYLES.SLASH_NAMESPACED);
  });

  it('gives OpenCode the flat slash command, path-configured included', () => {
    expect(resolveSlashdoStyle({ providerId: 'opencode' })).toBe(SLASHDO_INVOCATION_STYLES.SLASH_FLAT);
    expect(resolveSlashdoStyle({ providerId: 'renamed', providerCommand: '/usr/local/bin/opencode' }))
      .toBe(SLASHDO_INVOCATION_STYLES.SLASH_FLAT);
  });

  it('gives every skill-based CLI the skill style', () => {
    for (const providerId of ['codex', 'codex-tui', 'grok-cli', 'grok-tui', 'antigravity']) {
      expect(resolveSlashdoStyle({ providerId })).toBe(SLASHDO_INVOCATION_STYLES.SKILL);
    }
    expect(resolveSlashdoStyle({ providerId: 'renamed', providerCommand: '/usr/bin/codex' }))
      .toBe(SLASHDO_INVOCATION_STYLES.SKILL);
  });

  it('falls back to skill for an unidentified provider (inlining works everywhere)', () => {
    expect(resolveSlashdoStyle({})).toBe(SLASHDO_INVOCATION_STYLES.SKILL);
    expect(resolveSlashdoStyle({ providerId: 'mystery-cli', providerCommand: '' }))
      .toBe(SLASHDO_INVOCATION_STYLES.SKILL);
  });

  it('falls back to skill in lean mode — a --bare claude session has no project commands', () => {
    expect(resolveSlashdoStyle({ providerId: 'claude-ollama', providerCommand: 'claude', leanMode: true }))
      .toBe(SLASHDO_INVOCATION_STYLES.SKILL);
  });

});

// #3108 — the one gate behind agentPromptBuilder's completion sections. It asks
// about the process that will really launch, so a blank command is resolved
// through the same provider-id mapping the spawners use.
describe('hostTypesSlashdoCommands', () => {
  it('is true for Claude Code, by id or by launch command', () => {
    expect(hostTypesSlashdoCommands({ providerId: 'claude-code' })).toBe(true);
    expect(hostTypesSlashdoCommands({ providerId: 'claude-code-bedrock' })).toBe(true);
    // Path-configured / renamed claude — the id allowlist this replaced missed it.
    expect(hostTypesSlashdoCommands({ providerId: 'my-agent', providerCommand: '/opt/homebrew/bin/claude' })).toBe(true);
    expect(hostTypesSlashdoCommands({ providerId: 'my-agent', providerCommand: 'C:\\tools\\claude.exe' })).toBe(true);
  });

  it('resolves a blank command the way the spawners do', () => {
    // No command configured → the provider id picks the binary. A bare/unknown id
    // spawns `claude`, so slash commands work…
    expect(hostTypesSlashdoCommands({})).toBe(true);
    expect(hostTypesSlashdoCommands({ providerId: 'claude-ollama' })).toBe(true);
    // …while a codex/antigravity/gemini/kimi id spawns that binary, which gets
    // Agent Skills rather than slash commands.
    for (const providerId of ['codex-tui', 'antigravity-tui', 'gemini-tui', 'kimi-tui']) {
      expect(hostTypesSlashdoCommands({ providerId })).toBe(false);
    }
  });

  it('never lets the provider id override the binary actually configured', () => {
    expect(hostTypesSlashdoCommands({ providerId: 'claude-code', providerCommand: 'codex' })).toBe(false);
  });

  it('is false for OpenCode (it types /do-x, not the /do:pr PortOS workflows use)', () => {
    expect(hostTypesSlashdoCommands({ providerId: 'opencode-tui', providerCommand: 'opencode' })).toBe(false);
  });

  it('reads a blank-command OpenCode provider the way the spawner does — as claude', () => {
    // Not a wart in this gate: `inferTuiCommand` has no opencode branch, so an
    // opencode provider that configures NO command really is spawned as `claude`
    // (both by `spawnTuiAgent` and `buildCliSpawnConfig`), and slash commands do
    // work in that session. Locked in so a future opencode branch in
    // `inferTuiCommand` has to flip this deliberately, in lockstep.
    expect(hostTypesSlashdoCommands({ providerId: 'opencode' })).toBe(true);
    expect(inferTuiCommand('opencode')).toBe('claude');
  });

  it('is false in lean mode — a --bare claude session has no project commands', () => {
    expect(hostTypesSlashdoCommands({ providerId: 'claude-ollama-tui', providerCommand: 'claude', leanMode: true })).toBe(false);
  });

  it('differs from resolveSlashdoStyle exactly on the blank-command reading', () => {
    // Same input, opposite answers — and that is the point: phrasing an invocation
    // must not guess `/do:x` for a host it cannot positively identify, while this
    // gate knows a blank command launches `claude`.
    expect(resolveSlashdoStyle({ providerId: 'claude-ollama' })).toBe(SLASHDO_INVOCATION_STYLES.SKILL);
    expect(hostTypesSlashdoCommands({ providerId: 'claude-ollama' })).toBe(true);
  });
});

describe('resolveSlashdoInvocation', () => {
  it('returns null without a valid command', () => {
    expect(resolveSlashdoInvocation({})).toBeNull();
    expect(resolveSlashdoInvocation({ command: '' })).toBeNull();
    expect(resolveSlashdoInvocation({ command: '../secrets' })).toBeNull();
  });

  it('renders the Claude Code invocation with args', () => {
    const r = resolveSlashdoInvocation({ command: 'plan-task', args: 'add a widget', providerId: 'claude-code' });
    expect(r.invocation).toBe('/do:plan-task add a widget');
  });

  it('renders the OpenCode invocation', () => {
    const r = resolveSlashdoInvocation({ command: 'plan-task', args: 'add a widget', providerCommand: 'opencode' });
    expect(r.invocation).toBe('/do-plan-task add a widget');
  });

  it('renders a skill directive with no slash-command form', () => {
    const r = resolveSlashdoInvocation({ command: 'plan-task', args: 'add a widget', providerId: 'codex' });
    expect(r.style).toBe(SLASHDO_INVOCATION_STYLES.SKILL);
    expect(r.invocation).toContain('do-plan-task');
    expect(r.invocation).not.toContain('/do:');
  });

  it('omits the argument suffix when there are no args', () => {
    expect(resolveSlashdoInvocation({ command: 'next', providerId: 'claude-code' }).invocation).toBe('/do:next');
    expect(resolveSlashdoInvocation({ command: 'next', args: '   ', providerId: 'claude-code' }).invocation).toBe('/do:next');
  });
});

describe('buildSlashdoSection', () => {
  it('returns empty for an unresolved command', () => {
    expect(buildSlashdoSection(null)).toBe('');
  });

  it('emits the slash invocation in a code block and points at the task above', () => {
    const section = buildSlashdoSection(resolveSlashdoInvocation({ command: 'review', providerId: 'claude-code' }));
    expect(section).toContain('/do:review');
    expect(section).toContain('Apply it to the task described above.');
  });

  // PortOS only exposes slashdo as slash commands through the repo-local
  // `.claude/commands/do/` symlinks, which don't exist in a managed app's
  // workspace — so the procedure travels with the prompt for EVERY host, and a
  // typed invocation is only a shortcut for the ones that happen to have it.
  it.each([
    ['claude-code', '/do:review'],
    ['opencode', '/do-review'],
    ['codex', 'do-review'],
  ])('inlines the command body for %s', (providerId, expectedInvocation) => {
    const section = buildSlashdoSection(
      resolveSlashdoInvocation({ command: 'review', providerId }),
      '# Example Procedure\n\nStep one.'
    );
    expect(section).toContain(expectedInvocation);
    expect(section).toContain('# Example Procedure');
  });

  it('still renders a usable directive when the body could not be loaded', () => {
    const section = buildSlashdoSection(resolveSlashdoInvocation({ command: 'review', providerId: 'codex' }), null);
    expect(section).toContain('do-review');
    expect(section.trim()).not.toBe('');
  });
});
