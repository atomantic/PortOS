import { describe, it, expect } from 'vitest';
import {
  SLASHDO_INVOCATION_STYLES,
  buildSlashdoSection,
  isValidSlashdoCommand,
  resolveSlashdoInvocation,
  resolveSlashdoStyle,
  slashdoSkillName,
} from './slashdoInvocation.js';

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
