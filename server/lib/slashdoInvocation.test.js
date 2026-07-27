import { describe, it, expect } from 'vitest';
import {
  SLASHDO_INLINE_BUDGET_CHARS,
  SLASHDO_INVOCATION_STYLES,
  SLASHDO_REVIEWER_INCLUDES,
  SLASHDO_REVIEWER_INCLUDE_NAMES,
  buildSlashdoSection,
  canTypeSlashCommands,
  isValidSlashdoCommand,
  resolveSlashdoInvocation,
  resolveSlashdoStyle,
  slashdoSkillName,
  unreachableReviewerIncludes,
} from './slashdoInvocation.js';
import { loadSlashdoFile } from './fileUtils.js';

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

  describe('assumeClaudeWhenUnknown (#3114)', () => {
    // The posture resolves the command the SPAWNERS would infer from a blank
    // `provider.command` (inferTuiCommand — the same fallback agentTuiSpawning.js
    // and buildCliSpawnConfig apply), rather than guessing "blank means Claude".
    it('resolves a blank command through the spawner fallback', () => {
      expect(resolveSlashdoStyle({ assumeClaudeWhenUnknown: true }))
        .toBe(SLASHDO_INVOCATION_STYLES.SLASH_NAMESPACED);
      // A custom provider id with no command launches `claude`, so it IS
      // slashdo-capable — the case a naive `!providerId && !providerCommand`
      // check would have missed.
      expect(resolveSlashdoStyle({ providerId: 'my-custom-agent', assumeClaudeWhenUnknown: true }))
        .toBe(SLASHDO_INVOCATION_STYLES.SLASH_NAMESPACED);
    });

    it('honors the id when the spawner fallback resolves a non-Claude command', () => {
      // `codex-tui` with no command launches `codex`, which gets skills.
      expect(resolveSlashdoStyle({ providerId: 'codex-tui', assumeClaudeWhenUnknown: true }))
        .toBe(SLASHDO_INVOCATION_STYLES.SKILL);
      expect(resolveSlashdoStyle({ providerId: 'antigravity-tui', assumeClaudeWhenUnknown: true }))
        .toBe(SLASHDO_INVOCATION_STYLES.SKILL);
      expect(resolveSlashdoStyle({ providerId: 'kimi-tui', assumeClaudeWhenUnknown: true }))
        .toBe(SLASHDO_INVOCATION_STYLES.SKILL);
    });

    it('never overrides a command the provider actually names', () => {
      expect(resolveSlashdoStyle({ providerCommand: 'agy', assumeClaudeWhenUnknown: true }))
        .toBe(SLASHDO_INVOCATION_STYLES.SKILL);
      expect(resolveSlashdoStyle({ providerCommand: 'codex', assumeClaudeWhenUnknown: true }))
        .toBe(SLASHDO_INVOCATION_STYLES.SKILL);
      expect(resolveSlashdoStyle({ providerId: 'opencode-tui', providerCommand: 'opencode', assumeClaudeWhenUnknown: true }))
        .toBe(SLASHDO_INVOCATION_STYLES.SLASH_FLAT);
    });

    it('lean mode still wins over the spawner-inferred command', () => {
      expect(resolveSlashdoStyle({ leanMode: true, assumeClaudeWhenUnknown: true }))
        .toBe(SLASHDO_INVOCATION_STYLES.SKILL);
    });

    it('leaves the strict default untouched — a blank command is never read as Claude', () => {
      expect(resolveSlashdoStyle({})).toBe(SLASHDO_INVOCATION_STYLES.SKILL);
      expect(resolveSlashdoStyle({ providerId: 'my-custom-agent' })).toBe(SLASHDO_INVOCATION_STYLES.SKILL);
    });
  });
});

