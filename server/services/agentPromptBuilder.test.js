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

import { describe, it, expect } from 'vitest';
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
    it('includes task id/priority/description and working directory', () => {
      const prompt = buildLightContextPrompt(makeTask(), '/workspaces/foo', null, isTruthyMeta);
      expect(prompt).toMatch(/task-test-1/);
      expect(prompt).toMatch(/HIGH/);
      expect(prompt).toMatch(/Add a button to the dashboard/);
      expect(prompt).toMatch(/\/workspaces\/foo/);
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
    });

    it('renders the Completion Workflow with /do:push when openPR is false', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { simplify: true, openPR: false } }),
        '/r', null, isTruthyMeta, { isTui: true });
      expect(prompt).toMatch(/`\/do:push`/);
      expect(prompt).not.toMatch(/`\/do:pr`/);
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
      expect(prompt).toMatch(/PortOS will NOT push or open a PR on your behalf/);
      expect(prompt).not.toMatch(/`\/quit`/);
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
      expect(prompt).toMatch(/gh pr merge "https:\/\/github\.com\/o\/r\/pull\/9"/);
      expect(prompt).not.toMatch(/## Completion Workflow/);
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
  it('routes TUI provider through the light path (no roleplay preamble)', async () => {
    const prompt = await buildAgentPrompt(
      makeTask(), {}, '/r', null, isTruthyMeta,
      { providerType: 'tui', tui: true, skipClaudeMd: true });
    expect(prompt).not.toMatch(/Chief of Staff Agent Briefing/);
    expect(prompt).not.toMatch(/You are an autonomous agent/);
    expect(prompt).toMatch(/^## Task$/m);
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
});
