/**
 * Tests for the light-vs-full context split in buildAgentPrompt.
 *
 * The split is by `provider.type`:
 *   - `tui` / `cli` → light prompt (Claude Code, Codex, Gemini — agentic
 *     CLIs with native filesystem tools and CLAUDE.md loading)
 *   - `api`         → full prompt (LM Studio, raw OpenAI/Anthropic — no
 *     native filesystem access, so we paste in memory/CLAUDE.md/etc.)
 *
 * The light path is the focus here because it's the new code. The full
 * path is exercised by a single negative assertion that confirms the
 * obsolete "# Chief of Staff Agent Briefing" header and "You are an
 * autonomous agent…" preamble are gone from BOTH paths.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock heavy dependencies used by the full (api) prompt path so the API-routing
// regression test doesn't try to hit the memory DB, digital-twin services, or
// disk-based slashdo loaders. Light-path tests don't invoke these at all, so
// the mocks are no-ops for them.
vi.mock('./memoryRetriever.js', () => ({
  getMemorySection: vi.fn().mockResolvedValue(null),
}));
vi.mock('./digital-twin.js', () => ({
  getDigitalTwinForPrompt: vi.fn().mockResolvedValue(null),
}));
vi.mock('./tools.js', () => ({
  getToolsSummaryForPrompt: vi.fn().mockResolvedValue(''),
}));
vi.mock('./promptService.js', () => ({
  buildPrompt: vi.fn().mockResolvedValue(null), // force fallback template
}));
vi.mock('./providers.js', () => ({
  getActiveProvider: vi.fn().mockResolvedValue(null),
}));
vi.mock('../lib/promptRunner.js', () => ({
assertProvider: (provider, { message, code, status = 503 } = {}) => {
    if (provider) return;
    const err = new Error(message || 'No AI provider available');
    if (code) { err.status = status; err.code = code; }
    throw err;
  },
  runPromptThroughProvider: vi.fn().mockResolvedValue(null),
}));
vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadSlashdoFile: vi.fn().mockResolvedValue(null),
  };
});
vi.mock('./jira.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  createTicket: vi.fn().mockResolvedValue(null),
}));

import { buildLightContextPrompt, buildAgentPrompt } from './agentPromptBuilder.js';
import { isTruthyMeta } from './agentState.js';

function makeTask(overrides = {}) {
  return {
    id: 'task-test-1',
    priority: 'HIGH',
    description: 'Add a button to the dashboard',
    metadata: {},
    ...overrides,
  };
}

describe('buildLightContextPrompt', () => {
  describe('what it omits', () => {
    it('does NOT include the obsolete "# Chief of Staff Agent Briefing" header', () => {
      const prompt = buildLightContextPrompt(makeTask(), '/repo', null, isTruthyMeta);
      expect(prompt).not.toMatch(/Chief of Staff Agent Briefing/);
    });

    it('does NOT inject the "You are an autonomous agent" role-play framing', () => {
      const prompt = buildLightContextPrompt(makeTask(), '/repo', null, isTruthyMeta);
      expect(prompt).not.toMatch(/You are an autonomous agent/);
    });

    it('does NOT paste memory, CLAUDE.md, digital-twin, tools-summary, planning, or skill blocks', () => {
      // Light path is synchronous and reads NONE of these — proving it by
      // checking the rendered output has no section headings for them.
      const prompt = buildLightContextPrompt(makeTask({
        metadata: { context: 'extra detail', app: 'comics' }
      }), '/repo', null, isTruthyMeta);
      expect(prompt).not.toMatch(/## CLAUDE\.md Instructions/);
      expect(prompt).not.toMatch(/## Relevant Memory/);
      expect(prompt).not.toMatch(/## Digital Twin/);
      expect(prompt).not.toMatch(/## Onboard Tools/);
      expect(prompt).not.toMatch(/## Project Planning Context/);
      expect(prompt).not.toMatch(/## Task-Type Skill Guidelines/);
      expect(prompt).not.toMatch(/## Context Compaction Required/);
      // No generic "Instructions / Guidelines / Git Hygiene" boilerplate either.
      expect(prompt).not.toMatch(/^## Guidelines$/m);
      expect(prompt).not.toMatch(/^## Git Hygiene/m);
    });
  });

  describe('what it includes', () => {
    it('includes the task description directly without a metadata header', () => {
      const prompt = buildLightContextPrompt(makeTask(), '/workspaces/foo', null, isTruthyMeta);
      expect(prompt).toMatch(/Add a button to the dashboard/);
      // The agent's cwd is set by the spawner; the prompt doesn't repeat metadata.
      expect(prompt).not.toMatch(/task-test-1/);
      expect(prompt).not.toMatch(/\*\*ID\*\*:/);
      expect(prompt).not.toMatch(/\*\*Priority\*\*:/);
      expect(prompt).not.toMatch(/\*\*Working Directory\*\*:/);
    });

    it('shows Target App when set', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { app: 'comics' } }),
        '/r', null, isTruthyMeta);
      expect(prompt).toMatch(/\*\*Target App\*\*: comics/);
    });

    it('renders attached context (multiline and single-line)', () => {
      const single = buildLightContextPrompt(
        makeTask({ metadata: { context: 'one-liner' } }), '/r', null, isTruthyMeta);
      expect(single).toMatch(/### Context\none-liner/);

      const multi = buildLightContextPrompt(
        makeTask({ metadata: { context: 'line one\nline two' } }), '/r', null, isTruthyMeta);
      expect(multi).toMatch(/### Context\n\nline one\nline two/);
    });

    it('lists screenshot file paths so the agent can read them via its own tools', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { screenshots: ['/tmp/a.png', '/tmp/b.png'] } }),
        '/r', null, isTruthyMeta);
      expect(prompt).toMatch(/### Screenshots/);
      expect(prompt).toMatch(/`\/tmp\/a\.png`/);
      expect(prompt).toMatch(/`\/tmp\/b\.png`/);
    });

    it('renders the worktree block with branch + path when worktreeInfo is present', () => {
      const wt = {
        branchName: 'cos/test-1',
        worktreePath: '/tmp/wt',
        baseBranch: 'origin/main',
      };
      const prompt = buildLightContextPrompt(makeTask(), '/r', wt, isTruthyMeta);
      expect(prompt).toMatch(/## Git Worktree/);
      expect(prompt).toMatch(/`cos\/test-1`/);
      expect(prompt).toMatch(/`\/tmp\/wt`/);
      expect(prompt).toMatch(/`origin\/main`/);
    });

    it('renders the JIRA block when a ticket id is set', () => {
      const prompt = buildLightContextPrompt(makeTask({
        metadata: {
          jiraTicketId: 'PROJ-123',
          jiraTicketUrl: 'https://j/PROJ-123',
          jiraBranch: 'jira/proj-123',
        }
      }), '/r', null, isTruthyMeta);
      expect(prompt).toMatch(/## JIRA/);
      expect(prompt).toMatch(/PROJ-123/);
      expect(prompt).toMatch(/`jira\/proj-123`/);
    });

    it('renders the Completion Workflow with /do:pr for TUI + openPR', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { simplify: true, openPR: true } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta,
        { isTui: true });
      expect(prompt).toMatch(/## Completion Workflow/);
      expect(prompt).toMatch(/`\/simplify`/);
      expect(prompt).toMatch(/`\/do:pr`/);
      expect(prompt).toMatch(/\.agent-done/);
      expect(prompt).toMatch(/\/quit/);
      // After /do:pr drives the Copilot review loop clean, the agent must
      // merge and verify — otherwise the PR sits open after the agent exits.
      expect(prompt).toMatch(/gh pr merge "<PR_URL>" --squash --delete-branch/);
      expect(prompt).not.toMatch(/gh pr merge[^\n]*--auto/);
      expect(prompt).toMatch(/gh pr view "<PR_URL>" --json state -q \.state/);
      expect(prompt).toMatch(/MERGED/);
    });

    it('renders the Completion Workflow with /do:push when openPR is false', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { simplify: true, openPR: false } }),
        '/r', null, isTruthyMeta, { isTui: true });
      expect(prompt).toMatch(/`\/do:push`/);
      expect(prompt).not.toMatch(/`\/do:pr`/);
      // /do:push doesn't open a PR — no merge step should be emitted.
      expect(prompt).not.toMatch(/gh pr merge/);
    });

    it('emits a non-TUI "Completion" block (no slashdo) for non-Claude CLI agents', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta,
        { isTui: false });
      expect(prompt).toMatch(/^## Completion$/m);
      expect(prompt).not.toMatch(/`\/do:pr`/);
      expect(prompt).not.toMatch(/`\/quit`/);
      expect(prompt).toMatch(/PortOS will push and open the PR/);
    });

    it('emits a slashdo Completion block (/simplify + /do:pr) for Claude Code CLI + openPR', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, simplify: true } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta,
        { isTui: false, providerId: 'claude-code' });
      expect(prompt).toMatch(/^## Completion$/m);
      expect(prompt).toMatch(/`\/simplify`/);
      expect(prompt).toMatch(/`\/do:pr`/);
      expect(prompt).not.toMatch(/PortOS will NOT push/);
      expect(prompt).not.toMatch(/`\/quit`/);
      // After /do:pr drives the Copilot review loop clean, the agent must
      // merge and verify — without these steps the PR sits open after the
      // agent exits (the original "agent abandoned the PR" bug).
      expect(prompt).toMatch(/gh pr merge "<PR_URL>" --squash --delete-branch/);
      expect(prompt).not.toMatch(/gh pr merge[^\n]*--auto/);
      expect(prompt).toMatch(/gh pr view "<PR_URL>" --json state -q \.state/);
      expect(prompt).toMatch(/MERGED/);
    });

    it('skips /simplify in the slashdo Completion block when simplify is disabled', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, simplify: false } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta,
        { isTui: false, providerId: 'claude-code' });
      expect(prompt).toMatch(/`\/do:pr`/);
      expect(prompt).not.toMatch(/`\/simplify`/);
      // Merge guidance still applies when /simplify is skipped.
      expect(prompt).toMatch(/gh pr merge "<PR_URL>" --squash --delete-branch/);
    });

    it('uses /do:push (not /do:pr) for Claude Code CLI when openPR is false', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: false, simplify: true } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta,
        { isTui: false, providerId: 'claude-code' });
      expect(prompt).toMatch(/`\/do:push`/);
      expect(prompt).not.toMatch(/`\/do:pr`/);
      // /do:push doesn't open a PR — no merge step should be emitted.
      expect(prompt).not.toMatch(/gh pr merge/);
    });

    it('suppresses the completion block and warns when readOnly is set', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { readOnly: true } }),
        '/r', null, isTruthyMeta, { isTui: true });
      expect(prompt).toMatch(/Read-Only Task/);
      expect(prompt).not.toMatch(/## Completion Workflow/);
    });

    it('renders the review-loop follow-up block when reviewLoopFollowUp is set', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 9,
          reviewLoopPROwner: 'o',
          reviewLoopPRRepo: 'r',
          sourceTaskId: 'task-src-1',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta);
      expect(prompt).toMatch(/## Review-Loop Follow-up/);
      expect(prompt).toMatch(/task-src-1/);
      expect(prompt).toMatch(/gh pr merge "https:\/\/github\.com\/o\/r\/pull\/9" --squash --delete-branch/);
      // --auto must NOT appear inside any `gh pr merge` invocation — it defers
      // the merge and the PR sits open after the agent exits.
      expect(prompt).not.toMatch(/gh pr merge[^\n]*--auto/);
      // Agent must verify the PR is actually merged before exiting.
      expect(prompt).toMatch(/gh pr view "https:\/\/github\.com\/o\/r\/pull\/9" --json state/);
      expect(prompt).toMatch(/MERGED/);
      expect(prompt).not.toMatch(/## Completion Workflow/);
      // Default reviewer (copilot, lone) — names copilot but emits no `--review-with`
      // (the lone default needs no flag).
      expect(prompt).toMatch(/Reviewers \(in order\)\*\*: `copilot`/);
      expect(prompt).not.toMatch(/--review-with/);
    });

    it('threads a non-default reviewer (claude) into the follow-up block via --review-with', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 9,
          reviewLoopPROwner: 'o',
          reviewLoopPRRepo: 'r',
          reviewLoopReviewers: ['claude'],
          sourceTaskId: 'task-src-2',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta);
      expect(prompt).toMatch(/--review-with claude/);
      // The Copilot-specific pre-request wording must be replaced for CLI reviewers.
      expect(prompt).toMatch(/CLI-based/);
    });

    it('threads an ordered multi-reviewer list + flags into the follow-up block', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 9,
          reviewLoopReviewers: ['codex', 'gemini', 'copilot'],
          reviewLoopStopMode: 'on-clean',
          reviewLoopReviewerApplies: true,
          sourceTaskId: 'task-src-3',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta);
      expect(prompt).toMatch(/--review-with codex,gemini,copilot/);
      expect(prompt).toMatch(/--review-stop-on-clean/);
      expect(prompt).toMatch(/--reviewer-applies/);
      // Ordered run instruction.
      expect(prompt).toMatch(/For EACH reviewer in order/);
    });

    it('threads reviewer into the TUI Completion Workflow as `/do:pr --review-with <reviewer>`', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true, simplify: true, reviewers: ['gemini'] } }),
        '/r',
        { branchName: 'feat', worktreePath: '/tmp/wt' },
        isTruthyMeta,
        { isTui: true });
      expect(prompt).toMatch(/`\/do:pr --review-with gemini`/);
    });

    it('allows merging on `partial` in the completion merge step when a stop-mode is set', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true, reviewers: ['codex', 'gemini'], reviewStopMode: 'on-clean' } }),
        '/r',
        { branchName: 'feat', worktreePath: '/tmp/wt' },
        isTruthyMeta,
        { isTui: true });
      expect(prompt).toMatch(/--review-stop-on-clean/);
      // `partial` is a successful stop-mode short-circuit → mergeable.
      expect(prompt).toMatch(/`partial`/);
    });

    it('does NOT merge on `partial` under the default stop-mode (all)', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true, reviewers: ['codex', 'gemini'] } }),
        '/r',
        { branchName: 'feat', worktreePath: '/tmp/wt' },
        isTruthyMeta,
        { isTui: true });
      expect(prompt).not.toMatch(/`partial`/);
    });

    it('tells the follow-up to request Copilot at its turn when copilot does NOT lead the list', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopReviewers: ['codex', 'copilot'],
          sourceTaskId: 'task-src-4',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta);
      // Must instruct requesting Copilot at its turn — not claim a pre-request happened.
      expect(prompt).toMatch(/request a Copilot review when you reach its turn/);
      expect(prompt).not.toMatch(/already requested the initial Copilot/);
    });

    it('worktreeCommitGuidance: existing-branch wins over slashdo/PR — emits the review-fix push wording', () => {
      // When the worktree reuses a pre-existing PR branch (e.g. a review-loop
      // follow-up agent picking up where the prior agent left off), the agent
      // must push directly — the PR points at this branch and Copilot only
      // sees commits that are actually pushed. This branch is selected even
      // for a Claude Code CLI provider with `openPR: true`, because the PR
      // already exists; opening another one would be wrong.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, simplify: true } }),
        '/r',
        { branchName: 'feat-x', worktreePath: '/tmp/wt', existingBranch: true },
        isTruthyMeta,
        { isTui: false, providerId: 'claude-code' });
      expect(prompt).toMatch(/## Git Worktree/);
      expect(prompt).toMatch(/\*\(pre-existing PR branch\)\*/);
      // The review-fix push wording — distinct from the slashdo/post-exit ones.
      expect(prompt).toMatch(/Commit and \*\*push\*\* any review-fix commits to this branch/);
      expect(prompt).toMatch(/git pull --rebase/);
      // And it must NOT emit the slashdo-driven Completion guidance for this branch.
      expect(prompt).not.toMatch(/the \*\*Completion\*\* section below drives the push and PR/);
    });

    it('worktreeCommitGuidance: hasSlashdo + !willOpenPR emits the push-only Completion wording', () => {
      // Claude Code CLI with a worktree but no PR (e.g. a managed-app task
      // whose flow is "push the branch, no PR"). The agent owns its own
      // /simplify + /do:push, so the worktree guidance points at the
      // Completion section's push (not the PR variant).
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: false, simplify: true } }),
        '/r',
        { branchName: 'feat-x', worktreePath: '/tmp/wt' },
        isTruthyMeta,
        { isTui: false, providerId: 'claude-code' });
      expect(prompt).toMatch(/## Git Worktree/);
      // Push-only Completion wording — NOT the "push and PR" variant.
      expect(prompt).toMatch(/the \*\*Completion\*\* section below drives the push\./);
      expect(prompt).not.toMatch(/drives the push and PR/);
      // And NOT the post-exit handoff message (that's the codex/gemini path).
      expect(prompt).not.toMatch(/The system will push and open a PR after you exit/);
    });

    it('renders the pipeline block when previousStageAgentId is present', () => {
      const prompt = buildLightContextPrompt(makeTask({
        metadata: { pipeline: {
          previousStageAgentId: 'agent-prev-1',
          currentStage: 1,
          stages: [{ name: 'idea' }, { name: 'prose' }, { name: 'comic' }],
        }}
      }), '/r', null, isTruthyMeta);
      expect(prompt).toMatch(/## Pipeline Context/);
      expect(prompt).toMatch(/Stage 2 of 3: "prose"/);
      expect(prompt).toMatch(/Previous stage: "idea"/);
      expect(prompt).toMatch(/agent-prev-1\/output\.txt/);
    });
  });
});