describe('canTypeSlashCommands', () => {
  it('is true only for a Claude session that loaded its project commands', () => {
    expect(canTypeSlashCommands({ providerId: 'claude-code' })).toBe(true);
    expect(canTypeSlashCommands({ providerId: 'claude-code-tui', providerCommand: 'claude' })).toBe(true);
    // Path-configured / renamed claude under a custom id — the case the old
    // inline id allowlist in agentPromptBuilder.js missed.
    expect(canTypeSlashCommands({ providerId: 'my-agent', providerCommand: '/opt/homebrew/bin/claude' })).toBe(true);
  });

  it('is false for every host that gets skills or flat commands', () => {
    for (const providerId of ['codex', 'codex-tui', 'grok-tui', 'antigravity-tui', 'kimi-tui']) {
      expect(canTypeSlashCommands({ providerId })).toBe(false);
    }
    expect(canTypeSlashCommands({ providerId: 'opencode-ollama-tui', providerCommand: 'opencode' })).toBe(false);
    expect(canTypeSlashCommands({ providerId: 'claude-ollama-tui', providerCommand: 'claude', leanMode: true })).toBe(false);
  });

  it('defaults to the spawner posture but honors an explicit opt-out', () => {
    expect(canTypeSlashCommands({})).toBe(true);
    expect(canTypeSlashCommands({ providerId: 'my-custom-agent' })).toBe(true);
    // The api path opts out: an unidentified HTTP-API provider is not a latent
    // local `claude` the way a blank CLI/TUI provider is.
    expect(canTypeSlashCommands({ assumeClaudeWhenUnknown: false })).toBe(false);
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

// -----------------------------------------------------------------------------
// Size controls (#3110)
// -----------------------------------------------------------------------------
describe('buildSlashdoSection — inline budget vs file pointer', () => {
  const codex = () => resolveSlashdoInvocation({ command: 'review', providerId: 'codex' });
  const big = 'x'.repeat(SLASHDO_INLINE_BUDGET_CHARS + 1);
  const small = 'y'.repeat(SLASHDO_INLINE_BUDGET_CHARS - 1);
  const PATH = '/install/data/cos/slashdo-resolved/review.md';

  it('emits the pointer and NOT the body when over budget with a file-tools host', () => {
    const section = buildSlashdoSection(codex(), big, { bodyPath: PATH });
    expect(section).toContain(PATH);
    expect(section).not.toContain(big);
    // The directive still has to be actionable on its own.
    expect(section).toContain('do-review');
    expect(section).toMatch(/READ THAT FILE/);
  });

  it('inlines the body when it is under budget even with a path available', () => {
    const section = buildSlashdoSection(codex(), small, { bodyPath: PATH });
    expect(section).toContain(small);
    expect(section).not.toContain(PATH);
  });

  it('inlines an over-budget body when no path is offered (an api provider has no file tools)', () => {
    const section = buildSlashdoSection(codex(), big);
    expect(section).toContain(big);
    expect(section).not.toContain('slashdo-resolved');
  });

  it('pins --review-with whenever the body was pruned, so the run matches the body it got', () => {
    const section = buildSlashdoSection(codex(), big, { bodyPath: PATH, reviewWith: 'codex,copilot' });
    expect(section).toContain('--review-with codex,copilot');
    expect(section).toMatch(/omitted as unreachable/);
  });

  it('omits the pin when nothing was pruned', () => {
    expect(buildSlashdoSection(codex(), small)).not.toContain('--review-with');
  });
});

describe('unreachableReviewerIncludes', () => {
  it('prunes nothing when the reviewer set is unresolved or empty', () => {
    // Absent / empty / non-array all mean "we do not know" — an over-pruned
    // prompt that drops the loop the agent needs is worse than a fat one.
    expect(unreachableReviewerIncludes()).toEqual([]);
    expect(unreachableReviewerIncludes({ reviewers: null })).toEqual([]);
    expect(unreachableReviewerIncludes({ reviewers: [] })).toEqual([]);
    expect(unreachableReviewerIncludes({ reviewers: 'codex' })).toEqual([]);
  });

  it('prunes nothing when the list names a reviewer this mapping does not know', () => {
    // A new REVIEWER_VALUES entry that lands without a mapping row here must
    // degrade to keep-all, not silently drop the loop it needed.
    expect(unreachableReviewerIncludes({ reviewers: ['some-future-reviewer'] })).toEqual([]);
    expect(unreachableReviewerIncludes({ reviewers: ['codex', 'some-future-reviewer'] })).toEqual([]);
  });

  it('keeps only the local-agent loop for a lone CLI reviewer', () => {
    const skipped = unreachableReviewerIncludes({ reviewers: ['codex'] });
    expect(skipped).not.toContain(SLASHDO_REVIEWER_INCLUDES.localAgent);
    // Single reviewer ⇒ the multi-reviewer wrapper is unreachable too.
    expect(skipped).toContain(SLASHDO_REVIEWER_INCLUDES.multi);
    expect(skipped).toContain(SLASHDO_REVIEWER_INCLUDES.copilot);
    expect(skipped).toContain(SLASHDO_REVIEWER_INCLUDES.localModel);
    expect(skipped).toContain(SLASHDO_REVIEWER_INCLUDES.username);
  });

  it('maps every CLI reviewer onto the one shared local-agent loop', () => {
    for (const slug of ['claude', 'codex', 'antigravity', 'grok']) {
      expect(unreachableReviewerIncludes({ reviewers: [slug] }))
        .not.toContain(SLASHDO_REVIEWER_INCLUDES.localAgent);
    }
  });

  it('maps both local-model reviewers onto the local-model loop', () => {
    for (const slug of ['ollama', 'lmstudio']) {
      expect(unreachableReviewerIncludes({ reviewers: [slug] }))
        .not.toContain(SLASHDO_REVIEWER_INCLUDES.localModel);
    }
  });

  it('keeps the multi-reviewer wrapper as soon as there are two review sources', () => {
    expect(unreachableReviewerIncludes({ reviewers: ['codex', 'copilot'] }))
      .not.toContain(SLASHDO_REVIEWER_INCLUDES.multi);
    // One keyed reviewer + one @login is also two sources.
    expect(unreachableReviewerIncludes({ reviewers: ['codex'], usernames: ['octocat'] }))
      .not.toContain(SLASHDO_REVIEWER_INCLUDES.multi);
  });

  it('keeps the arbitrary-@login loop only when a username reviewer is present', () => {
    expect(unreachableReviewerIncludes({ reviewers: ['codex'], usernames: ['octocat'] }))
      .not.toContain(SLASHDO_REVIEWER_INCLUDES.username);
    expect(unreachableReviewerIncludes({ reviewers: ['codex'] }))
      .toContain(SLASHDO_REVIEWER_INCLUDES.username);
  });

  it('never returns a name outside the reviewer-variant universe', () => {
    for (const skipped of [
      unreachableReviewerIncludes({ reviewers: ['codex'] }),
      unreachableReviewerIncludes({ reviewers: ['copilot', 'ollama'] }),
      unreachableReviewerIncludes({ reviewers: ['claude'], usernames: ['octocat'] }),
    ]) {
      for (const name of skipped) expect(SLASHDO_REVIEWER_INCLUDE_NAMES).toContain(name);
    }
  });
});

// -----------------------------------------------------------------------------
// Budget pin — the ONE place these tests touch the vendored submodule (#3110)
// -----------------------------------------------------------------------------
// The budget only does its job if every big command is actually over it. If a
// slashdo release shrinks one under 24,000 chars it would silently flip back to
// being pasted whole, which is exactly the regression this issue removed. These
// assert on measured SIZE, never on the submodule's text, and skip when the
// submodule isn't checked out.
describe('SLASHDO_INLINE_BUDGET_CHARS pin against the bundled commands', () => {
  // Commands whose expanded bodies are large enough that pasting them dominates
  // a prompt (measured 2026-07: 38KB–317KB). Not the whole catalog — small
  // commands like `push` (3KB) are SUPPOSED to stay inlined.
  const OVER_BUDGET_COMMANDS = ['review', 'better', 'better-swift', 'release', 'depfree', 'next', 'replan', 'plan-task'];

  it('every large bundled command is over the budget, even fully pruned', async () => {
    const submodulePresent = await loadSlashdoFile('review', { stripFrontmatter: true }).catch(() => null);
    if (!submodulePresent) return; // submodule not checked out — nothing to pin

    for (const command of OVER_BUDGET_COMMANDS) {
      // Prune EVERY reviewer variant — the smallest body this code can produce.
      const pruned = await loadSlashdoFile(command, {
        stripFrontmatter: true,
        skipIncludes: SLASHDO_REVIEWER_INCLUDE_NAMES,
      });
      expect(pruned, `slashdo ships commands/do/${command}.md`).toBeTruthy();
      expect(
        pruned.length,
        `${command} is ${pruned.length} chars fully pruned — under the ${SLASHDO_INLINE_BUDGET_CHARS} budget, so it would be INLINED again. Either it genuinely shrank (lower the budget deliberately) or the prune is over-eager.`
      ).toBeGreaterThan(SLASHDO_INLINE_BUDGET_CHARS);
    }
  });

  it('pruning unreachable reviewer loops measurably shrinks a reviewer-heavy command', async () => {
    const full = await loadSlashdoFile('review', { stripFrontmatter: true }).catch(() => null);
    if (!full) return;
    // A lone codex reviewer keeps only the local-agent loop.
    const pruned = await loadSlashdoFile('review', {
      stripFrontmatter: true,
      skipIncludes: unreachableReviewerIncludes({ reviewers: ['codex'] }),
    });
    // Shape, not an exact byte count: pruning must be a real double-digit-percent
    // reduction, and must not be a no-op that quietly stopped working.
    expect(pruned.length).toBeLessThan(full.length * 0.75);
    // The kept loop is still there and the omission is announced, not silent.
    expect(pruned).toContain('not applicable to this run');
    expect(pruned).not.toContain(`\`${SLASHDO_REVIEWER_INCLUDES.localAgent}\` omitted`);
  });
});
