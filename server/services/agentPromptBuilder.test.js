/**
 * Tests for the light-vs-full context split in buildAgentPrompt.
 *
 * The split is by `provider.type`:
 *   - `tui` / `cli` → light prompt (Claude Code, Codex, Antigravity — agentic
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

import { buildLightContextPrompt, buildAgentPrompt, buildCompletionGuidelineBullet } from './agentPromptBuilder.js';
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

    it('shows Target App for a managed app', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { app: 'comics' } }),
        '/r', null, isTruthyMeta);
      expect(prompt).toMatch(/\*\*Target App\*\*: comics/);
    });

    it('omits Target App for the PortOS default app (cwd already scopes it)', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { app: 'portos-default' } }),
        '/r', null, isTruthyMeta);
      expect(prompt).not.toMatch(/\*\*Target App\*\*/);
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

    it('lists multiple attached files (including images) so the agent can read them via its own tools', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { attachments: [
          { filename: 'a-123.png', originalName: 'photo-one.png', path: '/tmp/attachments/a-123.png' },
          { filename: 'b-456.png', originalName: 'photo-two.png', path: '/tmp/attachments/b-456.png' },
        ] } }),
        '/r', null, isTruthyMeta);
      expect(prompt).toMatch(/### Attachments/);
      expect(prompt).toMatch(/`\/tmp\/attachments\/a-123\.png` \(photo-one\.png\)/);
      expect(prompt).toMatch(/`\/tmp\/attachments\/b-456\.png` \(photo-two\.png\)/);
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

    it('disables external review when a TUI task opens a PR without a Review Loop', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { simplify: true, openPR: true } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta,
        { isTui: true });
      expect(prompt).toMatch(/## Completion Workflow/);
      expect(prompt).toMatch(/`\/simplify`/);
      expect(prompt).toMatch(/`\/do:pr --review-with none`/);
      expect(prompt).toMatch(/external review is disabled/i);
      expect(prompt).not.toMatch(/Copilot review loop/i);
      expect(prompt).toMatch(/\.agent-done/);
      // The sentinel is the done signal — the agent must NOT be told to RUN
      // /quit (it's a UI command it can't invoke; PortOS closes the session on
      // poll). The prompt only mentions /quit to tell the agent NOT to run it.
      expect(prompt).not.toMatch(/^\s*\d+\.\s*`\/quit`/m);
      expect(prompt).toMatch(/NOT run `\/quit`/);
      // Without a Review Loop the task opens the PR for human follow-up and
      // must not be told to auto-merge based on a review outcome.
      expect(prompt).not.toMatch(/gh pr merge/);
      expect(prompt).not.toMatch(/gh pr view "<PR_URL>" --json state/);
    });

    it('TUI simplify step is provider-aware — non-Claude TUI (codex-tui) gets the inline equivalent, not /simplify', () => {
      // /simplify is a Claude Code TUI built-in; codex-tui / antigravity-tui can't run it.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { simplify: true, openPR: true } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta,
        { isTui: true, providerId: 'codex-tui' });
      expect(prompt).toMatch(/## Completion Workflow/);
      expect(prompt).not.toMatch(/`\/simplify`/);
      expect(prompt).toMatch(/review your changed code for reuse, quality, and efficiency/i);
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

    it('emits a slashdo-free, forge-aware Completion Workflow for an OpenCode TUI + openPR (opens PR, no auto-merge)', () => {
      // OpenCode TUI doesn't load Claude Code slash commands, so /do:pr / /do:push
      // would be uninvokable. The agent commits, pushes, opens the PR/MR for review,
      // and writes the sentinel with plain git + the forge CLI. It must NOT auto-merge
      // (it can't run the reviewer loop and PortOS runs no post-exit review for a TUI).
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { simplify: true, openPR: true } }),
        '/r',
        { branchName: 'claim/issue-1', worktreePath: '/tmp/wt', baseBranch: 'main' },
        isTruthyMeta,
        { isTui: true, providerId: 'opencode-ollama-tui', providerCommand: 'opencode' });
      expect(prompt).toMatch(/## Completion Workflow/);
      // No slashdo commands anywhere in the workflow.
      expect(prompt).not.toMatch(/`\/do:pr`/);
      expect(prompt).not.toMatch(/`\/do:push`/);
      expect(prompt).not.toMatch(/`\/simplify`/);
      // /simplify is a Claude built-in — OpenCode gets the inline equivalent.
      expect(prompt).toMatch(/review your changed code for reuse, quality, and efficiency/i);
      // Plain git commit → push → open PR. Base pinned to the worktree base branch.
      expect(prompt).toMatch(/git commit -m/);
      expect(prompt).toMatch(/git push -u origin claim\/issue-1/);
      // Forge-aware: both GitHub (gh) and GitLab (glab) create commands, base-pinned.
      expect(prompt).toMatch(/gh pr create --fill --base main/);
      expect(prompt).toMatch(/glab mr create --fill --target-branch main/);
      // Opens for review — never auto-merges.
      expect(prompt).not.toMatch(/gh pr merge/);
      expect(prompt).not.toMatch(/glab mr merge/);
      expect(prompt).toMatch(/do NOT merge it yourself/);
      // Sentinel handshake still drives completion; never tell the agent to run /quit.
      expect(prompt).toMatch(/\.agent-done/);
      expect(prompt).toMatch(/NOT run `\/quit`/);
      expect(prompt).not.toMatch(/^\s*\d+\.\s*`\/quit`/m);
    });

    it('OpenCode TUI without openPR pushes the branch but opens no PR', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: false } }),
        '/r',
        { branchName: 'claim/issue-2', worktreePath: '/tmp/wt' },
        isTruthyMeta,
        { isTui: true, providerId: 'opencode-ollama-tui', providerCommand: 'opencode' });
      expect(prompt).toMatch(/## Completion Workflow/);
      expect(prompt).not.toMatch(/`\/do:push`/);
      expect(prompt).toMatch(/git push -u origin claim\/issue-2/);
      // No PR is opened, so no forge create/merge steps.
      expect(prompt).not.toMatch(/gh pr create/);
      expect(prompt).not.toMatch(/glab mr create/);
      expect(prompt).not.toMatch(/gh pr merge/);
      expect(prompt).toMatch(/\.agent-done/);
    });

    it('shell-quotes a branch ref containing shell metacharacters in the manual push command', () => {
      // Git refs can legally contain `;` etc.; the emitted push command must quote it.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: false } }),
        '/r',
        { branchName: 'weird;rm -rf', worktreePath: '/tmp/wt' },
        isTruthyMeta,
        { isTui: true, providerId: 'opencode-ollama-tui', providerCommand: 'opencode' });
      expect(prompt).toMatch(/git push -u origin 'weird;rm -rf'/);
      expect(prompt).not.toMatch(/git push -u origin weird;rm/);
    });

    it('a non-OpenCode TUI (claude-code-tui) keeps the slashdo /do:pr workflow', () => {
      // providerCommand is the gate — a claude TUI must NOT fall into the manual path.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta,
        { isTui: true, providerId: 'claude-code-tui', providerCommand: 'claude' });
      expect(prompt).toMatch(/`\/do:pr --review-with none`/);
      expect(prompt).toMatch(/external review is disabled/i);
      expect(prompt).not.toMatch(/gh pr create/);
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

    it('inlines a simplify-equivalent self-review (no /simplify command) for non-Claude CLI agents', () => {
      // /simplify is a Claude Code built-in; codex/antigravity can't run it. With
      // simplify enabled they must still get the reuse/quality/efficiency pass,
      // phrased inline so any CLI can perform it.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, simplify: true } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta,
        { isTui: false }); // no providerId → not Claude → no slashdo
      expect(prompt).toMatch(/^## Completion$/m);
      expect(prompt).not.toMatch(/`\/simplify`/);
      expect(prompt).toMatch(/review your changed code for reuse, quality, and efficiency/i);
      expect(prompt).toMatch(/PortOS will push and open the PR/);
    });

    it('emits a slashdo Completion block (/simplify + /do:pr) for Claude Code CLI + openPR', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true, simplify: true } }),
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
      expect(prompt).toMatch(/gh pr merge "<PR_URL>" --merge --delete-branch/);
      expect(prompt).not.toMatch(/gh pr merge[^\n]*--auto/);
      expect(prompt).toMatch(/gh pr view "<PR_URL>" --json state -q \.state/);
      expect(prompt).toMatch(/MERGED/);
    });

    it('disables external review and omits merge guidance for Claude Code CLI when Review Loop is off', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, simplify: false } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta,
        { isTui: false, providerId: 'claude-code' });
      expect(prompt).toMatch(/`\/do:pr --review-with none`/);
      expect(prompt).toMatch(/external review disabled/i);
      expect(prompt).not.toMatch(/Copilot review loop/i);
      expect(prompt).not.toMatch(/gh pr merge/);
      expect(prompt).not.toMatch(/gh pr view "<PR_URL>" --json state/);
    });

    it('skips /simplify in the slashdo Completion block when simplify is disabled', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true, simplify: false } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta,
        { isTui: false, providerId: 'claude-code' });
      expect(prompt).toMatch(/`\/do:pr`/);
      expect(prompt).not.toMatch(/`\/simplify`/);
      // Merge guidance still applies when /simplify is skipped.
      expect(prompt).toMatch(/gh pr merge "<PR_URL>" --merge --delete-branch/);
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

    it('suppresses the PR completion workflow but still writes a sentinel when readOnly + TUI', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { readOnly: true } }),
        '/r', null, isTruthyMeta, { isTui: true });
      expect(prompt).toMatch(/Read-Only Task/);
      expect(prompt).not.toMatch(/## Completion Workflow/);
      // A read-only TUI agent must still be told to write .agent-done — the 2s
      // sentinel poll is its only clean finalize/summary path (regression: the
      // read-only branch used to emit the bare notice with no sentinel, so
      // reference-watch runs never signaled completion).
      expect(prompt).toMatch(/\.agent-done/);
      expect(prompt).toMatch(/polls this sentinel/);
    });

    it('read-only on a non-TUI (CLI) provider gets the bare notice, no sentinel', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { readOnly: true } }),
        '/r', null, isTruthyMeta, { isTui: false, providerId: 'claude-code' });
      expect(prompt).toMatch(/Read-Only Task/);
      // CLI/API agents complete on process exit and never poll a sentinel.
      expect(prompt).not.toMatch(/\.agent-done/);
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
      expect(prompt).toMatch(/gh pr merge "https:\/\/github\.com\/o\/r\/pull\/9" --merge --delete-branch/);
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
      // The Copilot-specific pre-request wording must be replaced when no
      // Copilot reviewer leads the order (the agent invokes the reviewers itself).
      expect(prompt).toMatch(/invoke each configured reviewer yourself/);
    });

    it('threads an ordered multi-reviewer list + flags into the follow-up block', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 9,
          reviewLoopReviewers: ['codex', 'antigravity', 'copilot'],
          reviewLoopStopMode: 'on-clean',
          reviewLoopReviewerApplies: true,
          sourceTaskId: 'task-src-3',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta);
      expect(prompt).toMatch(/--review-with codex,antigravity,copilot/);
      expect(prompt).toMatch(/--review-stop-on-clean/);
      expect(prompt).toMatch(/--reviewer-applies/);
      // Ordered run instruction.
      expect(prompt).toMatch(/For EACH reviewer in order/);
    });

    it('threads the configured Codex model tier into the CLI invocation when codex reviews', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 9,
          reviewLoopReviewers: ['codex'],
          reviewLoopCodexModel: 'gpt-5.6-sol',
          sourceTaskId: 'task-src-cx',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta);
      expect(prompt).toMatch(/codex --model gpt-5\.6-sol/);
    });

    it('omits the Codex model note when codex is not among the reviewers', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 9,
          reviewLoopReviewers: ['claude'],
          // Stale model tier from a prior codex config — must not leak into a
          // claude-only review.
          reviewLoopCodexModel: 'gpt-5.6-sol',
          sourceTaskId: 'task-src-noncx',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta);
      expect(prompt).not.toMatch(/--model gpt-5\.6-sol/);
    });

    it('emits the local-LLM POST instruction when a local-LLM reviewer is configured', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 9,
          reviewLoopReviewers: ['lmstudio'],
          sourceTaskId: 'task-src-llm',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta);
      // The agent gets a copy-pasteable curl pipeline pointing at PortOS's
      // loopback API — without it the lmstudio/ollama reviewer kinds have no
      // way to actually run a review.
      expect(prompt).toMatch(/POST the diff to PortOS's local reviewer endpoint/);
      expect(prompt).toMatch(/http:\/\/localhost:5555\/api\/code-review\/local/);
      expect(prompt).toMatch(/gh pr diff 9 \| jq/);
    });

    it('threads reviewer into the TUI Completion Workflow as `/do:pr --review-with <reviewer>`', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true, simplify: true, reviewers: ['antigravity'] } }),
        '/r',
        { branchName: 'feat', worktreePath: '/tmp/wt' },
        isTruthyMeta,
        { isTui: true });
      expect(prompt).toMatch(/`\/do:pr --review-with antigravity`/);
    });

    it('allows merging on `partial` in the completion merge step when a stop-mode is set', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true, reviewers: ['codex', 'antigravity'], reviewStopMode: 'on-clean' } }),
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
        makeTask({ metadata: { openPR: true, reviewLoop: true, reviewers: ['codex', 'antigravity'] } }),
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
      // And NOT the post-exit handoff message (that's the codex/antigravity path).
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

  describe('split system/user prompt (Claude providers)', () => {
    const wt = { branchName: 'cos/t/a', worktreePath: '/tmp/wt', baseBranch: 'main' };
    const splitTask = () => makeTask({ metadata: { context: 'Some context', openPR: false } });

    it('returns { userPrompt, systemPrompt } with the task in user and the contract in system', async () => {
      const parts = await buildAgentPrompt(
        splitTask(), {}, '/r', wt, isTruthyMeta,
        { providerType: 'tui', providerId: 'claude-ollama-tui', providerCommand: 'claude', leanMode: true, split: true });
      expect(parts.userPrompt).toMatch(/Add a button to the dashboard/);
      expect(parts.userPrompt).toMatch(/Some context/);
      expect(parts.userPrompt).toMatch(/Begin working on the task now\./);
      expect(parts.userPrompt).not.toMatch(/## Completion Workflow/);
      expect(parts.systemPrompt).toMatch(/## Git Worktree/);
      expect(parts.systemPrompt).toMatch(/## Completion Workflow/);
      expect(parts.systemPrompt).not.toMatch(/Add a button to the dashboard/);
    });

    it('split parts carry exactly the combined prompt sections (no drift)', async () => {
      const opts = { providerType: 'tui', providerId: 'claude-ollama-tui', providerCommand: 'claude', leanMode: true };
      const combined = await buildAgentPrompt(splitTask(), {}, '/r', wt, isTruthyMeta, opts);
      const parts = await buildAgentPrompt(splitTask(), {}, '/r', wt, isTruthyMeta, { ...opts, split: true });
      // Combined = task sections + contract sections + Begin line; the split
      // moves the contract out and keeps the Begin line with the user prompt.
      const reassembled = parts.userPrompt.replace(
        /\n\nBegin working on the task now\.\n$/,
        '\n\n' + parts.systemPrompt.replace(/\n$/, '') + '\n\nBegin working on the task now.\n'
      );
      expect(reassembled).toBe(combined);
    });

    it('leanMode routes a claude TUI to the slashdo-free completion workflow', async () => {
      const prompt = await buildAgentPrompt(
        splitTask(), {}, '/r', wt, isTruthyMeta,
        { providerType: 'tui', providerId: 'claude-ollama-tui', providerCommand: 'claude', leanMode: true });
      expect(prompt).not.toMatch(/`\/do:push`/);
      expect(prompt).not.toMatch(/`\/do:pr`/);
      // Same sentinel handshake as the OpenCode slashdo-free path.
      expect(prompt).toMatch(/\.agent-done/);
    });

    it('without leanMode a claude TUI still gets the slashdo workflow', async () => {
      const prompt = await buildAgentPrompt(
        splitTask(), {}, '/r', wt, isTruthyMeta,
        { providerType: 'tui', providerId: 'claude-code-tui', providerCommand: 'claude' });
      expect(prompt).toMatch(/\/do:push/);
    });

    it('splits a STANDARD (non-lean) claude TUI too, keeping slashdo in the system prompt', async () => {
      const parts = await buildAgentPrompt(
        splitTask(), {}, '/r', wt, isTruthyMeta,
        { providerType: 'tui', providerId: 'claude-code-tui', providerCommand: 'claude', split: true });
      // Task in the user prompt, contract (with slashdo — NOT slashdo-free) in system.
      expect(parts.userPrompt).toMatch(/Add a button to the dashboard/);
      expect(parts.userPrompt).not.toMatch(/## Completion Workflow/);
      expect(parts.systemPrompt).toMatch(/## Completion Workflow/);
      expect(parts.systemPrompt).toMatch(/\/do:push/);
    });

    it('split parts carry exactly the combined prompt for a standard claude CLI (no drift)', async () => {
      const opts = { providerType: 'cli', providerId: 'claude-code', providerCommand: 'claude' };
      const combined = await buildAgentPrompt(splitTask(), {}, '/r', wt, isTruthyMeta, opts);
      const parts = await buildAgentPrompt(splitTask(), {}, '/r', wt, isTruthyMeta, { ...opts, split: true });
      const reassembled = parts.userPrompt.replace(
        /\n\nBegin working on the task now\.\n$/,
        '\n\n' + parts.systemPrompt.replace(/\n$/, '') + '\n\nBegin working on the task now.\n'
      );
      expect(reassembled).toBe(combined);
    });
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
    // Merge command must be present, exactly with --merge --delete-branch.
    expect(prompt).toMatch(/gh pr merge "https:\/\/github\.com\/o\/r\/pull\/9" --merge --delete-branch/);
    // --auto must NOT appear inside any `gh pr merge` invocation — it defers
    // the merge and the PR sits open after the agent exits.
    expect(prompt).not.toMatch(/gh pr merge[^\n]*--auto/);
    // Agent must verify the PR is actually merged before exiting.
    expect(prompt).toMatch(/gh pr view "https:\/\/github\.com\/o\/r\/pull\/9" --json state -q \.state/);
    expect(prompt).toMatch(/MERGED/);
  });
});

describe('buildCompletionGuidelineBullet', () => {
  it('read-only short-circuits regardless of other flags', () => {
    const bullet = buildCompletionGuidelineBullet({
      isReadOnly: true, isTui: true, slashdoFree: true,
      tuiCompletionCommand: '/do:pr', worktreeInfo: null, willOpenPR: true, willReviewLoop: false,
    });
    expect(bullet).toMatch(/read-only task/i);
  });

  it('slashdo TUI bullet references the slashdo command', () => {
    const bullet = buildCompletionGuidelineBullet({
      isReadOnly: false, isTui: true, slashdoFree: false,
      tuiCompletionCommand: '/do:pr', worktreeInfo: { worktreePath: '/wt' }, willOpenPR: true, willReviewLoop: false,
    });
    expect(bullet).toMatch(/`\/do:pr`/);
    expect(bullet).not.toMatch(/plain `git`\/`gh`/);
    expect(bullet).toMatch(/do NOT run `\/quit`/);
  });

  it('slashdo-free TUI bullet points at the plain git/gh workflow, not a /do:* command', () => {
    const bullet = buildCompletionGuidelineBullet({
      isReadOnly: false, isTui: true, slashdoFree: true,
      tuiCompletionCommand: '/do:pr', worktreeInfo: { worktreePath: '/wt' }, willOpenPR: true, willReviewLoop: false,
    });
    expect(bullet).toMatch(/plain `git`\/`gh`/);
    expect(bullet).toMatch(/no slashdo commands/);
    expect(bullet).not.toMatch(/`\/do:pr`/);
    expect(bullet).toMatch(/do NOT run `\/quit`/);
  });

  it('non-TUI worktree+openPR bullet defers push/PR to the system, and read-only/null cases return null', () => {
    const prBullet = buildCompletionGuidelineBullet({
      isReadOnly: false, isTui: false, tuiCompletionCommand: '/do:pr',
      worktreeInfo: { worktreePath: '/wt' }, willOpenPR: true, willReviewLoop: false,
    });
    expect(prBullet).toMatch(/the system will push your branch and open a pull request/);
    // No worktree, not TUI, not read-only → no bullet.
    const none = buildCompletionGuidelineBullet({
      isReadOnly: false, isTui: false, tuiCompletionCommand: '/do:push',
      worktreeInfo: null, willOpenPR: false, willReviewLoop: false,
    });
    expect(none).toBeNull();
  });

  it('discardWorktree short-circuits to the reasoning-only bullet (wins over TUI/openPR)', () => {
    const bullet = buildCompletionGuidelineBullet({
      isReadOnly: false, isTui: true, tuiCompletionCommand: '/do:pr',
      worktreeInfo: { worktreePath: '/wt' }, willOpenPR: true, willReviewLoop: true,
      discardWorktree: true,
    });
    expect(bullet).toMatch(/reasoning-only task/i);
    expect(bullet).toMatch(/discarded on exit/);
    expect(bullet).not.toMatch(/`\/do:pr`/);
  });
});

// A discardWorktree (reasoning-only) task — the layered-intelligence pattern —
// runs a normal agent in a worktree that is thrown away on exit. The completion
// contract is the `.agent-done` sentinel payload, NOT commit/push/PR. The prompt
// MUST NOT tell the agent to run /do:push, /do:pr, or open a PR, because (a) the
// worktree is discarded so any push is wasted, and (b) the generic markdown
// sentinel workflow would clobber the hook's structured-JSON sentinel contract.
// Regression for codex review of PR #2341.
describe('discardWorktree (reasoning-only) completion contract', () => {
  const wt = { branchName: 'cos/li-1', worktreePath: '/tmp/wt', baseBranch: 'origin/main' };
  const liTask = () => makeTask({ metadata: { discardWorktree: true, useWorktree: true, openPR: false, simplify: true } });

  const assertReasoningOnly = (prompt) => {
    expect(prompt).toMatch(/## Completion \(Reasoning-Only Task\)/);
    expect(prompt).toMatch(/discarded on exit/);
    expect(prompt).toMatch(/\.agent-done/);
    // The whole point: no push/PR/merge instructions anywhere.
    expect(prompt).not.toMatch(/`\/do:push`\*\*/); // no "Use `/do:push`" hygiene bullet
    expect(prompt).not.toMatch(/## Completion Workflow/); // TUI push+PR workflow suppressed
    expect(prompt).not.toMatch(/gh pr merge/);
    expect(prompt).not.toMatch(/will push your branch and open a pull request/);
  };

  it('light TUI path emits the sentinel-only completion, not the /do:push workflow', () => {
    const prompt = buildLightContextPrompt(liTask(), '/r', wt, isTruthyMeta, { isTui: true });
    assertReasoningOnly(prompt);
    // Worktree section carries the discard note, not commit/merge guidance.
    expect(prompt).toMatch(/discarded on exit/);
    expect(prompt).not.toMatch(/merged back/);
  });

  it('light CLI (non-TUI) path emits the sentinel-only completion', () => {
    const prompt = buildLightContextPrompt(liTask(), '/r', wt, isTruthyMeta, { isTui: false, providerId: 'codex' });
    assertReasoningOnly(prompt);
  });

  it('full (api) path suppresses the commit/push instructions in Instructions + Git Hygiene', async () => {
    const prompt = await buildAgentPrompt(liTask(), {}, '/r', wt, isTruthyMeta, { providerType: 'api' });
    assertReasoningOnly(prompt);
    // Fallback-template step 4 must not tell the agent to commit/push.
    expect(prompt).toMatch(/Write your result to the completion sentinel/);
    expect(prompt).not.toMatch(/Commit and push your changes/);
    // Git Hygiene commit/push bullet replaced with the do-NOT variant.
    expect(prompt).toMatch(/Do NOT commit, push, or open a PR/);
    // Simplify-before-commit step is suppressed (nothing gets committed).
    expect(prompt).not.toMatch(/## Simplify Step/);
  });
});
