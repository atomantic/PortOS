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

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { join } from 'path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { PATHS } from '../lib/fileUtils.js';

// #3475 — The builder reads ~/.claude/CLAUDE.md off the real filesystem and splices
// it into the prompt, so without this every `not.toMatch` assertion below is decided
// by the contributor's personal global config: it false-fails when their file happens
// to contain the string, and false-passes on a machine that has no such file at all
// (CI), where the suppression being asserted is never actually exercised. Pointing
// homedir() at a path that cannot exist makes the global section deterministically
// empty. `homeStub` stays mutable so the one test that needs a REAL global CLAUDE.md
// (a fixture that deliberately contains the suppressed string) can swap it in and
// prove the suppression positively — see the #3475 describe block further down.
const homeStub = vi.hoisted(() => ({ dir: '/nonexistent-home-for-tests' }));
vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal()),
  homedir: () => homeStub.dir,
}));

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
    // getAppWorkspace reads data/apps.json through this — mocked so the tilde
    // tests below never touch the real registry.
    readJSONFile: vi.fn(actual.readJSONFile),
  };
});
vi.mock('../lib/slashdoLoader.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadSlashdoFile: vi.fn().mockResolvedValue(null),
    // #3110 — staging the resolved copy is real disk I/O; mocked so tests can
    // assert the pointer path without writing under data/.
    writeResolvedSlashdoBody: vi.fn().mockResolvedValue(null),
  };
});
vi.mock('./jira.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  createTicket: vi.fn().mockResolvedValue(null),
}));
// Code Review Defaults resolver — mocked so tests can control the install-wide
// default reviewer list threaded into buildAgentPrompt without touching disk.
// Default matches pickCodeReviewDefaults's unset shape (`['copilot']`).
vi.mock('./codeReview.js', () => ({
  getCodeReviewDefaults: vi.fn().mockResolvedValue({ reviewers: ['copilot'] }),
}));

import { buildLightContextPrompt, buildAgentPrompt, buildCompletionGuidelineBullet, reconcileSplitContext, buildReviewLoopFollowUpSection, getAppWorkspace, getClaudeMdContext, detectSkillTemplates, loadSkillTemplates, UNATTENDED_RUN_RULE } from './agentPromptBuilder.js';
import { getCodeReviewDefaults } from './codeReview.js'; // mocked above — control the configured default
import { isTruthyMeta } from './agentState.js';
import { buildPrompt } from './promptService.js'; // mocked above — inspect call args
import { loadSlashdoFile, writeResolvedSlashdoBody } from '../lib/slashdoLoader.js'; // mocked above — control the inlined body
import { SLASHDO_INLINE_BUDGET_CHARS } from '../lib/slashdoInvocation.js';

function makeTask(overrides = {}) {
  return {
    id: 'task-test-1',
    priority: 'HIGH',
    description: 'Add a button to the dashboard',
    metadata: {},
    ...overrides,
  };
}

describe('composable skill template routing', () => {
  it('appends the Three.js guide after the primary feature template', () => {
    expect(detectSkillTemplates(makeTask({
      description: 'Implement a React Three Fiber product preview scene',
    }))).toEqual(['feature', 'threejs-visual']);
  });

  it('does not route generic WebGL work through the scene guide', () => {
    expect(detectSkillTemplates(makeTask({
      description: 'Add WebGL capability reporting to the diagnostics panel',
    }))).toEqual(['feature']);
  });

  it('keeps security guidance ahead of one visual domain guide on a collision', () => {
    expect(detectSkillTemplates(makeTask({
      description: 'Security audit the Three.js scene asset pipeline',
    }))).toEqual(['security-audit', 'threejs-visual']);
  });

  it('routes data-safety and dead-code audits to their own skill templates', () => {
    expect(detectSkillTemplates(makeTask({
      description: '[Improvement] Data and upgrade-safety audit',
    }))).toEqual(['data-safety']);
    expect(detectSkillTemplates(makeTask({
      description: '[Improvement] Dead-code and duplication audit',
    }))).toEqual(['simplify']);
  });

  it('joins templates in routing order and tolerates an unavailable domain guide', async () => {
    const loadTemplate = vi.fn(async (name) => ({
      'security-audit': 'Security lifecycle guidance',
      'threejs-visual': null,
    })[name]);

    await expect(loadSkillTemplates(['security-audit', 'threejs-visual'], loadTemplate))
      .resolves.toBe('Security lifecycle guidance');
    expect(loadTemplate).toHaveBeenNthCalledWith(1, 'security-audit');
    expect(loadTemplate).toHaveBeenNthCalledWith(2, 'threejs-visual');
  });
});

describe('reconcileSplitContext', () => {
  it('folds context back into description when it is the queue-path split', () => {
    const body = 'Line one is the title\n\nLine two is the body.';
    const task = { description: 'Line one is the title', metadata: { context: body, app: 'comics' } };
    const out = reconcileSplitContext(task);
    expect(out.description).toBe(body);
    expect(out.metadata.context).toBeUndefined();
    expect(out.metadata.app).toBe('comics'); // other metadata preserved
  });

  it('leaves a genuinely-separate user context untouched', () => {
    const task = { description: 'Add a button', metadata: { context: 'Unrelated context detail' } };
    const out = reconcileSplitContext(task);
    expect(out).toBe(task);
    expect(out.metadata.context).toBe('Unrelated context detail');
  });

  it('does not mutate the caller task (stored one-line description survives)', () => {
    const body = 'Title\n\nBody.';
    const task = { description: 'Title', metadata: { context: body } };
    reconcileSplitContext(task);
    expect(task.description).toBe('Title');
    expect(task.metadata.context).toBe(body);
  });

  it('is idempotent and a no-op when there is no context', () => {
    const task = { description: 'Title', metadata: {} };
    expect(reconcileSplitContext(task)).toBe(task);
  });

  // #4153 — the payload now lands in `metadata.prompt`; `metadata.context`
  // stays supported so a pre-split task (or a peer still on the old code)
  // reconciles the same way.
  it('folds metadata.prompt back into description and keeps the separate note', () => {
    const body = 'Line one is the title\n\nLine two is the body.';
    const task = { description: 'Line one is the title', metadata: { prompt: body, context: 'a note', app: 'comics' } };
    const out = reconcileSplitContext(task);
    expect(out.description).toBe(body);
    expect(out.metadata.prompt).toBe(body); // customized templates can still address the raw field
    expect(out.metadata.context).toBe('a note'); // the note is NOT the payload
    expect(out.metadata.app).toBe('comics');
  });

  it('prefers metadata.prompt over a same-shaped legacy context', () => {
    const body = 'Title\n\nNew body.';
    const legacy = 'Title\n\nOld body.';
    const out = reconcileSplitContext({ description: 'Title', metadata: { prompt: body, context: legacy } });
    expect(out.description).toBe(body);
    expect(out.metadata.context).toBe(legacy);
  });

  it('leaves a genuinely-separate prompt untouched', () => {
    const task = { description: 'Add a button', metadata: { prompt: 'Do the thing\nsomehow' } };
    expect(reconcileSplitContext(task)).toBe(task);
  });
});

