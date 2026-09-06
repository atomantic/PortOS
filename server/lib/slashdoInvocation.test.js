import { describe, it, expect } from 'vitest';
import {
  SLASHDO_INLINE_BUDGET_CHARS,
  SLASHDO_INVOCATION_STYLES,
  SLASHDO_REVIEWER_INCLUDES,
  SLASHDO_REVIEWER_INCLUDE_NAMES,
  agentOwnsPrWorkflow,
  buildSlashdoSection,
  canTypeSlashCommands,
  resolveOwnsPrWorkflow,
  isValidSlashdoCommand,
  parseExplicitReviewWith,
  resolveSlashdoInvocation,
  resolveSlashdoStyle,
  slashdoSkillName,
  unreachableReviewerIncludes,
} from './slashdoInvocation.js';
import { loadSlashdoFile } from './slashdoLoader.js';
import { requireSlashdoSubmoduleInCi } from './testHelper.js';

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

describe('agentOwnsPrWorkflow (#3733)', () => {
  it('is true for every local coding harness, slash commands or not', () => {
    expect(agentOwnsPrWorkflow({ providerType: 'tui' })).toBe(true);
    expect(agentOwnsPrWorkflow({ providerType: 'cli' })).toBe(true);
  });

  it('is a WEAKER question than canTypeSlashCommands — that is the whole point', () => {
    // codex/grok/agy can't type `/do:pr` (slashdo installs there as skills), but
    // they run `gh pr create` and the reviewer CLIs perfectly well. Conflating
    // the two is what forced a second `sys-rl-*` agent onto every one of their runs.
    for (const providerId of ['codex-tui', 'grok-tui', 'antigravity-tui', 'opencode-ollama-tui']) {
      expect(canTypeSlashCommands({ providerId })).toBe(false);
      expect(agentOwnsPrWorkflow({ providerType: 'tui' })).toBe(true);
    }
  });

  it('is false for a lean --bare session, which fumbles multi-step flows', () => {
    expect(agentOwnsPrWorkflow({ providerType: 'tui', leanMode: true })).toBe(false);
    expect(agentOwnsPrWorkflow({ providerType: 'cli', leanMode: true })).toBe(false);
  });

  it('is false for an HTTP api provider and for an unknown type — neither has a shell', () => {
    expect(agentOwnsPrWorkflow({ providerType: 'api' })).toBe(false);
    expect(agentOwnsPrWorkflow({})).toBe(false);
    expect(agentOwnsPrWorkflow()).toBe(false);
  });
});