describe('buildAgentPrompt — provider type routing', () => {
  it('routes TUI provider through the light path (no roleplay preamble or task header)', async () => {
    const prompt = await buildAgentPrompt(
      makeTask(), {}, '/r', null, isTruthyMeta,
      { providerType: 'tui', tui: true, skipClaudeMd: true });
    expect(prompt).not.toMatch(/Chief of Staff Agent Briefing/);
    expect(prompt).not.toMatch(/You are an autonomous agent/);
    // The Task header block is now gone — task description leads.
    expect(prompt).not.toMatch(/^## Task$/m);
    expect(prompt).toMatch(/Add a button to the dashboard/);
  });

  it('routes CLI provider through the light path too', async () => {
    const prompt = await buildAgentPrompt(
      makeTask(), {}, '/r', null, isTruthyMeta,
      { providerType: 'cli', tui: false });
    expect(prompt).not.toMatch(/Chief of Staff Agent Briefing/);
    expect(prompt).not.toMatch(/You are an autonomous agent/);
    // Light + non-TUI uses the plain "## Completion" block.
    expect(prompt).toMatch(/^## Completion$/m);
  });

  it('full-context (api) review-loop follow-up emits merge command WITHOUT --auto and includes MERGED verification', async () => {
    // Regression for Copilot feedback on PR #260: the merge-without-auto +
    // MERGED-state verification instructions live in BOTH the light and full
    // prompt paths, and we lock them in for the full path here so the two
    // paths can't drift independently. The full path goes through the
    // built-in fallback template (review-loop follow-up agents intentionally
    // skip the user-side prompt template — see buildAgentPrompt).
    const prompt = await buildAgentPrompt(
      makeTask({ metadata: {
        reviewLoopFollowUp: true,
        reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
        reviewLoopPRBranch: 'b',
        reviewLoopPRNumber: 9,
        reviewLoopPROwner: 'o',
        reviewLoopPRRepo: 'r',
        sourceTaskId: 'task-src-1',
      }}),
      {},
      '/r',
      { branchName: 'b', worktreePath: '/tmp/wt' },
      isTruthyMeta,
      { providerType: 'api' });
    expect(prompt).toMatch(/## Review-Loop Follow-up/);
    // Merge command must be present, exactly with --squash --delete-branch.
    expect(prompt).toMatch(/gh pr merge "https:\/\/github\.com\/o\/r\/pull\/9" --squash --delete-branch/);
    // --auto must NOT appear inside any `gh pr merge` invocation — it defers
    // the merge and the PR sits open after the agent exits.
    expect(prompt).not.toMatch(/gh pr merge[^\n]*--auto/);
    // Agent must verify the PR is actually merged before exiting.
    expect(prompt).toMatch(/gh pr view "https:\/\/github\.com\/o\/r\/pull\/9" --json state -q \.state/);
    expect(prompt).toMatch(/MERGED/);
  });
});