describe('no-code / API-action task completion (CD agents must NOT be told to /do:push)', () => {
  // A Creative Director agent's deliverable is an HTTP PATCH described in its
  // prompt, not a commit — so it must get the No-Code completion section, never
  // the /do:push "Completion Workflow" (which just makes it load that skill for
  // nothing and contradicts its "on a 200 your task is complete" instructions).
  const cdTask = () => makeTask({
    metadata: { context: 'PATCH /api/creative-director/x/plan with the plan', noCodeOutput: true, openPR: false },
  });

  it('a no-code TUI task gets the No-Code completion section, not the /do:push Completion Workflow', () => {
    const prompt = buildLightContextPrompt(cdTask(), '/repo', null, isTruthyMeta, {
      providerId: 'claude-code-tui', providerCommand: 'claude',
    });
    expect(prompt).toMatch(/## Completion \(No Code Output\)/);
    expect(prompt).toMatch(/there is nothing to push/);
    expect(prompt).toMatch(/\.agent-done/); // still writes the sentinel so it finalizes promptly
    // The /do:push "Completion Workflow" section must be absent (the only literal
    // `/do:push` left is inside the "do NOT run /do:push" instruction itself).
    expect(prompt).not.toMatch(/## Completion Workflow/);
  });

  it('recognizes a legacy CD task by its creativeDirector marker (pre-upgrade pending, no explicit flag)', () => {
    // A CD task queued before the noCodeOutput flag existed carries only the
    // creativeDirector marker — it must STILL skip the /do:push workflow.
    const legacyCdTask = makeTask({
      metadata: { context: 'PATCH the plan', creativeDirector: { projectId: 'p', kind: 'plan' }, openPR: false },
    });
    const prompt = buildLightContextPrompt(legacyCdTask, '/repo', null, isTruthyMeta, {
      providerId: 'claude-code-tui', providerCommand: 'claude',
    });
    expect(prompt).toMatch(/## Completion \(No Code Output\)/);
    expect(prompt).not.toMatch(/## Completion Workflow/);
  });

  it('a normal code task on the same provider still gets the /do:push Completion Workflow', () => {
    const prompt = buildLightContextPrompt(
      makeTask({ metadata: { openPR: false } }), '/repo', null, isTruthyMeta,
      { providerId: 'claude-code-tui', providerCommand: 'claude' },
    );
    expect(prompt).toMatch(/## Completion Workflow/);
    expect(prompt).toMatch(/\/do:push/);
    expect(prompt).not.toMatch(/## Completion \(No Code Output\)/);
  });
});

describe('claim-flow completion handoff', () => {
  it('keeps self-managed claim work out of the generic false/false handoff', () => {
    const prompt = buildLightContextPrompt(
      makeTask({ metadata: { claimFlow: true, useWorktree: false, openPR: false, simplify: true } }),
      '/repo', null, isTruthyMeta,
      { isTui: true, providerId: 'codex-tui', providerCommand: 'codex' },
    );

    expect(prompt).toMatch(/## Claim Workflow Handoff/);
    expect(prompt).toMatch(/owns its claim worktree, branch, PR\/MR, review, merge or human-handoff, and cleanup/);
    expect(prompt).toMatch(/\.agent-done/);
    expect(prompt).not.toMatch(/PortOS will merge it back after completion/);
    expect(prompt).not.toMatch(/Do NOT push this worktree branch yourself/);
    expect(prompt).not.toMatch(/Commit and push using `\/do:push`/);
  });

  it('uses the claim handoff on the full API prompt path too', async () => {
    const prompt = await buildAgentPrompt(
      makeTask({ metadata: { claimFlow: true, useWorktree: false, openPR: false, simplify: true } }),
      {}, '/repo', null, isTruthyMeta, { providerType: 'api' },
    );

    expect(prompt).toMatch(/## Claim Workflow Handoff/);
    expect(prompt).toMatch(/follow the claim workflow prompt above/i);
    expect(prompt).not.toMatch(/PortOS will merge it back after completion/);
  });

  it('recognizes a queued legacy claim task by analysisType', () => {
    const prompt = buildLightContextPrompt(
      makeTask({ metadata: { analysisType: 'claim-issue', useWorktree: false, openPR: false } }),
      '/repo', null, isTruthyMeta,
      { isTui: true, providerId: 'codex-tui', providerCommand: 'codex' },
    );

    expect(prompt).toMatch(/## Claim Workflow Handoff/);
    expect(prompt).not.toMatch(/PortOS will merge it back after completion/);
  });
});

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

    // #4153 — the agent-facing payload lives in `metadata.prompt`; a legacy
    // `metadata.context` payload must keep rendering identically.
    it('renders metadata.prompt, and the note after it', () => {
      const promptOnly = buildLightContextPrompt(
        makeTask({ metadata: { prompt: 'line one\nline two' } }), '/r', null, isTruthyMeta);
      expect(promptOnly).toMatch(/### Context\n\nline one\nline two/);

      const both = buildLightContextPrompt(
        makeTask({ metadata: { prompt: 'line one\nline two', context: 'a short note' } }), '/r', null, isTruthyMeta);
      expect(both).toMatch(/### Context\n\nline one\nline two\n\na short note/);
    });

    it('does NOT double-render a queue-path split prompt (description == firstLine(payload))', () => {
      // The queue path stores `description = firstLine(body)` + the body
      // so COS-TASKS.md stays one-line-per-task. Rendering both would print the
      // first line twice (the reported double `# ⚡ SWARM MODE …` header).
      const body = '# ⚡ SWARM MODE — claim and ship up to 3 independent issues in parallel\n\n**This run operates in slashdo mode.** Do the work.';
      const prompt = buildLightContextPrompt(
        makeTask({ description: '# ⚡ SWARM MODE — claim and ship up to 3 independent issues in parallel', metadata: { context: body } }),
        '/r', null, isTruthyMeta);
      // Header appears exactly once, and the redundant `### Context` wrapper is gone.
      expect(prompt.match(/# ⚡ SWARM MODE/g)).toHaveLength(1);
      expect(prompt).not.toMatch(/### Context/);
      // The full body still renders (nothing dropped).
      expect(prompt).toMatch(/\*\*This run operates in slashdo mode\.\*\* Do the work\./);

      // Same task written by post-#4153 code: payload in `metadata.prompt`.
      const split = buildLightContextPrompt(
        makeTask({ description: '# ⚡ SWARM MODE — claim and ship up to 3 independent issues in parallel', metadata: { prompt: body } }),
        '/r', null, isTruthyMeta);
      expect(split.match(/# ⚡ SWARM MODE/g)).toHaveLength(1);
      expect(split).not.toMatch(/### Context/);
      expect(split).toMatch(/\*\*This run operates in slashdo mode\.\*\* Do the work\./);
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

    it('resolves API-relative screenshot URLs (#2518) to absolute FS paths so the agent can read them', () => {
      // Uploads now return `/api/screenshots/<file>` instead of an absolute
      // path (no install-layout leak in the HTTP response); the prompt builder
      // must map that back to an on-disk path for the agent's filesystem tools.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { screenshots: ['/api/screenshots/abcd1234-shot.png'] } }),
        '/r', null, isTruthyMeta);
      const abs = join(PATHS.screenshots, 'abcd1234-shot.png');
      expect(prompt).toContain(`\`${abs}\``);
      expect(prompt).not.toMatch(/`\/api\/screenshots\//);
    });

    it('resolves API-relative attachment URLs (#2518) to absolute FS paths for the agent', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { attachments: [
          { filename: 'a-123.png', originalName: 'photo-one.png', path: '/api/attachments/a-123.png' },
        ] } }),
        '/r', null, isTruthyMeta);
      const abs = join(PATHS.cosAttachments, 'a-123.png');
      expect(prompt).toContain(`\`${abs}\` (photo-one.png)`);
      expect(prompt).not.toMatch(/`\/api\/attachments\//);
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
      // Without a Review Loop nothing else will ever merge this PR, so the agent
      // merges it itself — gated on CI instead of on a review verdict.
      expect(prompt).toMatch(/gh pr checks "<PR_URL>" --watch --fail-fast/);
      // A repo that disallows merge commits must not dead-end the flow.
      expect(prompt).toMatch(/mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed/);
      // "no checks reported" is ambiguous on a just-opened PR — merging on it races CI.
      expect(prompt).toMatch(/AMBIGUOUS/);
      expect(prompt).toMatch(/gh workflow list/);
      expect(prompt).toMatch(/gh pr merge "<PR_URL>" --merge --delete-branch/);
      expect(prompt).not.toMatch(/gh pr merge[^\n]*--auto/);
      expect(prompt).toMatch(/gh pr view "<PR_URL>" --json state -q \.state/);
      // ...and the gate is CI, not a review-loop status.
      expect(prompt).not.toMatch(/review loop reports/);
    });

    it('a jira-sprint-manager TUI task leaves its PR open instead of merging', () => {
      // The task's prompt moves the ticket to "In Review" and a human lands both;
      // merging here would leave the work merged and the board stuck in review.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { simplify: true, openPR: true, analysisType: 'jira-sprint-manager' } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta,
        { isTui: true });
      expect(prompt).toMatch(/Leave the PR open — do NOT merge it/);
      expect(prompt).toMatch(/tracked in JIRA/);
      // Overrides a saved slashdo `merge: true` default.
      expect(prompt).toMatch(/`\/do:pr --review-with none --no-merge`/);
      expect(prompt).not.toMatch(/gh pr merge/);
      expect(prompt).not.toMatch(/gh pr checks/);
    });

    it('leaves an explicitly leave-open TUI task without review or merge instructions', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { simplify: true, openPR: true, prCompletion: 'leave-open', reviewLoop: true } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta,
        { isTui: true });
      expect(prompt).toMatch(/Leave the PR open — do NOT merge it/);
      expect(prompt).toMatch(/`\/do:pr --review-with none --no-merge`/);
      expect(prompt).not.toMatch(/gh pr merge/);
      expect(prompt).not.toMatch(/review loop/i);
    });

    it('a JIRA-ticketed Claude Code CLI task leaves its PR open instead of merging', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, jiraTicketId: 'PROJ-9' } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta,
        { isTui: false, providerId: 'claude-code' });
      // `--no-merge` is required: a saved slashdo `merge: true` default would
      // otherwise merge the PR before the "leave it open" step is ever reached.
      expect(prompt).toMatch(/`\/do:pr --review-with none --no-merge`/);
      expect(prompt).toMatch(/Leave the PR open — do NOT merge it/);
      expect(prompt).not.toMatch(/gh pr merge/);
    });

    it('an OpenCode TUI JIRA task still hands its PR to PortOS — the agent opens one only when it also lands it', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, analysisType: 'jira-sprint-manager' } }),
        '/r',
        { branchName: 'claim/x', worktreePath: '/tmp/wt', baseBranch: 'main' },
        isTruthyMeta,
        { isTui: true, providerId: 'opencode-ollama-tui', providerCommand: 'opencode' });
      // A JIRA-tracked PR is a human's to land, so there is no merge section for
      // the agent to drive — and an agent told to open a PR it will never land
      // just races PortOS's own `gh pr create` for the same branch.
      expect(prompt).not.toMatch(/gh pr create/);
      expect(prompt).toMatch(/JIRA-linked human handoff/);
      expect(prompt).not.toMatch(/## Review Loop/);
      expect(prompt).not.toMatch(/## Merge Gate/);
      expect(prompt).not.toMatch(/gh pr merge/);
      expect(prompt).not.toMatch(/glab mr merge/);
    });

    it('a non-worktree run never gets the PR steps — there is no branch name to put in them', () => {
      // The production shape is a JIRA-ticket run (agentWorkspacePrep skips
      // worktree creation when a jiraBranch is set). Emitting the steps anyway
      // rendered a literal `<branch>` placeholder for the agent to guess at.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true, reviewers: ['codex'] } }),
        '/r',
        null,
        isTruthyMeta,
        { isTui: true, providerId: 'codex-tui', providerCommand: 'codex' });
      expect(prompt).not.toMatch(/gh pr create/);
      expect(prompt).not.toMatch(/git push -u origin/);
      // …and no dangling "step 4 of the Completion Workflow above" pointing at
      // a section that was never emitted.
      expect(prompt).not.toMatch(/## Review Loop/);
      expect(prompt).not.toMatch(/\$PR_URL/);
    });

    it.each([
      ['a read-only task', { openPR: true, readOnly: true }],
      ['a no-code-output task', { openPR: true, noCodeOutput: true }],
      ['a Creative Director task', { openPR: true, creativeDirector: true }],
      ['a discard-worktree reasoning task', { openPR: true, discardWorktree: true }],
    ])('%s is never told it owns a PR, and gets no inline loop', (_label, metadata) => {
      // These completion contracts never mention a PR. Claiming ownership for
      // them routed a reasoning run into cleanup's did-you-open-it net, which
      // opened a PR for it and filed a HIGH notification blaming the agent.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt', baseBranch: 'main' },
        isTruthyMeta,
        { isTui: true, providerId: 'codex-tui', providerCommand: 'codex' });
      expect(prompt).not.toMatch(/gh pr create/);
      expect(prompt).not.toMatch(/## Review Loop/);
      expect(prompt).not.toMatch(/## Merge Gate/);
    });

    it('a leave-open review follow-up on a GitLab MR comments with glab, not gh', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopLeaveOpen: true,
          reviewLoopPRUrl: 'https://gitlab.com/g/p/-/merge_requests/5',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 5,
          reviewLoopPRHost: 'gitlab.com',
          reviewLoopReviewers: ['codex'],
          sourceTaskId: 'task-src-6',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta);
      expect(prompt).toMatch(/glab mr note 5 --message/);
      expect(prompt).not.toMatch(/gh pr comment/);
    });

    it('a review-loop follow-up on a JIRA PR reviews but does not merge', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopLeaveOpen: true,
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 9,
          reviewLoopReviewers: ['codex'],
          sourceTaskId: 'task-src-5',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta);
      expect(prompt).toMatch(/## Review-Loop Follow-up/);
      // The review still runs — only the merge is withheld.
      expect(prompt).toMatch(/codex/);
      expect(prompt).toMatch(/leave the PR open/i);
      expect(prompt).not.toMatch(/gh pr merge/);
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

    it('a slashdo-free OpenCode TUI drives its own PR, review loop, and merge', () => {
      // OpenCode TUI doesn't load Claude Code slash commands, so /do:pr / /do:push
      // would be uninvokable — but it runs `git`/`gh` and the reviewer CLIs fine,
      // so it owns the whole lifecycle in one session rather than handing off to a
      // `sys-rl-*` follow-up agent (#3733).
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { simplify: true, openPR: true, reviewLoop: true } }),
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
      // Commit → push → PR → review loop → merge, all in this session.
      expect(prompt).toMatch(/git commit -m/);
      expect(prompt).toMatch(/git push -u origin claim\/issue-1/);
      expect(prompt).toMatch(/PR_URL=\$\(gh pr create --base main --head claim\/issue-1/);
      expect(prompt).toMatch(/## Review Loop/);
      expect(prompt).toMatch(/gh pr merge "\$PR_URL" --merge --delete-branch/);
      // PortOS no longer promises to do any of it.
      expect(prompt).not.toMatch(/PortOS will push the branch/);
      // Sentinel handshake still drives completion; never tell the agent to run /quit.
      expect(prompt).toMatch(/\.agent-done/);
      expect(prompt).toMatch(/NOT run `\/quit`/);
      expect(prompt).not.toMatch(/^\s*\d+\.\s*`\/quit`/m);
    });

    it('a slashdo-free GitLab TUI captures MR variables and keeps the lifecycle on glab', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true, reviewers: ['ollama'] } }),
        '/r',
        { branchName: 'claim/issue-4363', worktreePath: '/tmp/wt', baseBranch: 'main', forgeCli: 'glab' },
        isTruthyMeta,
        { isTui: true, providerId: 'opencode-ollama-tui', providerCommand: 'opencode' });

      expect(prompt).toMatch(/PR_URL=\$\(glab mr create --source-branch claim\/issue-4363 --target-branch main/);
      expect(prompt).toMatch(/PR_NUMBER=\$\(glab mr view "\$PR_URL" -F json \| jq -r \.iid\)/);
      expect(prompt).toMatch(/glab mr diff \$PR_NUMBER/);
      expect(prompt).toMatch(/glab mr merge "\$PR_NUMBER" --yes --remove-source-branch/);
      expect(prompt).toMatch(/glab mr view "\$PR_NUMBER"/);
      expect(prompt).not.toMatch(/gh pr (create|diff|merge|view|checks)/);
    });

    it('a slashdo-free OpenCode TUI with no reviewer gets the CI merge gate, not a review loop', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { simplify: true, openPR: true } }),
        '/r',
        { branchName: 'claim/issue-1', worktreePath: '/tmp/wt', baseBranch: 'main' },
        isTruthyMeta,
        { isTui: true, providerId: 'opencode-ollama-tui', providerCommand: 'opencode' });
      expect(prompt).toMatch(/gh pr create/);
      expect(prompt).toMatch(/## Merge Gate/);
      expect(prompt).not.toMatch(/## Review Loop/);
      expect(prompt).toMatch(/gh pr checks/);
      expect(prompt).toMatch(/gh pr merge "\$PR_URL" --merge --delete-branch/);
      expect(prompt).not.toMatch(/PortOS will push the branch/);
    });

    it('OpenCode TUI without openPR leaves the committed branch for PortOS to merge', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: false } }),
        '/r',
        { branchName: 'claim/issue-2', worktreePath: '/tmp/wt' },
        isTruthyMeta,
        { isTui: true, providerId: 'opencode-ollama-tui', providerCommand: 'opencode' });
      expect(prompt).toMatch(/## Completion Workflow/);
      expect(prompt).not.toMatch(/`\/do:push`/);
      expect(prompt).not.toMatch(/git push/);
      expect(prompt).not.toMatch(/gh pr create/);
      expect(prompt).not.toMatch(/glab mr create/);
      expect(prompt).not.toMatch(/gh pr merge/);
      expect(prompt).toMatch(/\.agent-done/);
    });

    it('does not interpolate a branch ref into a shell command in the system-owned handoff', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: false } }),
        '/r',
        { branchName: 'weird;rm -rf', worktreePath: '/tmp/wt' },
        isTruthyMeta,
        { isTui: true, providerId: 'opencode-ollama-tui', providerCommand: 'opencode' });
      expect(prompt).not.toMatch(/git push/);
      expect(prompt).not.toMatch(/git .*weird;rm -rf/);
    });

    // #3114 acceptance criteria — the completion gates derive from
    // `resolveSlashdoStyle`, so the two behaviors the old inline provider-id
    // allowlists got wrong are now asserted.
    it('a codex TUI gets the plain git/gh completion workflow, never /do:pr', () => {
      // codex installs slashdo as Agent Skills, not slash commands, so telling it
      // to run `/do:pr` handed it an uninvokable line. The old `tuiSlashdoFree`
      // gate only recognized OpenCode + lean mode, so codex fell through to the
      // slashdo path.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true } }),
        '/r',
        { branchName: 'claim/x', worktreePath: '/tmp/wt', baseBranch: 'main' },
        isTruthyMeta,
        { isTui: true, providerId: 'codex-tui', providerCommand: 'codex' });
      expect(prompt).toMatch(/## Completion Workflow/);
      expect(prompt).toMatch(/does NOT have slashdo/);
      expect(prompt).not.toMatch(/`\/do:pr`/);
      expect(prompt).not.toMatch(/`\/do:push`/);
      // Plain git/gh equivalent of the whole slashdo workflow (#3733).
      expect(prompt).toMatch(/git commit -m/);
      expect(prompt).toMatch(/git push -u origin claim\/x/);
      expect(prompt).toMatch(/gh pr create --base main --head claim\/x/);
      expect(prompt).toMatch(/## Review Loop/);
      expect(prompt).not.toMatch(/PortOS will push the branch/);
      expect(prompt).toMatch(/\.agent-done/);
    });

    // #3733 — the inline review loop is the SAME builder the `sys-rl-*` follow-up
    // agent gets, so the only things that can be wrong are its framing.
    it('the inline review loop never claims a reviewer was pre-requested', () => {
      // The follow-up variant says "the system already requested the initial
      // Copilot review". Inline, nothing did — the agent opened the PR seconds
      // ago, so that wording would have it poll forever for a review no one asked for.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true, reviewers: ['copilot'] } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt', baseBranch: 'main' },
        isTruthyMeta,
        { isTui: true, providerId: 'antigravity-tui', providerCommand: 'agy' });
      expect(prompt).toMatch(/## Review Loop/);
      expect(prompt).not.toMatch(/## Review-Loop Follow-up/);
      expect(prompt).not.toMatch(/already requested the initial Copilot/);
      expect(prompt).toMatch(/request\/invoke each configured reviewer yourself/);
      // …and it must not tell an agent that never ran `/do:pr` that a saved
      // `/do:pr` default might have merged the PR for it.
      expect(prompt).not.toMatch(/a saved `\/do:pr` default can merge it/);
    });

    it('the inline review loop hands control back to the sentinel, not to an exit', () => {
      // The follow-up variant ends "Exit — the system will clean up your
      // worktree". A TUI run that exits there never writes `.agent-done` and
      // idles into a false timeout with the PR already merged.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true, reviewers: ['codex'] } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt', baseBranch: 'main' },
        isTruthyMeta,
        { isTui: true, providerId: 'codex-tui', providerCommand: 'codex' });
      expect(prompt).toMatch(/write the completion sentinel — the run is not done until you have/);
      expect(prompt).not.toMatch(/The system will clean up your worktree on exit/);
    });

    it('a CLI inline review loop ends by exiting — a CLI run has no sentinel to write', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true, reviewers: ['codex'] } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt', baseBranch: 'main' },
        isTruthyMeta,
        { isTui: false, providerId: 'codex', providerCommand: 'codex' });
      expect(prompt).toMatch(/## Review Loop/);
      expect(prompt).toMatch(/You are done — exit/);
      expect(prompt).not.toMatch(/write the completion sentinel — the run is not done/);
    });

    it('inlines the slashdo CLI-reviewer recipe into the inline loop, as the follow-up gets', () => {
      // Without it the agent only sees "invoke that CLI" and reverse-engineers
      // the invocation — the failure that had a codex agent burn a dozen
      // `--help` probes before stumbling into a working review call.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true, reviewers: ['codex'] } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt', baseBranch: 'main' },
        isTruthyMeta,
        {
          isTui: true, providerId: 'codex-tui', providerCommand: 'codex',
          localAgentLoopBody: 'RECIPE: codex --sandbox read-only review --base <base>',
        });
      expect(prompt).toMatch(/### CLI Reviewer Procedure \(codex\)/);
      expect(prompt).toMatch(/RECIPE: codex --sandbox read-only review/);
      expect(prompt).toMatch(/do NOT probe the CLI/);
    });

    it('points an over-budget CLI-reviewer recipe at its staged file instead of pasting 40KB', () => {
      // The real recipe is ~40KB. A follow-up agent inlines it because the loop
      // is its whole job; an initial run is already carrying the actual task.
      const body = 'RECIPE HEADER\n' + 'x'.repeat(40_000);
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true, reviewers: ['codex'] } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt', baseBranch: 'main' },
        isTruthyMeta,
        {
          isTui: true, providerId: 'codex-tui', providerCommand: 'codex',
          localAgentLoopBody: body,
          localAgentLoopBodyPath: '/data/slashdo-resolved/local-agent-review-loop.md',
        });
      expect(prompt).toMatch(/### CLI Reviewer Procedure \(codex\)/);
      expect(prompt).toMatch(/READ THAT FILE/);
      expect(prompt).toMatch(/\/data\/slashdo-resolved\/local-agent-review-loop\.md/);
      expect(prompt).not.toMatch(/RECIPE HEADER/);
      expect(prompt.length).toBeLessThan(20_000);
    });

    it('quotes a hostile branch ref inert in the PR-create command line', () => {
      // Branch names are usually PortOS's own, but a JIRA-derived one is external
      // input — and this text is pasted straight into an agent's terminal, so it
      // goes through the canonical `shellQuote` rather than being dropped for a
      // placeholder the agent would have to guess at.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true } }),
        '/r',
        { branchName: 'weird;rm -rf /', worktreePath: '/tmp/wt', baseBranch: 'main' },
        isTruthyMeta,
        { isTui: true, providerId: 'codex-tui', providerCommand: 'codex' });
      expect(prompt).toMatch(/git push -u origin 'weird;rm -rf \/'/);
      expect(prompt).toMatch(/gh pr create --base main --head 'weird;rm -rf \/'/);
      // Never bare — that would be a command substitution waiting to happen.
      expect(prompt).not.toMatch(/origin weird;rm/);
    });

    it('leaves a readable branch unquoted, and falls back to a placeholder with no ref', () => {
      const readable = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true } }),
        '/r',
        { branchName: 'cos/task-1/agent-2', worktreePath: '/tmp/wt', baseBranch: 'main' },
        isTruthyMeta,
        { isTui: true, providerId: 'codex-tui', providerCommand: 'codex' });
      expect(readable).toMatch(/git push -u origin cos\/task-1\/agent-2/);

      const noBase = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta,
        { isTui: true, providerId: 'codex-tui', providerCommand: 'codex' });
      expect(noBase).toMatch(/gh pr create --base <base-branch> --head b/);
    });

    it('a path-configured claude binary under a custom provider id gets the slashdo workflow', () => {
      // The old `hasSlashdo` gate was an id allowlist (`claude-code` /
      // `claude-code-bedrock`), so a renamed or path-configured claude provider
      // was denied `/simplify` + `/do:pr` even though it launches claude.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, simplify: true } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta,
        { isTui: false, providerId: 'my-custom-agent', providerCommand: '/opt/homebrew/bin/claude' });
      expect(prompt).toMatch(/^## Completion$/m);
      expect(prompt).toMatch(/`\/simplify`/);
      expect(prompt).toMatch(/`\/do:pr/);
      expect(prompt).not.toMatch(/PortOS will push and open the PR/);
    });

    it('an antigravity TUI also drops out of the slashdo workflow', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: false } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta,
        { isTui: true, providerId: 'antigravity-tui', providerCommand: 'agy' });
      expect(prompt).not.toMatch(/`\/do:push`/);
      expect(prompt).not.toMatch(/git push/);
      expect(prompt).toMatch(/PortOS will merge it back/);
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
        { isTui: false, providerId: 'codex', providerCommand: 'codex' });
      expect(prompt).toMatch(/^## Completion$/m);
      expect(prompt).not.toMatch(/`\/do:pr`/);
      expect(prompt).not.toMatch(/`\/quit`/);
      // Owns the lifecycle via plain git/gh instead of handing it to PortOS (#3733),
      // and — being a CLI, not a TUI — never mentions a completion sentinel.
      expect(prompt).toMatch(/gh pr create/);
      expect(prompt).not.toMatch(/PortOS will push and open the PR/);
      expect(prompt).not.toMatch(/\.agent-done/);
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
        { isTui: false, providerId: 'antigravity-cli', providerCommand: 'agy' });
      expect(prompt).toMatch(/^## Completion$/m);
      expect(prompt).not.toMatch(/`\/simplify`/);
      expect(prompt).toMatch(/review your changed code for reuse, quality, and efficiency/i);
      expect(prompt).toMatch(/gh pr create/);
      expect(prompt).not.toMatch(/PortOS will push and open the PR/);
    });

    // #3114 — the gates now derive from `resolveSlashdoStyle` with the spawners'
    // blank-command posture, so a CLI provider with NO id and NO command reads as
    // Claude: `buildCliSpawnConfig`'s default branch launches `claude`, and the
    // session that actually runs does have `/do:pr` / `/simplify`.
    it('treats a blank CLI provider as Claude Code, matching what the spawner launches', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, simplify: true } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta,
        { isTui: false });
      expect(prompt).toMatch(/`\/simplify`/);
      expect(prompt).toMatch(/`\/do:pr/);
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

    it('disables external review but merges on green CI for Claude Code CLI when Review Loop is off', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, simplify: false } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta,
        { isTui: false, providerId: 'claude-code' });
      expect(prompt).toMatch(/`\/do:pr --review-with none`/);
      expect(prompt).toMatch(/external review disabled/i);
      expect(prompt).not.toMatch(/Copilot review loop/i);
      // No review loop means nothing else merges the PR — the agent gates on CI.
      expect(prompt).toMatch(/gh pr checks "<PR_URL>" --watch --fail-fast/);
      expect(prompt).toMatch(/gh pr merge "<PR_URL>" --merge --delete-branch/);
      expect(prompt).toMatch(/gh pr view "<PR_URL>" --json state -q \.state/);
      expect(prompt).not.toMatch(/review loop reports/);
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
      // A read-only TUI agent must still be told to write .agent-done — the
      // sentinel watcher is its only clean finalize/summary path (regression: the
      // read-only branch used to emit the bare notice with no sentinel, so
      // reference-watch runs never signaled completion).
      expect(prompt).toMatch(/\.agent-done/);
      expect(prompt).toMatch(/watches this sentinel/);
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
      // Challenge protocol (#2471): the auto-invoke instructions + the challenge
      // endpoint for THIS source task must be present in the review-loop section.
      expect(prompt).toMatch(/Challenge protocol/);
      expect(prompt).toMatch(/api\/cos\/tasks\/task-src-1\/challenge/);
      expect(prompt).toMatch(/challenge\/resolve/);
    });

    it('renders a merge-only follow-up block (no reviewers) when reviewLoopMergeOnly is set', () => {
      // Review Loop off: PortOS opened the PR and spawned this follow-up purely to
      // land it. The block must gate on CI, never invoke or wait for a reviewer.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopMergeOnly: true,
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 9,
          reviewLoopPROwner: 'o',
          reviewLoopPRRepo: 'r',
          reviewLoopReviewers: [],
          sourceTaskId: 'task-src-2',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta);
      expect(prompt).toMatch(/## Merge Follow-up/);
      expect(prompt).not.toMatch(/## Review-Loop Follow-up/);
      // CI is the gate, and the merge command matches the review-loop contract.
      expect(prompt).toMatch(/gh pr checks "https:\/\/github\.com\/o\/r\/pull\/9" --watch --fail-fast/);
      expect(prompt).toMatch(/gh pr merge "https:\/\/github\.com\/o\/r\/pull\/9" --merge --delete-branch/);
      expect(prompt).not.toMatch(/gh pr merge[^\n]*--auto/);
      expect(prompt).toMatch(/gh pr view "https:\/\/github\.com\/o\/r\/pull\/9" --json state/);
      expect(prompt).toMatch(/MERGED/);
      // No reviewer defaulting may leak back in (normalizeReviewers would say copilot).
      expect(prompt).not.toMatch(/copilot/i);
      expect(prompt).not.toMatch(/Reviewers \(in order\)/);
      expect(prompt).not.toMatch(/--review-with/);
    });

    it('a merge-only follow-up on a GitLab MR gets glab commands, not gh', () => {
      // PortOS opens MRs via glab too, so a gh-only procedure would fail on the
      // first command after a full agent spawn.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopMergeOnly: true,
          reviewLoopPRUrl: 'https://gitlab.com/g/p/-/merge_requests/5',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 5,
          reviewLoopPRHost: 'gitlab.com',
          sourceTaskId: 'task-src-3',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta);
      expect(prompt).toMatch(/## Merge Follow-up/);
      // Addressed by MR IID — `glab mr merge` does not accept a URL.
      expect(prompt).toMatch(/glab mr merge 5 --yes --remove-source-branch/);
      expect(prompt).toMatch(/glab ci status/);
      expect(prompt).toMatch(/glab mr view 5/);
      expect(prompt).not.toMatch(/gh pr merge/);
      expect(prompt).not.toMatch(/gh pr checks/);
    });

    it('a merge-only follow-up on GitHub Enterprise keeps gh commands', () => {
      // Regression: classifying "host !== github.com" as GitLab handed a GHES PR
      // glab commands that cannot merge it.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopMergeOnly: true,
          reviewLoopPRUrl: 'https://github.example.com/o/r/pull/7',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 7,
          reviewLoopPRHost: 'github.example.com',
          sourceTaskId: 'task-src-4',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta);
      expect(prompt).toMatch(/gh pr merge "https:\/\/github\.example\.com\/o\/r\/pull\/7" --merge --delete-branch/);
      expect(prompt).not.toMatch(/glab/);
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

    // Regression for the release-review finding: #2507 made only the reviewer
    // LIST default-aware on the inline `/do:pr` path (TUI + PR-owning claude-code
    // agents), leaving its four companions (usernames, optionalReviewers,
    // stopMode, reviewerApplies) resolved from task metadata alone. A task that
    // pins no reviewer config must inherit ALL FIVE from Code Review Defaults —
    // matching resolveReviewLoopOptions on the non-PR-owning CLI follow-up path.
    it('threads ALL FIVE Code Review Default fields into the inline /do:pr (not just reviewers)', () => {
      const codeReviewDefaults = {
        reviewers: ['codex', 'ollama'],
        usernames: ['alice'],
        optionalReviewers: ['ollama'],
        stopMode: 'on-findings',
        reviewerApplies: true,
      };
      const prompt = buildLightContextPrompt(
        // No reviewer config on the task itself — every field comes from defaults.
        makeTask({ metadata: { openPR: true, reviewLoop: true } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta,
        { isTui: true, defaultReviewers: codeReviewDefaults.reviewers, codeReviewDefaults });
      expect(prompt).toMatch(/--review-with codex,ollama~opt,@alice --review-stop-on-findings --reviewer-applies/);
    });

    it('threads per-reviewer ~max caps from the Code Review Defaults into the inline /do:pr', () => {
      const codeReviewDefaults = {
        reviewers: ['codex', 'ollama'],
        optionalReviewers: ['ollama'],
        // `~opt` first, then `~max=<n>` — slashdo's canonical order.
        reviewerMaxRounds: { ollama: 1, codex: 2 },
      };
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta,
        { isTui: true, defaultReviewers: codeReviewDefaults.reviewers, codeReviewDefaults });
      expect(prompt).toMatch(/--review-with codex~max=2,ollama~opt~max=1/);
    });

    it('lets a task-level ~max cap map override the defaults', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true, reviewers: ['ollama'], reviewerMaxRounds: { ollama: 0 } } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta,
        { isTui: true, defaultReviewers: ['ollama'], codeReviewDefaults: { reviewers: ['ollama'], reviewerMaxRounds: { ollama: 3 } } });
      // `0` = loop until clean, and it must not be mistaken for "no cap".
      expect(prompt).toMatch(/--review-with ollama~max=0/);
    });

    it('does not leak default usernames/stop-mode/reviewer-applies when no Code Review Defaults are set', () => {
      // Same task, no `codeReviewDefaults` option → the lone-copilot default,
      // which suppresses `--review-with` entirely and emits none of the flags.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta,
        { isTui: true });
      expect(prompt).not.toMatch(/@alice/);
      expect(prompt).not.toMatch(/~opt/);
      expect(prompt).not.toMatch(/--review-stop-on-findings/);
      expect(prompt).not.toMatch(/--reviewer-applies/);
    });

    it('appends GitHub reviewer usernames as @user tokens and instructs requesting them', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 9,
          reviewLoopReviewers: ['copilot'],
          reviewLoopReviewerUsernames: ['CodeReviewbot'],
          sourceTaskId: 'task-src-u',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta);
      expect(prompt).toMatch(/--review-with copilot,@CodeReviewbot/);
      // The agent is told to request the username as a PR reviewer that gates merge.
      expect(prompt).toMatch(/--add-reviewer/);
      expect(prompt).toMatch(/@CodeReviewbot/);
    });

    it('drives a username-only review loop (no keyed reviewer)', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 9,
          // Empty keyed list (e.g. copilot stripped on a non-GitHub forge) + a username.
          reviewLoopReviewers: [],
          reviewLoopReviewerUsernames: ['CodeReviewbot'],
          sourceTaskId: 'task-src-uonly',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta);
      expect(prompt).toMatch(/--review-with @CodeReviewbot/);
      // No copilot fallback re-introduced.
      expect(prompt).not.toMatch(/--review-with copilot/);
    });

    it('threads a reviewer-keyed model map into each CLI invocation', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 9,
          reviewLoopReviewers: ['codex', 'claude'],
          reviewLoopReviewerModels: { codex: 'gpt-5.6-sol', claude: 'qwen2.5:7b' },
          sourceTaskId: 'task-src-map',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta);
      expect(prompt).toMatch(/codex --model gpt-5\.6-sol/);
      expect(prompt).toMatch(/claude --model qwen2\.5:7b/);
    });

    it('threads a reviewer-keyed effort map onto each CLI invocation, in that CLI-specific flag form', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 9,
          reviewLoopReviewers: ['codex', 'claude', 'antigravity'],
          reviewLoopReviewerModels: { codex: 'gpt-5.6-sol' },
          reviewLoopReviewerEfforts: { codex: 'high', claude: 'xhigh', antigravity: 'low' },
          sourceTaskId: 'task-src-effort',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta);
      // codex takes a config pair; claude and agy take --effort. The model pin
      // and the effort ride the SAME command line when both are set.
      expect(prompt).toMatch(/codex --model gpt-5\.6-sol -c model_reasoning_effort=high/);
      expect(prompt).toMatch(/claude --effort xhigh/);
      // `antigravity` names no executable — the invocation must say `agy`.
      expect(prompt).toMatch(/agy --effort low/);
      expect(prompt).not.toMatch(/antigravity --effort/);
    });

    it('folds a cursor effort into its --model — the follow-up must never print `cursor-agent --effort`', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 9,
          reviewLoopReviewers: ['cursor'],
          reviewLoopReviewerModels: { cursor: 'gpt-5' },
          reviewLoopReviewerEfforts: { cursor: 'max' },
          sourceTaskId: 'task-src-cursor-effort',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta);
      // This is a literal command line the agent runs; `cursor-agent --effort max`
      // exits non-zero, so the level has to ride the model variant instead.
      expect(prompt).toMatch(/cursor-agent --model gpt-5\[effort=max\]/);
      expect(prompt).not.toMatch(/cursor-agent[^\n]*--effort/);
    });

    it('names a pinned local-LLM effort as an /api/code-review/local body key', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 9,
          reviewLoopReviewers: ['ollama'],
          reviewLoopReviewerEfforts: { ollama: 'high' },
          sourceTaskId: 'task-src-local-effort',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta);
      expect(prompt).toContain('"effort": "high"');
      // The effort has no slashdo suffix, so it must NOT leak into the flag string.
      expect(prompt).not.toMatch(/--review-with[^\n]*effort/);
    });

    it('spells out per-reviewer ~max round caps in the follow-up loop instructions', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 9,
          reviewLoopReviewers: ['codex', 'ollama'],
          // `bogus` isn't in the list, so it must not reach the prose.
          reviewLoopReviewerMaxRounds: { ollama: 1, codex: 0, copilot: 3 },
          sourceTaskId: 'task-src-max',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta);
      // This prompt drives the loop in prose, so the cap has to be stated —
      // the `equiv` flag string alone wouldn't bind the agent.
      expect(prompt).toMatch(/Round caps \(~max\)/);
      expect(prompt).toMatch(/`ollama` → 1 round/);
      // 0 renders as unlimited, not as a zero-round budget.
      expect(prompt).toMatch(/`codex` → loop until clean/);
      expect(prompt).not.toMatch(/`copilot` →/);
      // And the equivalent flag string carries the same suffixes.
      expect(prompt).toMatch(/--review-with codex~max=0,ollama~max=1/);
    });

    it('omits the round-caps note when no cap is configured', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 9,
          reviewLoopReviewers: ['codex', 'ollama'],
          sourceTaskId: 'task-src-nomax',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta);
      expect(prompt).not.toMatch(/Round caps \(~max\)/);
      expect(prompt).toMatch(/--review-with codex,ollama/);
    });

    it('threads a configured claude model (Ollama-backed reviewer) via the map', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 9,
          reviewLoopReviewers: ['claude'],
          reviewLoopReviewerModels: { claude: 'qwen2.5:7b' },
          sourceTaskId: 'task-src-cl',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta);
      expect(prompt).toMatch(/claude --model qwen2\.5:7b/);
    });

    it('threads each configured model id verbatim, without env-dependent mapping', () => {
      // Even with Bedrock enabled in the process env, the prompt layer does NOT
      // map a bare Claude tier to a Bedrock id — it has only a providerId, not the
      // merged spawn env, and the reviewer CLI is spawned by the agent, not PortOS.
      // The user configures the exact id their environment needs (free-text field).
      const prev = process.env.CLAUDE_CODE_USE_BEDROCK;
      process.env.CLAUDE_CODE_USE_BEDROCK = '1';
      try {
        const prompt = buildLightContextPrompt(
          makeTask({ metadata: {
            reviewLoopFollowUp: true,
            reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
            reviewLoopPRBranch: 'b',
            reviewLoopPRNumber: 9,
            reviewLoopReviewers: ['claude', 'codex'],
            reviewLoopReviewerModels: { claude: 'us.anthropic.claude-opus-4-8', codex: 'gpt-5.6-sol' },
            sourceTaskId: 'task-src-verbatim',
          }}),
          '/r',
          { branchName: 'b', worktreePath: '/tmp/wt' },
          isTruthyMeta);
        // Both ids appear exactly as configured — no Bedrock rewrite, no mangling.
        expect(prompt).toMatch(/claude --model us\.anthropic\.claude-opus-4-8/);
        expect(prompt).toMatch(/codex --model gpt-5\.6-sol/);
      } finally {
        if (prev === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK;
        else process.env.CLAUDE_CODE_USE_BEDROCK = prev;
      }
    });

    it('falls back to the legacy codex-scalar metadata key when the map is absent', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 9,
          reviewLoopReviewers: ['codex'],
          // Written by an older install: only the codex scalar, no map.
          reviewLoopCodexModel: 'gpt-5.6-sol',
          sourceTaskId: 'task-src-cx',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        isTruthyMeta);
      expect(prompt).toMatch(/codex --model gpt-5\.6-sol/);
    });

    it('does not leak a stale legacy codex scalar into a claude-only review', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 9,
          reviewLoopReviewers: ['claude'],
          // Stale model tier from a prior codex config — the legacy fallback maps
          // it to codex, which is NOT among the reviewers, so it must not leak.
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
      expect(prompt).toMatch(/jq -er '\.findings \| select\(type == "string" and length > 0\)'/);
      expect(prompt).toMatch(/Never treat an absent or malformed response as clean/);
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
      // `reviewLoopFollowUp` is what identifies this case — the PR-branch guidance
      // keys on that marker, not on bare `existingBranch`, so the OTHER producer of
      // `existingBranch` (a resume) can't inherit review-fix instructions for a PR
      // that may not exist.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, simplify: true, reviewLoopFollowUp: true } }),
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

    it('a RESUMED worktree gets the resume briefing, not the PR-branch review-fix wording', () => {
      // A retry attached to a dead agent's branch rides the same `existingBranch`
      // mechanism but follows the task's ordinary push/PR flow — there may be no PR
      // at all. It must be told what is already done instead of being told to push
      // review fixes to a PR that doesn't exist.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, simplify: true, resumedFromAgentId: 'agent-dead' } }),
        '/r',
        { branchName: 'cos/task-1/agent-dead', worktreePath: '/tmp/wt', existingBranch: true },
        isTruthyMeta,
        { isTui: false, providerId: 'claude-code' });
      expect(prompt).toMatch(/## Resuming Unfinished Work/);
      expect(prompt).toMatch(/agent-dead/);
      expect(prompt).not.toMatch(/\*\(pre-existing PR branch\)\*/);
      expect(prompt).not.toMatch(/review-fix commits/);
    });

    it('omits the resume briefing for an ordinary fresh worktree', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, simplify: true } }),
        '/r',
        { branchName: 'cos/task-1/agent-new', worktreePath: '/tmp/wt', baseBranch: 'main' },
        isTruthyMeta,
        { isTui: false, providerId: 'claude-code' });
      expect(prompt).toMatch(/## Git Worktree/);
      expect(prompt).not.toMatch(/## Resuming Unfinished Work/);
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
      expect(prompt).toMatch(/agent-prev-1[\\/]output\.txt/);
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

  it('passes the app id as targetAppLabel to the api-path briefing template for a managed app', async () => {
    vi.mocked(buildPrompt).mockClear();
    await buildAgentPrompt(
      makeTask({ metadata: { app: 'comics' } }), {}, '/r', null, isTruthyMeta,
      { providerType: 'api' });
    const [name, context] = vi.mocked(buildPrompt).mock.calls.at(-1);
    expect(name).toBe('cos-agent-briefing');
    expect(context.targetAppLabel).toBe('comics');
    // task.metadata.app stays available for any custom template references.
    expect(context.task.metadata.app).toBe('comics');
  });

  // #4153 — every shipped AND user-customized `cos-agent-briefing.md` addresses
  // `{{task.metadata.context}}`. Folding the split back into that key at render
  // time is what keeps the payload reaching the agent without pushing a template
  // change (and a prompt migration) onto every install.
  it('folds metadata.prompt into the briefing template\'s task.metadata.context', async () => {
    vi.mocked(buildPrompt).mockClear();
    await buildAgentPrompt(
      makeTask({ metadata: { prompt: 'the agent body\nsecond line', context: 'a short note' } }),
      {}, '/r', null, isTruthyMeta, { providerType: 'api' });
    const [, context] = vi.mocked(buildPrompt).mock.calls.at(-1);
    expect(context.task.metadata.context).toBe('the agent body\nsecond line\n\na short note');
    // The raw field still travels for a custom template that addresses it.
    expect(context.task.metadata.prompt).toBe('the agent body\nsecond line');
  });

  it('keeps a queue-path prompt available to a customized briefing template', async () => {
    vi.mocked(buildPrompt).mockClear();
    await buildAgentPrompt(
      makeTask({
        description: 'the agent body',
        metadata: { prompt: 'the agent body\nsecond line', context: 'a short note' },
      }),
      {}, '/r', null, isTruthyMeta, { providerType: 'api' });
    const [, context] = vi.mocked(buildPrompt).mock.calls.at(-1);
    expect(context.task.description).toBe('the agent body\nsecond line');
    expect(context.task.metadata.prompt).toBe('the agent body\nsecond line');
    expect(context.task.metadata.context).toBe('a short note');
  });

  it('leaves a legacy context-only task untouched on the briefing template path', async () => {
    vi.mocked(buildPrompt).mockClear();
    const task = makeTask({ metadata: { context: 'legacy body\nsecond line' } });
    await buildAgentPrompt(task, {}, '/r', null, isTruthyMeta, { providerType: 'api' });
    const [, context] = vi.mocked(buildPrompt).mock.calls.at(-1);
    expect(context.task.metadata.context).toBe('legacy body\nsecond line');
  });

  it('passes an empty targetAppLabel to the api-path briefing template for the PortOS default app', async () => {
    vi.mocked(buildPrompt).mockClear();
    await buildAgentPrompt(
      makeTask({ metadata: { app: 'portos-default' } }), {}, '/r', null, isTruthyMeta,
      { providerType: 'api' });
    const [, context] = vi.mocked(buildPrompt).mock.calls.at(-1);
    expect(context.targetAppLabel).toBe('');
    // The raw app id is NOT stripped from the context — only the label gates.
    expect(context.task.metadata.app).toBe('portos-default');
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
    // The generic completion guidance must not contradict the follow-up section:
    // its cleanup runs with skipMerge, and a clean run makes no commit at all.
    expect(prompt).not.toMatch(/automatically merged back to the source branch/);
    expect(prompt).toMatch(/Follow the follow-up section above/);
  });
});

// A `/do:plan-task` run parked on its skill's approval gate for its entire life
// and was retried into the same gate three times, filing nothing — the briefing
// never told it that nobody was there to answer. Every path that produces an
// agent briefing must carry that rule.
describe('unattended-run rule reaches every prompt path', () => {
  const RULE_HEADING = /## ⚠️ Unattended Run/;
  const wt = { branchName: 'cos/t/a', worktreePath: '/tmp/wt', baseBranch: 'main' };

  it('rides in the light-context prompt', () => {
    const prompt = buildLightContextPrompt(makeTask(), '/repo', null, isTruthyMeta);
    expect(prompt).toMatch(RULE_HEADING);
    expect(prompt).toMatch(/Never ask the user to choose or approve/);
  });

  it('rides in the SYSTEM half of a split prompt, not the user half', async () => {
    const parts = await buildAgentPrompt(
      makeTask(), {}, '/r', wt, isTruthyMeta,
      { providerType: 'tui', providerId: 'claude-code-tui', providerCommand: 'claude', split: true });
    expect(parts.systemPrompt).toMatch(RULE_HEADING);
    expect(parts.userPrompt).not.toMatch(RULE_HEADING);
  });

  it('rides in the full built-in-template prompt', async () => {
    vi.mocked(buildPrompt).mockResolvedValueOnce(null);
    const prompt = await buildAgentPrompt(
      makeTask(), {}, '/r', null, isTruthyMeta, { providerType: 'api' });
    expect(prompt).toMatch(RULE_HEADING);
  });

  it('rides in a custom-template prompt', async () => {
    vi.mocked(buildPrompt).mockResolvedValueOnce({ prompt: 'Custom rendered briefing.' });
    const prompt = await buildAgentPrompt(
      makeTask(), {}, '/r', null, isTruthyMeta, { providerType: 'api' });
    expect(prompt).toMatch(RULE_HEADING);
  });

  it('names no slashdo slash-command form — skill-style CLIs cannot type one', () => {
    expect(UNATTENDED_RUN_RULE).not.toMatch(/\/do:/);
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

  it('slashdo-free TUI bullet points at the commit + PortOS handoff, not a /do:* command', () => {
    const bullet = buildCompletionGuidelineBullet({
      isReadOnly: false, isTui: true, slashdoFree: true,
      tuiCompletionCommand: '/do:pr', worktreeInfo: { worktreePath: '/wt' }, willOpenPR: true, willReviewLoop: false,
    });
    expect(bullet).toMatch(/plain `git` commit \+ PortOS handoff/);
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
    // Without a review loop, a follow-up merges on green CI...
    expect(prBullet).toMatch(/merges the PR once CI is green/);
    // ...unless the PR is a human's to land, where the bullet must not promise a merge.
    const jiraBullet = buildCompletionGuidelineBullet({
      isReadOnly: false, isTui: false, tuiCompletionCommand: '/do:pr',
      worktreeInfo: { worktreePath: '/wt' }, willOpenPR: true, willReviewLoop: false, leavePrOpen: true,
    });
    expect(jiraBullet).toMatch(/left OPEN for a human/);
    expect(jiraBullet).not.toMatch(/merges the PR once CI is green/);
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

  it('claimFlow short-circuits to the claim-owned lifecycle bullet', () => {
    const bullet = buildCompletionGuidelineBullet({
      isReadOnly: false, isTui: true, tuiCompletionCommand: '/do:push',
      worktreeInfo: null, willOpenPR: false, claimFlow: true,
    });
    expect(bullet).toMatch(/self-managed claim flow/i);
    expect(bullet).toMatch(/Do NOT stop after committing/);
    expect(bullet).not.toMatch(/PortOS will merge/);
  });

  it('noCodeOutput wins over discardWorktree — the deliverable is the action, not the sentinel', () => {
    // The two flags answer different questions: discardWorktree decides what
    // happens to the checkout, noCodeOutput decides where the deliverable goes.
    // A task that does its work through an external action DURING the run (an
    // endpoint call, a filed issue) and also throws the tree away must not be
    // told "write your result to the sentinel" — that is how a run performs no
    // action and reports its findings into a file that is then discarded.
    const bullet = buildCompletionGuidelineBullet({
      isReadOnly: false, isTui: true, tuiCompletionCommand: '/do:pr',
      worktreeInfo: { worktreePath: '/wt' }, willOpenPR: true,
      discardWorktree: true, noCodeOutput: true,
    });
    expect(bullet).toMatch(/produces no code output/i);
    expect(bullet).not.toMatch(/reasoning-only task/i);
    // It names /do:pr only to forbid it — the TUI arm would have INSTRUCTED it.
    expect(bullet).toMatch(/do NOT run `\/do:push`, `\/do:pr`/);
    expect(bullet).not.toMatch(/YOU run the Completion Workflow/);
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

  // A discard task whose deliverable is an EXTERNAL action performed during the
  // run (a filed issue, an endpoint call) must get the no-code-output contract,
  // NOT "write your result to the sentinel" — otherwise it reports its findings
  // into a file the cleanup then throws away, and the window produces nothing.
  //
  // Asserted on the LIGHT path specifically: every `tui`/`cli` provider returns
  // from buildLightContextPrompt, so a quota-burn job (which only ever selects
  // CLI/TUI providers — it exists to spend a subscription window) never reaches
  // the full path. A unit test on buildCompletionGuidelineBullet alone passes
  // while production is unchanged; that false green is how this shipped broken
  // once already.
  describe('with noCodeOutput — the deliverable is the action, not the sentinel', () => {
    const auditTask = () => makeTask({ metadata: { discardWorktree: true, noCodeOutput: true, useWorktree: true, openPR: false } });

    const assertActionOutput = (prompt) => {
      expect(prompt).toMatch(/## Completion \(No Code Output\)/);
      expect(prompt).not.toMatch(/## Completion \(Reasoning-Only Task\)/);
      expect(prompt).not.toMatch(/in the exact payload format/);
      expect(prompt).not.toMatch(/## Completion Workflow/);
    };

    it('light TUI path', () => {
      const prompt = buildLightContextPrompt(auditTask(), '/r', wt, isTruthyMeta, { isTui: true });
      assertActionOutput(prompt);
      // The sentinel is still the done-signal for a TUI run — just not the
      // place the deliverable goes.
      expect(prompt).toMatch(/\.agent-done/);
    });

    it('light CLI (non-TUI) path', () => {
      const prompt = buildLightContextPrompt(auditTask(), '/r', wt, isTruthyMeta, { isTui: false, providerId: 'codex' });
      assertActionOutput(prompt);
    });

    it('full (api) path', async () => {
      const prompt = await buildAgentPrompt(auditTask(), {}, '/r', wt, isTruthyMeta, { providerType: 'api' });
      assertActionOutput(prompt);
    });

    it('a no-code task with NO worktree is never told to commit to the branch it is on', async () => {
      // The dangerous shape: no worktree means the agent stands in the app's own
      // checkout, on its default branch. Git Hygiene's fallback arm ("Commit and
      // push using `/do:push`" + "Commit directly to the current branch") would
      // aim a push straight at that branch — and for a task that changes no code,
      // whatever it swept up would be the user's own uncommitted work.
      const task = makeTask({ metadata: { noCodeOutput: true, useWorktree: false, openPR: false } });
      const prompt = await buildAgentPrompt(task, {}, '/r', null, isTruthyMeta, { providerType: 'api' });
      expect(prompt).toMatch(/## Completion \(No Code Output\)/);
      expect(prompt).toMatch(/Do NOT commit, push, or open a PR/);
      expect(prompt).not.toMatch(/Commit and push using/);
      expect(prompt).not.toMatch(/Commit directly to the current branch/);
      expect(prompt).not.toMatch(/Commit and push your changes/);
    });
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

  // #3475 — The `not.toMatch(/gh pr merge/)` assertions above run with homedir
  // stubbed to a path that cannot exist, so the `## CLAUDE.md Instructions`
  // section is empty. That makes them deterministic, but on its own it can't
  // distinguish "the builder suppresses the merge instruction" from "no section
  // of this prompt could ever have contained it" — which is exactly the false
  // green CI has been shipping.
  //
  // This test closes that gap from the other side: it points homedir at a
  // fixture home whose global CLAUDE.md deliberately DOES contain `gh pr merge`,
  // then asserts (a) the fixture really is spliced into the prompt verbatim — so
  // the string is demonstrably reachable — and (b) every byte the BUILDER itself
  // generates still omits it on the discardWorktree path. Verified by probe: stub
  // buildAgentPrompt's `discardWorktree` to `false` (i.e. remove the suppression)
  // and (b) fails on `Commit and push your changes`.
  describe('suppression is positively pinned against a fixture global CLAUDE.md (#3475)', () => {
    // Obviously-fake stand-in for a contributor's personal global instructions.
    const FIXTURE_GLOBAL_CLAUDE_MD = [
      '# Example Global Instructions',
      '',
      '- When CI is green, land it with `gh pr merge <url> --merge --delete-branch`.',
      '- Commit and push your changes before you stop.',
    ].join('\n');

    let fixtureHome;
    let priorHomeStub;

    beforeAll(() => {
      priorHomeStub = homeStub.dir;
      fixtureHome = mkdtempSync(join(tmpdir(), 'portos-claudemd-fixture-'));
      mkdirSync(join(fixtureHome, '.claude'), { recursive: true });
      writeFileSync(join(fixtureHome, '.claude', 'CLAUDE.md'), FIXTURE_GLOBAL_CLAUDE_MD);
      homeStub.dir = fixtureHome;
    });

    // Restore the nonexistent-home stub — every other test in the file depends on
    // the global CLAUDE.md section being empty.
    afterAll(() => {
      homeStub.dir = priorHomeStub;
      if (fixtureHome) rmSync(fixtureHome, { recursive: true, force: true });
    });

    it('splices the fixture verbatim yet still suppresses commit/push/merge in every builder-generated section', async () => {
      // Sanity: the fixture is live and carries the strings under test. Without
      // this the assertions below could pass because nothing was read at all.
      const claudeMdSection = await getClaudeMdContext('/r');
      expect(claudeMdSection).toMatch(/## CLAUDE\.md Instructions/);
      expect(claudeMdSection).toMatch(/gh pr merge/);
      expect(claudeMdSection).toMatch(/Commit and push your changes/);

      const prompt = await buildAgentPrompt(liTask(), {}, '/r', wt, isTruthyMeta, { providerType: 'api' });
      // The verbatim splice is the production contract — the builder passes the
      // user's own instructions through untouched.
      expect(prompt).toContain(claudeMdSection);

      // Everything the builder authored. Removing the exact spliced section (rather
      // than regex-slicing around a heading) keeps the boundary unambiguous.
      const builderAuthored = prompt.replace(claudeMdSection, '');
      expect(builderAuthored).not.toMatch(/Example Global Instructions/); // strip really worked
      // Containment check, not merge coverage: this proves the fixture's own copy
      // of the string stays inside the spliced section and can't decide the
      // assertion — which is the exact confusion that made #3475 false-fail. The
      // api path never emits merge guidance anyway; that half of the contract is
      // pinned by the TUI sibling below.
      expect(builderAuthored).not.toMatch(/gh pr merge/);
      // Non-vacuous: drop the discardWorktree arm and step 4 of the fallback
      // template renders "Commit and push your changes" here.
      expect(builderAuthored).not.toMatch(/Commit and push your changes/);
      expect(builderAuthored).not.toMatch(/## Completion Workflow/);
      // …and the positive half of the same contract still renders.
      expect(builderAuthored).toMatch(/## Completion \(Reasoning-Only Task\)/);
      expect(builderAuthored).toMatch(/Do NOT commit, push, or open a PR/);
    });

    it('light TUI path suppresses the merge instruction and never splices the global CLAUDE.md at all', () => {
      // `openPR: true` on purpose: this is the shape where merge suppression has
      // to do work — the task metadata asks for a PR, and discardWorktree must
      // still win. Remove the discardWorktree arm and this prompt falls through to
      // buildTuiCompletionSection, which renders `gh pr merge … --merge
      // --delete-branch`. (The `openPR: false` sibling above never reaches that
      // line at all, which is why its /gh pr merge/ check can't carry this.)
      const prTask = makeTask({ metadata: { discardWorktree: true, useWorktree: true, openPR: true, simplify: true } });
      const prompt = buildLightContextPrompt(prTask, '/r', wt, isTruthyMeta, { isTui: true });
      expect(prompt).not.toMatch(/gh pr merge/);
      expect(prompt).toMatch(/## Completion \(Reasoning-Only Task\)/);
      // The light path targets agentic CLIs that load CLAUDE.md natively, so the
      // builder must not paste it in. The live fixture proves that positively; the
      // nonexistent-home stub the rest of the file uses could not.
      expect(prompt).not.toMatch(/## CLAUDE\.md Instructions/);
      expect(prompt).not.toMatch(/Example Global Instructions/);
    });
  });
});

// #2507 — CoS app-improve/self-improvement tasks pin no `reviewers`, so the
// review loop must resolve them from the install's Code Review Defaults
// (settings.codeReview.reviewers) rather than the hardcoded copilot default,
// which stalls on installs without GitHub Copilot review enabled.
describe('buildAgentPrompt — reviewer resolution honors Code Review Defaults (#2507)', () => {
  const reviewLoopTask = () => makeTask({ metadata: { openPR: true, reviewLoop: true, simplify: false } });
  // Claude Code CLI keeps the slashdo /do:pr workflow, so the reviewer list
  // surfaces as `--review-with <csv>` in the completion block.
  const claudeCliOpts = { providerType: 'cli', providerId: 'claude-code', providerCommand: 'claude' };

  it('threads a configured default reviewer list into --review-with when the task pins none', async () => {
    vi.mocked(getCodeReviewDefaults).mockResolvedValueOnce({ reviewers: ['claude', 'codex'] });
    const prompt = await buildAgentPrompt(reviewLoopTask(), {}, '/r', { branchName: 'b', worktreePath: '/tmp/wt' }, isTruthyMeta, claudeCliOpts);
    expect(prompt).toMatch(/`\/do:pr --review-with claude,codex`/);
    // The stalling copilot default must not leak in.
    expect(prompt).not.toMatch(/--review-with copilot/);
  });

  it('falls back to copilot (unchanged behavior) when no default is configured', async () => {
    vi.mocked(getCodeReviewDefaults).mockResolvedValueOnce({ reviewers: ['copilot'] });
    const prompt = await buildAgentPrompt(reviewLoopTask(), {}, '/r', { branchName: 'b', worktreePath: '/tmp/wt' }, isTruthyMeta, claudeCliOpts);
    // Lone-copilot default is suppressed from --review-with (buildReviewWithArgs
    // isDefaultOnly), so /do:pr runs without an explicit reviewer flag.
    expect(prompt).toMatch(/`\/do:pr`/);
    expect(prompt).not.toMatch(/--review-with claude/);
  });

  it('a task-pinned reviewer list still wins over the configured default', async () => {
    vi.mocked(getCodeReviewDefaults).mockResolvedValueOnce({ reviewers: ['claude', 'codex'] });
    const task = makeTask({ metadata: { openPR: true, reviewLoop: true, simplify: false, reviewers: ['grok'] } });
    const prompt = await buildAgentPrompt(task, {}, '/r', { branchName: 'b', worktreePath: '/tmp/wt' }, isTruthyMeta, claudeCliOpts);
    expect(prompt).toMatch(/`\/do:pr --review-with grok`/);
    expect(prompt).not.toMatch(/--review-with claude/);
  });

  it('degrades to the hardcoded copilot default when the settings read fails', async () => {
    vi.mocked(getCodeReviewDefaults).mockRejectedValueOnce(new Error('settings unavailable'));
    const prompt = await buildAgentPrompt(reviewLoopTask(), {}, '/r', { branchName: 'b', worktreePath: '/tmp/wt' }, isTruthyMeta, claudeCliOpts);
    expect(prompt).toMatch(/`\/do:pr`/);
    expect(prompt).not.toMatch(/--review-with claude/);
  });
});

describe('buildReviewLoopFollowUpSection — CLI reviewer procedure inlining', () => {
  // The follow-up agent used to receive only "invoke that CLI to review this
  // branch's diff", so a headless codex agent reverse-engineered the `claude`
  // invocation with a dozen probe calls. It now inlines slashdo's local-agent
  // review-loop recipe (passed in as localAgentLoopBody) whenever a spawnable
  // CLI reviewer is configured — never for a copilot/@github-only loop.
  const LOOP_SENTINEL = 'SLASHDO-LOCAL-AGENT-LOOP-BODY-SENTINEL';
  const baseMeta = {
    reviewLoopFollowUp: true,
    sourceTaskId: 't1',
    reviewLoopPRUrl: 'https://github.com/o/r/pull/1',
    reviewLoopPRBranch: 'feature-b',
  };

  for (const verbose of [false, true]) {
    it(`inlines the CLI Reviewer Procedure for a CLI reviewer (verbose=${verbose})`, () => {
      const out = buildReviewLoopFollowUpSection(
        { ...baseMeta, reviewLoopReviewers: ['claude'] },
        { verbose, localAgentLoopBody: LOOP_SENTINEL }
      );
      expect(out).toContain('CLI Reviewer Procedure');
      expect(out).toContain(LOOP_SENTINEL);
      // The vague invocation step points the agent at the inlined procedure.
      expect(out).toMatch(/do NOT probe the CLI/i);
    });
  }

  it('fails the local reviewer command when its JSON response has no findings', () => {
    const out = buildReviewLoopFollowUpSection(
      { ...baseMeta, reviewLoopReviewers: ['ollama'] },
      { verbose: false, localAgentLoopBody: null }
    );
    expect(out).toMatch(/Local reviewer failed:/);
    expect(out).toMatch(/STATUS=cli-error[^]*exit 1/);
  });

  it('does NOT inline the procedure for a copilot-only loop', () => {
    const out = buildReviewLoopFollowUpSection(
      { ...baseMeta, reviewLoopReviewers: ['copilot'] },
      { verbose: false, localAgentLoopBody: LOOP_SENTINEL }
    );
    expect(out).not.toContain('CLI Reviewer Procedure');
    expect(out).not.toContain(LOOP_SENTINEL);
  });

  it('degrades gracefully when no loop body is available (CLI reviewer, body null)', () => {
    const out = buildReviewLoopFollowUpSection(
      { ...baseMeta, reviewLoopReviewers: ['codex'] },
      { verbose: false, localAgentLoopBody: null }
    );
    expect(out).not.toContain('CLI Reviewer Procedure');
    // Still emits the base invocation step so the loop is not broken.
    expect(out).toMatch(/codex/);
  });
});

describe('buildReviewLoopFollowUpSection — reviewer slug → CLI binary', () => {
  // `antigravity` is the stored, federated reviewer slug; the executable is
  // `agy`. The prompt used to say "Invoke the `antigravity` CLI" and list a
  // fixed "codex / antigravity / claude / grok" bullet, so a follow-up agent ran
  // `command -v antigravity`, found nothing, announced "the only configured
  // reviewer is antigravity … isn't available", self-reviewed, and merged.
  const baseMeta = {
    reviewLoopFollowUp: true,
    sourceTaskId: 't1',
    reviewLoopPRUrl: 'https://github.com/o/r/pull/1',
    reviewLoopPRBranch: 'feature-b',
  };
  const build = (reviewers, verbose = false) => buildReviewLoopFollowUpSection(
    { ...baseMeta, reviewLoopReviewers: reviewers },
    { verbose, localAgentLoopBody: null },
  );

  for (const verbose of [false, true]) {
    it(`names \`agy\`, not \`antigravity\`, as the command to invoke (verbose=${verbose})`, () => {
      const out = build(['antigravity'], verbose);
      expect(out).toContain('Invoke `agy` (the `antigravity` reviewer) to review');
      expect(out).not.toMatch(/Invoke the `antigravity` CLI/);
    });
  }

  it('heads the multi-reviewer bullet with the configured binaries and maps the slug', () => {
    const out = build(['antigravity', 'codex']);
    expect(out).toContain('**agy / codex**');
    expect(out).toContain('the `antigravity` reviewer runs the `agy` binary (there is no `antigravity` command)');
    // The old hardcoded roster listed reviewers this loop never configured.
    expect(out).not.toContain('codex / antigravity / claude / grok');
  });

  it('omits the slug→binary note when every reviewer names its own binary', () => {
    const out = build(['codex', 'claude']);
    expect(out).toContain('**codex / claude**');
    expect(out).not.toContain('Reviewer slug → command');
  });

  it('titles the inlined CLI procedure with the configured binaries', () => {
    const out = buildReviewLoopFollowUpSection(
      { ...baseMeta, reviewLoopReviewers: ['antigravity'] },
      { verbose: false, localAgentLoopBody: 'BODY' },
    );
    expect(out).toContain('### CLI Reviewer Procedure (agy)');
  });

  // The second half of the failure: a reviewer that cannot run is not a clean
  // review, but the agent substituted its own self-review and merged anyway.
  it('forbids merging on a self-review when a reviewer binary is missing', () => {
    const out = build(['antigravity']);
    expect(out).toContain('command -v agy');
    expect(out).toMatch(/do NOT substitute your own self-review and do NOT merge/);
  });

  it('emits no missing-CLI note for a loop with no spawnable CLI reviewer', () => {
    const out = build(['copilot', 'ollama']);
    expect(out).not.toContain('Missing reviewer CLI');
    expect(out).not.toContain('command -v');
  });
});

// -----------------------------------------------------------------------------
// Slashdo-backed tasks (#3089)
// -----------------------------------------------------------------------------
// A quick-template task persists only the BARE command name; the invocation is
// resolved here, where the provider is finally known. Assertions are on SHAPE
// (invocation line present, body non-empty) — never on the vendored submodule's
// exact text, which is upstream's to change.
describe('buildAgentPrompt — slashdo-backed tasks', () => {
  const slashdoTask = (metadata = {}) => makeTask({
    description: 'Add rate limiting to the widget API',
    metadata: { slashdoCommand: 'plan-task', ...metadata },
  });

  beforeEach(() => {
    vi.mocked(loadSlashdoFile).mockResolvedValue(null);
  });

  it('renders the Claude Code invocation for a claude-code provider', async () => {
    const prompt = await buildAgentPrompt(
      slashdoTask(), {}, '/r', null, isTruthyMeta,
      { providerType: 'cli', providerId: 'claude-code' });
    expect(prompt).toContain('/do:plan-task');
    expect(prompt).toContain('Add rate limiting to the widget API');
  });

  it('renders the flat invocation for OpenCode', async () => {
    const prompt = await buildAgentPrompt(
      slashdoTask(), {}, '/r', null, isTruthyMeta,
      { providerType: 'tui', providerId: 'opencode-tui', providerCommand: 'opencode' });
    expect(prompt).toContain('/do-plan-task');
    expect(prompt).not.toContain('/do:plan-task');
  });

  it('names the skill instead of a slash command for a skill-style CLI', async () => {
    const prompt = await buildAgentPrompt(
      slashdoTask(), {}, '/r', null, isTruthyMeta,
      { providerType: 'cli', providerId: 'codex' });
    expect(prompt).toContain('do-plan-task');
    expect(prompt).not.toContain('/do:plan-task');
  });

  // PortOS surfaces slashdo as slash commands only via the repo-local
  // `.claude/commands/do/` symlinks, which a managed app's workspace doesn't
  // have — so the procedure ships with the prompt for every provider, and the
  // typed invocation is a shortcut, not the thing the prompt relies on.
  it.each(['claude-code', 'opencode', 'codex'])('inlines the command body for %s', async (providerId) => {
    vi.mocked(loadSlashdoFile).mockResolvedValue('# Plan Task\n\nInvestigate, then file the issue.');
    const prompt = await buildAgentPrompt(
      slashdoTask(), {}, '/r', null, isTruthyMeta,
      { providerType: 'cli', providerId });
    expect(prompt).toContain('Investigate, then file the issue.');
    // `skipIncludes: []` — nothing pruned, since this task pins no reviewers and
    // the mocked defaults are the unconfigured lone-copilot shape (#3110).
    expect(vi.mocked(loadSlashdoFile)).toHaveBeenCalledWith('plan-task', { stripFrontmatter: true, skipIncludes: [] });
  });

  it('still emits the invocation when the body cannot be loaded', async () => {
    vi.mocked(loadSlashdoFile).mockResolvedValue(null);
    const prompt = await buildAgentPrompt(
      slashdoTask(), {}, '/r', null, isTruthyMeta,
      { providerType: 'cli', providerId: 'claude-code' });
    expect(prompt).toContain('/do:plan-task');
  });

  it('uses explicit slashdoArgs when present', async () => {
    const prompt = await buildAgentPrompt(
      slashdoTask({ slashdoArgs: '--issues 42' }), {}, '/r', null, isTruthyMeta,
      { providerType: 'cli', providerId: 'claude-code' });
    expect(prompt).toContain('/do:plan-task --issues 42');
  });

  it('reaches the api-path briefing template through task.description', async () => {
    vi.mocked(buildPrompt).mockClear();
    await buildAgentPrompt(slashdoTask(), {}, '/r', null, isTruthyMeta, { providerType: 'api', providerId: 'claude-code' });
    const [, context] = vi.mocked(buildPrompt).mock.calls.at(-1);
    expect(context.task.description).toContain('/do:plan-task');
  });

  it('leaves a task with no slashdoCommand untouched', async () => {
    const prompt = await buildAgentPrompt(
      makeTask(), {}, '/r', null, isTruthyMeta,
      { providerType: 'cli', providerId: 'claude-code' });
    expect(prompt).not.toContain('Slashdo Workflow');
  });

  it('ignores an invalid command rather than joining it into a path', async () => {
    const prompt = await buildAgentPrompt(
      slashdoTask({ slashdoCommand: '../../etc/passwd' }), {}, '/r', null, isTruthyMeta,
      { providerType: 'cli', providerId: 'codex' });
    expect(prompt).not.toContain('Slashdo Workflow');
    expect(vi.mocked(loadSlashdoFile)).not.toHaveBeenCalledWith('../../etc/passwd', expect.anything());
  });
});

// -----------------------------------------------------------------------------
// Slashdo prompt-size controls (#3110)
// -----------------------------------------------------------------------------
// Expanded bodies run 38KB–317KB. Two reductions: prune the reviewer variants a
// run can't reach, then hand a file-tools host a path for whatever is still over
// budget. `api` providers have no file tools and keep inlining. Assertions are on
// SHAPE (pointer present / body present / prune set passed), never on the
// submodule's text.
describe('buildAgentPrompt — slashdo prompt-size controls', () => {
  const OVER = 'B'.repeat(SLASHDO_INLINE_BUDGET_CHARS + 500);
  const UNDER = '# Small Procedure\n\nStep one.';
  const slashdoTask = (metadata = {}) => makeTask({
    description: 'Audit the widget API',
    metadata: { slashdoCommand: 'review', ...metadata },
  });

  beforeEach(() => {
    // mockReset (not just a new return value): several tests here assert the
    // staging helper was NOT called, so a prior test's call must not leak in.
    vi.mocked(writeResolvedSlashdoBody).mockReset();
    vi.mocked(loadSlashdoFile).mockReset();
    vi.mocked(loadSlashdoFile).mockResolvedValue(OVER);
    vi.mocked(writeResolvedSlashdoBody).mockResolvedValue('/install/data/cos/slashdo-resolved/review.md');
    vi.mocked(getCodeReviewDefaults).mockResolvedValue({ reviewers: ['copilot'] });
  });

  it('hands a file-tools host a pointer instead of the body when over budget', async () => {
    const prompt = await buildAgentPrompt(
      slashdoTask(), {}, '/r', null, isTruthyMeta,
      { providerType: 'cli', providerId: 'codex' });
    expect(prompt).toContain('/install/data/cos/slashdo-resolved/review.md');
    expect(prompt).not.toContain(OVER);
    // Still actionable — the invocation survives.
    expect(prompt).toContain('do-review');
  });

  it('inlines the body when it is under budget, and stages no file', async () => {
    vi.mocked(loadSlashdoFile).mockResolvedValue(UNDER);
    const prompt = await buildAgentPrompt(
      slashdoTask(), {}, '/r', null, isTruthyMeta,
      { providerType: 'cli', providerId: 'codex' });
    expect(prompt).toContain('Step one.');
    expect(vi.mocked(writeResolvedSlashdoBody)).not.toHaveBeenCalled();
  });

  it('inlines for an api provider regardless of size — no file tools to read with', async () => {
    vi.mocked(buildPrompt).mockClear();
    await buildAgentPrompt(slashdoTask(), {}, '/r', null, isTruthyMeta,
      { providerType: 'api', providerId: 'some-http-provider' });
    const [, context] = vi.mocked(buildPrompt).mock.calls.at(-1);
    expect(context.task.description).toContain(OVER);
    expect(vi.mocked(writeResolvedSlashdoBody)).not.toHaveBeenCalled();
  });

  it('warns once, naming the command and size, when an api provider is handed an over-budget body', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await buildAgentPrompt(slashdoTask(), {}, '/r', null, isTruthyMeta,
      { providerType: 'api', providerId: 'some-http-provider' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('review');
    expect(warn.mock.calls[0][0]).toMatch(/\d+KB/);
    warn.mockRestore();
  });

  it('falls back to inlining when the resolved copy cannot be staged', async () => {
    vi.mocked(writeResolvedSlashdoBody).mockRejectedValue(new Error('EACCES'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prompt = await buildAgentPrompt(
      slashdoTask(), {}, '/r', null, isTruthyMeta,
      { providerType: 'cli', providerId: 'codex' });
    // A failed write must not silently drop the procedure.
    expect(prompt).toContain(OVER);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // A pinned reviewer list carries the effort as slashdo's own `~effort=<level>`
  // suffix, so the section states it ONCE — on the pin. The prose instruction is
  // for the unpinned case, where the workflow resolves reviewers itself.
  it('carries a pinned reviewer effort on the --review-with token, not as prose', async () => {
    const prompt = await buildAgentPrompt(
      slashdoTask({ reviewers: ['codex'], reviewerEfforts: { codex: 'high' } }),
      {}, '/r', null, isTruthyMeta,
      { providerType: 'cli', providerId: 'codex' });
    expect(prompt).toContain('codex~effort=high');
    // Restating it would have the agent pass `-c model_reasoning_effort=high` a
    // second time, on top of the one slashdo's loop already passes.
    expect(prompt).not.toContain('Invoke each reviewer CLI at its pinned reasoning effort');
  });

  it('states the effort in prose when the section pins no reviewer list', async () => {
    // Reviewers spanning every loop variant prune nothing, so no `--review-with`
    // is emitted — the pin's only route to the CLI the workflow spawns is prose.
    const prompt = await buildAgentPrompt(
      slashdoTask({
        reviewers: ['copilot', 'codex', 'ollama'],
        usernames: ['octocat'],
        reviewerEfforts: { codex: 'high' },
      }),
      {}, '/r', null, isTruthyMeta,
      { providerType: 'cli', providerId: 'codex' });
    // (the note's own prose mentions the flag — assert on the pin line instead)
    expect(prompt).not.toContain('Run this workflow with');
    expect(prompt).toContain('`codex -c model_reasoning_effort=high`');
  });

  it('names only the reviewers this run actually resolved', async () => {
    // A stale pin for a reviewer that isn't in the list (set on another task, or
    // left behind by the Code Review Defaults) must not tell the agent to pass a
    // flag to a CLI it never invokes.
    const prompt = await buildAgentPrompt(
      slashdoTask({ reviewers: ['codex'], reviewerEfforts: { codex: 'high', claude: 'xhigh' } }),
      {}, '/r', null, isTruthyMeta,
      { providerType: 'cli', providerId: 'codex' });
    expect(prompt).toContain('codex~effort=high');
    expect(prompt).not.toContain('claude~effort=xhigh');
    expect(prompt).not.toContain('--effort xhigh');
  });

  it('adds no effort sentence when no reviewer pins one', async () => {
    const prompt = await buildAgentPrompt(
      slashdoTask({ reviewers: ['codex'] }), {}, '/r', null, isTruthyMeta,
      { providerType: 'cli', providerId: 'codex' });
    expect(prompt).not.toContain('pinned reasoning effort');
  });
  describe('reviewer-variant pruning', () => {
    const skipArg = () => vi.mocked(loadSlashdoFile).mock.calls.at(-1)[1].skipIncludes;

    it('prunes unreachable reviewer loops when the task pins its reviewers', async () => {
      await buildAgentPrompt(
        slashdoTask({ reviewers: ['codex'] }), {}, '/r', null, isTruthyMeta,
        { providerType: 'cli', providerId: 'codex' });
      const skipped = skipArg();
      expect(skipped).toContain('copilot-review-loop');
      expect(skipped).not.toContain('local-agent-review-loop');
    });

    it('pins --review-with alongside a pruned body so the run matches what it got', async () => {
      const prompt = await buildAgentPrompt(
        slashdoTask({ reviewers: ['codex'] }), {}, '/r', null, isTruthyMeta,
        { providerType: 'cli', providerId: 'codex' });
      expect(prompt).toContain('--review-with codex');
    });

    it('prunes from the install Code Review Defaults when the task pins nothing', async () => {
      vi.mocked(getCodeReviewDefaults).mockResolvedValue({ reviewers: ['ollama'] });
      await buildAgentPrompt(
        slashdoTask(), {}, '/r', null, isTruthyMeta,
        { providerType: 'cli', providerId: 'codex' });
      expect(skipArg()).not.toContain('ollama-review-loop');
    });

    it('prunes NOTHING on an unconfigured install (a lone copilot default is the unset shape)', async () => {
      // pickCodeReviewDefaults collapses "nothing configured" to ['copilot'], so a
      // lone copilot can't authorize pruning — and pinning --review-with copilot on
      // an install without Copilot review is the #2507 stall.
      vi.mocked(getCodeReviewDefaults).mockResolvedValue({ reviewers: ['copilot'] });
      const prompt = await buildAgentPrompt(
        slashdoTask(), {}, '/r', null, isTruthyMeta,
        { providerType: 'cli', providerId: 'codex' });
      expect(skipArg()).toEqual([]);
      expect(prompt).not.toContain('--review-with');
    });

    // Both regressions found by the codex review pass: hand-rolling the reviewer
    // resolution here diverged from the three helpers the rest of the prompt uses,
    // so the body was pruned for a different reviewer than the run resolves.
    it('honors the legacy single `reviewer` string, not just the reviewers array', async () => {
      vi.mocked(getCodeReviewDefaults).mockResolvedValue({ reviewers: ['ollama'] });
      const prompt = await buildAgentPrompt(
        slashdoTask({ reviewer: 'codex' }), {}, '/r', null, isTruthyMeta,
        { providerType: 'cli', providerId: 'codex' });
      // Legacy `reviewer` beats the defaults, so the CLI loop is kept and the
      // local-model loop (the default's) is what gets dropped.
      const skipped = skipArg();
      expect(skipped).not.toContain('local-agent-review-loop');
      expect(skipped).toContain('ollama-review-loop');
      expect(prompt).toContain('--review-with codex');
    });

    it('carries the ~opt marker for an optional reviewer inherited from the defaults', async () => {
      vi.mocked(getCodeReviewDefaults).mockResolvedValue({
        reviewers: ['codex'], optionalReviewers: ['codex'],
      });
      const prompt = await buildAgentPrompt(
        slashdoTask(), {}, '/r', null, isTruthyMeta,
        { providerType: 'cli', providerId: 'codex' });
      // Pinning a non-blocking reviewer as blocking changes the merge gate.
      expect(prompt).toContain('--review-with codex~opt');
    });

    it('treats an explicitly-OPTIONAL lone copilot as configured and keeps its ~opt', async () => {
      // Nothing defaults to `~opt`, so marking copilot optional is a deliberate
      // "review but don't gate the merge" choice. Suppressing the pin here would
      // let the run fall back to slashdo's saved BLOCKING copilot default —
      // silently tightening the merge gate. buildReviewWithArgs makes the same
      // exemption to its lone-default suppression.
      vi.mocked(getCodeReviewDefaults).mockResolvedValue({
        reviewers: ['copilot'], optionalReviewers: ['copilot'],
      });
      const prompt = await buildAgentPrompt(
        slashdoTask(), {}, '/r', null, isTruthyMeta,
        { providerType: 'cli', providerId: 'codex' });
      expect(prompt).toContain('--review-with copilot~opt');
      expect(skipArg()).not.toContain('copilot-review-loop');
    });

    it('prunes NOTHING when the defaults read fails', async () => {
      vi.mocked(getCodeReviewDefaults).mockRejectedValue(new Error('unreadable'));
      await buildAgentPrompt(
        slashdoTask(), {}, '/r', null, isTruthyMeta,
        { providerType: 'cli', providerId: 'codex' });
      expect(skipArg()).toEqual([]);
    });

    it('keeps the @login loop when a username reviewer gates the PR', async () => {
      await buildAgentPrompt(
        slashdoTask({ reviewers: ['codex'], usernames: ['octocat'] }), {}, '/r', null, isTruthyMeta,
        { providerType: 'cli', providerId: 'codex' });
      const skipped = skipArg();
      expect(skipped).not.toContain('github-reviewer-loop');
      // Two review sources ⇒ the multi-reviewer wrapper is reachable.
      expect(skipped).not.toContain('multi-reviewer-loop');
    });

    it('keys the staged file on the prune set so two reviewer sets do not share a copy', async () => {
      await buildAgentPrompt(
        slashdoTask({ reviewers: ['codex'] }), {}, '/r', null, isTruthyMeta,
        { providerType: 'cli', providerId: 'codex' });
      const [, , opts] = vi.mocked(writeResolvedSlashdoBody).mock.calls.at(-1);
      expect(opts.skipIncludes).toContain('copilot-review-loop');
    });
  });
});

describe('getAppWorkspace — tilde expansion (#3180)', () => {
  // Callers do more than spawn into this: agentLifecycle persists it as an
  // agent's sourceWorkspace, and worktree cleanup/merge later hand that value
  // to a child process as cwd. Node never shell-expands `~`, so a raw tilde
  // here lets a task start (the spawn path expands) and then strands its
  // worktree and branch when cleanup runs against a path that doesn't exist.
  it('returns an expanded path so worktree cleanup can use it as a cwd', async () => {
    const { homedir } = await import('os');
    const { join } = await import('path');
    const { readJSONFile } = await import('../lib/fileUtils.js');

    readJSONFile.mockResolvedValueOnce({
      apps: { 'tilde-app': { name: 'Tilde App', repoPath: '~/some-repo' } },
    });

    const resolved = await getAppWorkspace('tilde-app');
    expect(resolved).toBe(join(homedir(), 'some-repo'));
    expect(resolved.startsWith('~')).toBe(false);
  });

  it('leaves an already-absolute repoPath untouched', async () => {
    const { readJSONFile } = await import('../lib/fileUtils.js');
    readJSONFile.mockResolvedValueOnce({
      apps: { 'abs-app': { name: 'Abs App', repoPath: '/srv/repos/abs-app' } },
    });
    expect(await getAppWorkspace('abs-app')).toBe('/srv/repos/abs-app');
  });
});

// #3866 — getClaudeMdContext used to splice only the global + workspace-root
// CLAUDE.md, so a subtree rule (including a data-loss guard) never reached an
// API-provider agent. These pin the nested walk and its bounds.
describe('getClaudeMdContext — nested CLAUDE.md discovery (#3866)', () => {
  let workspace;

  const writeClaudeMd = (relDir, body) => {
    const dir = relDir ? join(workspace, relDir) : workspace;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'CLAUDE.md'), body);
  };

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'portos-nested-claudemd-'));
    writeClaudeMd('', '# Root rules\nAnchor every backup exclude.');
    writeClaudeMd('server', '# Server rules\nSchema parity when adding fields.');
    writeClaudeMd('client/src/components/dashboard', '# Dashboard rules\nRegister the widget.');
    // Ignored trees: each carries a CLAUDE.md that must NOT be spliced.
    writeClaudeMd('node_modules/some-dep', '# Vendored dep rules');
    writeClaudeMd('data/cos/worktrees/claim-issue-1', '# Runtime worktree rules');
    // Submodule / vendored checkout — recognized by its own `.git`, not by path.
    writeClaudeMd('lib/slashdo', '# Submodule rules');
    writeFileSync(join(workspace, 'lib/slashdo/.git'), 'gitdir: ../../.git/modules/slashdo\n');
    writeClaudeMd('.hidden', '# Dot dir rules');
    // Past the depth cap (depth 6): a/b/c/d/e/f/CLAUDE.md.
    writeClaudeMd('a/b/c/d/e/f', '# Too deep rules');
  });

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('splices nested files after the root one, each labeled with its repo-relative path', async () => {
    const section = await getClaudeMdContext(workspace);

    expect(section).toContain('### Project Instructions\n');
    expect(section).toContain('Anchor every backup exclude.');
    // The whole point of the issue: subtree content reaches the prompt.
    expect(section).toContain('### Project Instructions (server/CLAUDE.md)');
    expect(section).toContain('Schema parity when adding fields.');
    expect(section).toContain('### Project Instructions (client/src/components/dashboard/CLAUDE.md)');
    expect(section).toContain('Register the widget.');

    // Root stays first so precedence still reads root-then-specific, and the
    // nested pair is ordered lexicographically by path (client before server)
    // so prompt caching stays stable across builds.
    const rootAt = section.indexOf('Anchor every backup exclude.');
    const dashboardAt = section.indexOf('Register the widget.');
    const serverAt = section.indexOf('Schema parity when adding fields.');
    expect(rootAt).toBeLessThan(dashboardAt);
    expect(dashboardAt).toBeLessThan(serverAt);
  });

  it('skips vendored, runtime, submodule, dot, and over-depth trees', async () => {
    const section = await getClaudeMdContext(workspace);

    expect(section).not.toContain('Vendored dep rules');
    expect(section).not.toContain('Runtime worktree rules');
    expect(section).not.toContain('Submodule rules');
    expect(section).not.toContain('Dot dir rules');
    expect(section).not.toContain('Too deep rules');
  });

  it('recognizes a submodule by its own .git, not by a hardcoded path', async () => {
    // `lib/slashdo` above is skipped only because it carries a `.git`. A sibling
    // under the same parent, with no `.git`, must still be spliced — otherwise
    // the skip is really matching `lib/` and the structural check is vacuous.
    writeClaudeMd('lib/inhouse', '# In-house lib rules');
    const section = await getClaudeMdContext(workspace);
    expect(section).toContain('### Project Instructions (lib/inhouse/CLAUDE.md)');
    expect(section).toContain('In-house lib rules');
    expect(section).not.toContain('Submodule rules');
    rmSync(join(workspace, 'lib/inhouse'), { recursive: true, force: true });
  });

  it('caps the number of nested files spliced', async () => {
    const capped = mkdtempSync(join(tmpdir(), 'portos-nested-claudemd-cap-'));
    mkdirSync(capped, { recursive: true });
    writeFileSync(join(capped, 'CLAUDE.md'), '# Root of capped workspace');
    // 12 nested files > the 10-file cap. Zero-padded so lexicographic order
    // matches numeric order and the assertions below are unambiguous.
    for (let i = 1; i <= 12; i++) {
      const dir = join(capped, `pkg-${String(i).padStart(2, '0')}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'CLAUDE.md'), `# Nested rule ${String(i).padStart(2, '0')}`);
    }

    const section = await getClaudeMdContext(capped);
    const spliced = section.match(/### Project Instructions \(/g) || [];
    expect(spliced).toHaveLength(10);
    // Non-vacuous: the survivors are the first 10 by path, and the overflow is
    // dropped rather than truncated mid-file.
    expect(section).toContain('# Nested rule 10');
    expect(section).not.toContain('# Nested rule 11');
    expect(section).not.toContain('# Nested rule 12');

    rmSync(capped, { recursive: true, force: true });
  });

  it('returns null for a workspace with no CLAUDE.md at any level', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'portos-nested-claudemd-empty-'));
    mkdirSync(join(empty, 'sub'), { recursive: true });
    expect(await getClaudeMdContext(empty)).toBeNull();
    rmSync(empty, { recursive: true, force: true });
  });
});

describe('TUI reviewLoopFollowUp completion instructions', () => {
  it('appends .agent-done sentinel instructions for TUI agents on follow-up tasks', async () => {
    const task = {
      id: 'task-flw-1',
      description: 'Follow-up merge PR',
      metadata: {
        useWorktree: true,
        openPR: false,
        reviewLoopFollowUp: true,
        reviewLoopMergeOnly: true,
        reviewLoopPRUrl: 'https://github.com/org/repo/pull/42',
        reviewLoopPRBranch: 'cos/task-orig/agent-1',
        providerId: 'antigravity-tui',
        providerCommand: 'agy',
      }
    };
    const worktreeInfo = { worktreePath: '/tmp/wt-1', branchName: 'cos/task-orig/agent-1' };
    const prompt = await buildLightContextPrompt(task, '/repo', worktreeInfo, (v) => v === true || v === 'true', {
      isTui: true,
      providerId: 'antigravity-tui',
      providerCommand: 'agy',
    });
    expect(prompt).toContain('## Completion Handoff');
    expect(prompt).toContain('cat > "/tmp/wt-1/.agent-done"');
    expect(prompt).toContain('## Summary');
  });

  // Agents that never take a worktree (issue-filing / reasoning task types run
  // with `useWorktree: false`) all write into the SAME primary checkout. A shared
  // `.agent-done` there lets two concurrent runs overwrite each other's summary,
  // and lets whichever poll ticks first finalize the other agent's run on a
  // sentinel it never wrote — so the filename carries the agent id.
  it('names the completion sentinel per agent instance so worktree-less runs cannot collide', async () => {
    const worktreelessTask = (id) => ({
      id,
      description: 'File an issue',
      metadata: { useWorktree: false, openPR: false, discardWorktree: true, providerId: 'claude-code-tui', providerCommand: 'claude' }
    });
    const build = (taskId, agentId) => buildLightContextPrompt(
      worktreelessTask(taskId), '/repo', null, (v) => v === true || v === 'true',
      { isTui: true, providerId: 'claude-code-tui', providerCommand: 'claude', agentId }
    );

    const first = await build('task-a', 'agent-aaa111');
    const second = await build('task-b', 'agent-bbb222');

    expect(first).toContain('/repo/.agent-done-agent-aaa111');
    expect(second).toContain('/repo/.agent-done-agent-bbb222');
    expect(first).not.toContain('/repo/.agent-done-agent-bbb222');
    // No instruction may still point at the shared filename.
    expect(first).not.toMatch(/\.agent-done(?![-\w])/);
  });
});