describe('resolveOwnsPrWorkflow (#3733)', () => {
  it('trusts the stamp — cleanup must act on what the prompt actually said', () => {
    // Including when the stamp disagrees with a fresh derivation: a provider
    // reconfigured mid-run must not change the answer for an agent already
    // prompted under the old one.
    expect(resolveOwnsPrWorkflow({ persisted: true, providerId: 'codex', providerCommand: 'codex' })).toBe(true);
    expect(resolveOwnsPrWorkflow({ persisted: false, providerId: 'claude-code', providerCommand: 'claude' })).toBe(false);
  });

  it('falls back to the slash-command gate for a pre-#3733 record', () => {
    // Those runs really were prompted by the old builder, whose gate this was.
    expect(resolveOwnsPrWorkflow({ persisted: undefined, providerId: 'claude-code', providerCommand: 'claude' })).toBe(true);
    expect(resolveOwnsPrWorkflow({ persisted: undefined, providerId: 'codex', providerCommand: 'codex' })).toBe(false);
    expect(resolveOwnsPrWorkflow({ persisted: undefined, providerId: 'claude-ollama', providerCommand: 'claude', leanMode: true })).toBe(false);
  });

  it('treats a non-boolean stamp as absent, not as false', () => {
    // `null` from a JSON round-trip must not silently claim PortOS owns the PR.
    expect(resolveOwnsPrWorkflow({ persisted: null, providerId: 'claude-code' })).toBe(true);
    expect(resolveOwnsPrWorkflow({ persisted: 'true', providerId: 'codex', providerCommand: 'codex' })).toBe(false);
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

  it('uses a staged entrypoint even when it is under budget', () => {
    const section = buildSlashdoSection(codex(), small, { bodyPath: PATH });
    expect(section).not.toContain(small);
    expect(section).toContain(PATH);
    expect(section).toContain('relative to the file containing that reference');
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

  it('keeps the local-agent loop (and the wrapper) for a lone CLI reviewer', () => {
    const skipped = unreachableReviewerIncludes({ reviewers: ['codex'] });
    expect(skipped).not.toContain(SLASHDO_REVIEWER_INCLUDES.localAgent);
    expect(skipped).toContain(SLASHDO_REVIEWER_INCLUDES.copilot);
    expect(skipped).toContain(SLASHDO_REVIEWER_INCLUDES.localModel);
    expect(skipped).toContain(SLASHDO_REVIEWER_INCLUDES.username);
  });

  it('never prunes the orchestration wrapper for a resolved reviewer, single or not', () => {
    // slashdo dispatches EVERY non-empty reviewer list through
    // multi-reviewer-loop ("may contain a single entry"), so pruning it for a
    // lone reviewer left the inner loop with nothing to dispatch it.
    for (const reviewers of [['codex'], ['copilot'], ['ollama'], ['codex', 'copilot']]) {
      expect(unreachableReviewerIncludes({ reviewers }))
        .not.toContain(SLASHDO_REVIEWER_INCLUDES.multi);
    }
    expect(unreachableReviewerIncludes({ reviewers: [], usernames: ['octocat'] }))
      .not.toContain(SLASHDO_REVIEWER_INCLUDES.multi);
  });

  it('maps every CLI reviewer onto the one shared local-agent loop', () => {
    for (const slug of ['claude', 'codex', 'antigravity', 'grok', 'cursor']) {
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

// The upstream renderer owns reference semantics. Exercise its shipped output
// here when the submodule is initialized; fixtures cover dispatch and staging
// separately without requiring a submodule in every CI shard.
describe('bundled command context budget', () => {
  it('keeps the better entrypoint small and preserves an eager procedure', async () => {
    const { existsSync } = await import('fs');
    if (!existsSync(new URL('../../lib/slashdo/src/transformer.js', import.meta.url))) {
      requireSlashdoSubmoduleInCi(false);
      return;
    }
    const { loadSlashdoBundle } = await import('./slashdoLoader.js');
    const bundle = await loadSlashdoBundle('better', { stripFrontmatter: true });
    const eager = await loadSlashdoFile('better', { stripFrontmatter: true });
    expect(bundle.body.length).toBeLessThan(SLASHDO_INLINE_BUDGET_CHARS);
    expect(Object.keys(bundle.files).length).toBeGreaterThan(0);
    expect(bundle.body.length).toBeLessThan(eager.length / 4);
    expect(eager).not.toMatch(/^!read /m);
  });
});

// slashdo's `--review-with` grammar is the one thing PortOS re-parses rather than
// owns, and the whole point of the parser is that anything it can't read falls
// through to "prune and pin nothing". A prompt-level test can't cheaply pin that
// matrix — and a mis-read entry is invisible there, since the wrong answer is a
// well-formed prompt naming the wrong reviewer.
describe('parseExplicitReviewWith', () => {
  it('reads no flag as no explicit selection', () => {
    expect(parseExplicitReviewWith('--issues 42')).toBeNull();
    expect(parseExplicitReviewWith('')).toBeNull();
    expect(parseExplicitReviewWith(undefined)).toBeNull();
    // A different flag that merely shares the prefix is not ours to read.
    expect(parseExplicitReviewWith('--review-with-nothing x')).toBeNull();
  });

  it.each([
    ['spaced form', '--review-with ollama', ['ollama'], []],
    ['equals form', '--review-with=codex,claude', ['codex', 'claude'], []],
    ['slashdo agy slug and its aliases', '--review-with agy,gemini,antigravity', ['antigravity'], []],
    ['cursor-agent alias', '--review-with cursor-agent', ['cursor'], []],
    ['suffixes and a model bracket', '--review-with agy[gemini-3.8-flash]~opt~max=1~effort=medium', ['antigravity'], []],
    ['a quoted model id containing spaces', '--review-with "agy[Gemini 3.5 Flash (High)]~opt"', ['antigravity'], []],
    ['a @login, bot suffix included', '--review-with codex,@review-bot[bot]', ['codex'], ['review-bot[bot]']],
    ['repeats that agree', '--review-with codex --review-with codex', ['codex'], []],
  ])('resolves %s', (_label, args, reviewers, usernames) => {
    expect(parseExplicitReviewWith(args)).toEqual({ explicit: true, none: false, reviewers, usernames });
  });

  it.each(['--review-with none', '--review-with NONE', '--review-with=none'])('reads %s as the opt-out tombstone', (args) => {
    expect(parseExplicitReviewWith(args)).toEqual({ explicit: true, none: true, reviewers: [], usernames: [] });
  });

  it.each([
    ['a missing value', '--review-with'],
    ['the next flag where the value should be', '--review-with --merge'],
    ['a shell expansion we cannot see through', '--review-with $REVIEWER'],
    ['an unterminated quote', '--review-with "codex'],
    ['an unterminated model bracket', '--review-with codex[a --merge'],
    ['a slug slashdo has no counterpart for', '--review-with lmstudio'],
    ['a slug outside the grammar entirely', '--review-with some-future-reviewer'],
    ['a bracket on a reviewer that takes none', '--review-with copilot[x]'],
    ['an unknown per-entry suffix', '--review-with codex~bogus'],
    ['a repeated per-entry suffix', '--review-with codex~max=1~max=2'],
    ['a non-integer round cap', '--review-with codex~max=two'],
    ['an effort outside the ladder', '--review-with codex~effort=turbo'],
    ['the tombstone mixed with real slugs', '--review-with none,codex'],
    ['repeats that disagree', '--review-with codex --review-with claude'],
    ['a malformed login', '--review-with @-nope'],
  ])('refuses to guess at %s', (_label, args) => {
    expect(parseExplicitReviewWith(args)).toEqual({
      explicit: true, unresolved: true, reviewers: [], usernames: [],
    });
  });
});
