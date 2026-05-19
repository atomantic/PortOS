/**
 * Agent Prompt Builder
 *
 * Builds the full agent prompt including memory context, CLAUDE.md instructions,
 * digital twin, worktree/pipeline/JIRA sections, skill templates, and tools summary.
 * Also handles JIRA ticket creation and app workspace resolution.
 */

import { join } from 'path';
import { stat } from 'fs/promises';
import { homedir } from 'os';
import { getMemorySection } from './memoryRetriever.js';
import { getDigitalTwinForPrompt } from './digital-twin.js';
import { buildPrompt } from './promptService.js';
import { getToolsSummaryForPrompt } from './tools.js';
import { getActiveProvider } from './providers.js';
import { runPromptThroughProvider } from '../lib/promptRunner.js';
import { readJSONFile, loadSlashdoFile, PATHS, tryReadFile } from '../lib/fileUtils.js';
import * as jiraService from './jira.js';
import { emitLog } from './cosEvents.js';

const ROOT_DIR = PATHS.root;
const AGENTS_DIR = PATHS.cosAgents;
const SKILLS_DIR = join(ROOT_DIR, 'data/prompts/skills');

/**
 * Skill template keyword matchers.
 * Each entry maps a skill template filename to its trigger keywords.
 * Order matters — first match wins, so more specific patterns come first.
 */
const SKILL_MATCHERS = [
  {
    skill: 'security-audit',
    keywords: ['security', 'audit', 'vulnerability', 'xss', 'injection', 'owasp', 'cve', 'penetration', 'hardening', 'sanitize', 'authorization']
  },
  {
    skill: 'mobile-responsive',
    keywords: ['mobile', 'responsive', 'tablet', 'breakpoint', 'viewport', 'touch', 'swipe', 'small screen', 'media query', 'mobile-friendly', 'adaptive']
  },
  {
    skill: 'bug-fix',
    keywords: ['fix', 'bug', 'broken', 'error', 'crash', 'issue', 'not working', 'fails', 'regression', 'defect']
  },
  {
    skill: 'refactor',
    keywords: ['refactor', 'reorganize', 'restructure', 'clean up', 'simplify', 'extract', 'consolidate', 'decouple', 'modularize']
  },
  {
    skill: 'documentation',
    keywords: ['document', 'documentation', 'docs', 'readme', 'jsdoc', 'api docs', 'guide', 'tutorial', 'changelog']
  },
  {
    skill: 'feature',
    keywords: ['add', 'create', 'implement', 'build', 'new', 'feature', 'support', 'enable', 'integrate', 'endpoint', 'page', 'component']
  }
];

/**
 * Detect the best matching skill template for a task based on description keywords.
 * @param {Object} task - Task object with description
 * @returns {string|null} Skill template name or null if no match
 */
export function detectSkillTemplate(task) {
  const desc = (task?.description || '').toLowerCase();
  for (const matcher of SKILL_MATCHERS) {
    if (matcher.keywords.some(kw => desc.includes(kw))) {
      return matcher.skill;
    }
  }
  return null;
}

/**
 * Load a skill template from disk if it exists.
 * @param {string} skillName - Name of the skill template file (without .md)
 * @returns {Promise<string|null>} Template content or null
 */
export async function loadSkillTemplate(skillName) {
  const content = await tryReadFile(join(SKILLS_DIR, `${skillName}.md`));
  if (content) console.log(`🎯 Loaded skill template: ${skillName}`);
  return content;
}

/**
 * Read CLAUDE.md files for agent context.
 * Reads both global (~/.claude/CLAUDE.md) and project-specific (./CLAUDE.md).
 */
export async function getClaudeMdContext(workspaceDir) {
  const contexts = [];

  // Try to read global CLAUDE.md from ~/.claude/CLAUDE.md
  const globalPath = join(homedir(), '.claude', 'CLAUDE.md');
  const globalContent = await tryReadFile(globalPath);
  if (globalContent?.trim()) {
    contexts.push({ type: 'Global Instructions', path: globalPath, content: globalContent.trim() });
  }

  // Try to read project-specific CLAUDE.md from workspace directory
  const projectPath = join(workspaceDir, 'CLAUDE.md');
  const projectContent = await tryReadFile(projectPath);
  if (projectContent?.trim()) {
    contexts.push({ type: 'Project Instructions', path: projectPath, content: projectContent.trim() });
  }

  if (contexts.length === 0) {
    return null;
  }

  let section = '## CLAUDE.md Instructions\n\n';
  section += 'The following instructions must be followed when working on this task:\n\n';

  for (const ctx of contexts) {
    section += `### ${ctx.type}\n`;
    section += `Source: \`${ctx.path}\`\n\n`;
    section += ctx.content + '\n\n';
  }

  return section;
}

/**
 * Build a compaction instruction section for retries after context-limit failures.
 * Provides explicit guidance to the agent on reducing output verbosity.
 */
export function buildCompactionSection(task) {
  const compaction = task.metadata?.compaction;
  if (!compaction?.needed) return '';

  const hints = compaction.retryHints || [];
  const reason = compaction.reason === 'output-limit' ? 'output length limit' : 'context window limit';
  const prevOutputKB = compaction.outputSize ? Math.round(compaction.outputSize / 1024) : 'unknown';

  return `
## Context Compaction Required

**WARNING**: A previous attempt at this task failed because the agent exceeded the ${reason}.
Previous output size: ~${prevOutputKB} KB. You MUST keep your output compact to avoid the same failure.

**Mandatory output constraints**:
${hints.map(h => `- ${h}`).join('\n')}
- Do NOT reproduce entire file contents in your output
- Reference files by path and line number instead of quoting them
- Limit exploratory reads — plan your approach first, then make targeted changes
`;
}

/**
 * Provider types that get the **light** prompt: agentic CLIs with native
 * filesystem tools and CLAUDE.md loading (Claude Code, Codex, Gemini —
 * whether running interactively as `tui` or one-shot as `cli`). Everything
 * else (`api`: LM Studio, raw OpenAI/Anthropic) needs the full pasted-in
 * context because it has no native filesystem access.
 */
const LIGHT_CONTEXT_PROVIDER_TYPES = new Set(['tui', 'cli']);

/**
 * Build the shared task block — the description plus optional `**Target App**`
 * and `**Screenshots**` fields. Used by BOTH the light and full prompt paths
 * so a new task-metadata field gets surfaced in both without drift.
 *
 * Returns three pre-rendered slots (`description`, `targetApp`, `screenshots`).
 * Absent fields come back as empty strings so the full path's template literal
 * can interpolate them in fixed positions and preserve byte-identical line
 * spacing. The light path filters out the empty strings and joins what remains.
 *
 * @param {Object} task
 * @param {Object} [opts]
 * @param {boolean} [opts.screenshotsAsList=false] - When true, render screenshots
 *   as a `### Screenshots` header followed by a bulleted list of paths (light
 *   path style). When false, render as a single inline `**Screenshots**: a, b`
 *   line (full path style).
 * @returns {{ description: string, targetApp: string, screenshots: string }}
 */
export function buildTaskBlock(task, { screenshotsAsList = false } = {}) {
  const description = task.description;
  const targetApp = task.metadata?.app ? `**Target App**: ${task.metadata.app}` : '';
  const shots = task.metadata?.screenshots;
  let screenshots = '';
  if (Array.isArray(shots) && shots.length > 0) {
    screenshots = screenshotsAsList
      ? '### Screenshots\nUse your filesystem tools to inspect each path:\n' +
        shots.map(s => `- \`${s}\``).join('\n')
      : `**Screenshots**: ${shots.join(', ')}`;
  }
  return { description, targetApp, screenshots };
}

/**
 * Build the **review-loop follow-up** section — the instructions for the
 * agent spawned by `spawnReviewLoopFollowUp` to drive Copilot's review-and-fix
 * loop until the PR merges. Same 7-step procedure, same merge command, same
 * MERGED-state verification, same 10-iteration cap in BOTH the light and full
 * paths — extracted so the two can't drift independently.
 *
 * I/O (the slashdo `/do:rpr` body) is intentionally pulled outside this helper
 * and threaded in via `rprBody` so the function stays pure and synchronous.
 *
 * @param {Object} metadata - task.metadata (reviewLoopPR* fields, sourceTaskId)
 * @param {Object} [opts]
 * @param {boolean} [opts.verbose=false] - When true, emit the verbose prose
 *   variant the full (api) path uses, with PR Details list and an inlined
 *   `/do:rpr` reference. When false, emit the compact list the light path uses.
 * @param {string|null} [opts.rprBody=null] - The loaded `/do:rpr` slashdo body.
 *   Only appended in verbose mode; ignored in compact mode.
 * @returns {string}
 */
export function buildReviewLoopFollowUpSection(metadata = {}, { verbose = false, rprBody = null } = {}) {
  const prUrl = metadata.reviewLoopPRUrl || '';
  const prBranch = metadata.reviewLoopPRBranch || '';
  const prNumber = metadata.reviewLoopPRNumber ?? '';
  const prOwner = metadata.reviewLoopPROwner ?? '';
  const prRepo = metadata.reviewLoopPRRepo ?? '';
  const sourceTaskId = metadata.sourceTaskId || 'unknown';

  if (verbose) {
    return `
## Review-Loop Follow-up (PRIMARY OBJECTIVE)
A previous agent finished implementing the work for source task **${sourceTaskId}** and opened **PR ${prUrl}** on branch \`${prBranch}\`. The system has already requested an initial Copilot code review. **Your job is to drive the review-and-fix loop to completion and merge the PR.**

**Run this loop UNTIL the PR has zero unresolved Copilot comments OR you hit the iteration cap of 10:**

1. Wait for the latest Copilot review to complete (poll every 5–15s, max 5 minutes per round).
2. If there are unresolved review threads, fix them in this worktree, run the project's tests, commit (\`feat:\`/\`fix:\` prefix, no Co-Authored-By), push, and resolve the addressed threads.
3. Re-request a Copilot review.
4. Repeat from step 1.
5. When Copilot returns "0 comments" / no unresolved threads, merge the PR **immediately** with this exact command (flags: \`--squash --delete-branch\`, nothing else):
   \`\`\`bash
   gh pr merge "${prUrl}" --squash --delete-branch
   \`\`\`
   ${prOwner && prRepo && prNumber ? `(Equivalent: \`gh pr merge ${prNumber} --repo ${prOwner}/${prRepo} --squash --delete-branch\`.)` : ''}
   You have already verified the review is clean, so force the immediate merge. Adding any merge-deferral flag would leave the PR open after you exit.
6. Confirm the PR is actually merged before exiting: \`gh pr view "${prUrl}" --json state -q .state\` must return \`MERGED\`. If it returns \`OPEN\` or \`CLOSED\`, investigate (a check is failing, a thread is still unresolved, or branch protection is blocking) — fix and retry the merge. Do NOT exit until state is \`MERGED\`.
7. Exit. Do **not** run \`/do:push\` or open a new PR — the merge handles everything. The system will clean up your worktree on exit.

**Hard stop:** if the loop hasn't converged after 10 iterations, post a PR comment summarising the unresolved blockers and exit. Do not loop indefinitely.

**Repeated comments:** If a new Copilot round only re-raises feedback you intentionally rejected (with a reply explaining why), treat that round as clean and move on to merge.

PR Details:
- **URL**: ${prUrl}
- **Branch**: \`${prBranch}\`
${prNumber !== '' ? `- **Number**: ${prNumber}` : ''}
${prOwner && prRepo ? `- **Repo**: ${prOwner}/${prRepo}` : ''}
- **Source task**: ${sourceTaskId}
${rprBody ? `\n### /do:rpr Reference (full procedure)\n\n${rprBody}\n` : ''}`;
  }

  // Compact light-path variant.
  return [
    '## Review-Loop Follow-up (PRIMARY OBJECTIVE)',
    `A previous agent finished task **${sourceTaskId}** and opened **PR ${prUrl}** on \`${prBranch}\`. The system has requested an initial Copilot review. Drive the review-and-fix loop to completion and merge.`,
    '',
    '**Loop UNTIL zero unresolved Copilot comments OR 10 iterations:**',
    '1. Wait for the latest Copilot review (poll 5–15s, max 5 min per round).',
    '2. If unresolved threads: fix in this worktree, run tests, commit (`feat:`/`fix:` prefix, no Co-Authored-By), push, resolve threads.',
    '3. Re-request a Copilot review.',
    '4. Repeat.',
    '5. When clean, merge **immediately** with this exact command (flags: `--squash --delete-branch`, nothing else):',
    '   ```bash',
    `   gh pr merge "${prUrl}" --squash --delete-branch`,
    '   ```',
    prOwner && prRepo && prNumber ? `   (Equivalent: \`gh pr merge ${prNumber} --repo ${prOwner}/${prRepo} --squash --delete-branch\`.)` : null,
    '   You have already verified the review is clean, so force the immediate merge. Adding any merge-deferral flag would leave the PR open after you exit.',
    `6. Confirm the merge happened before exiting: \`gh pr view "${prUrl}" --json state -q .state\` must return \`MERGED\`. If it returns \`OPEN\` or \`CLOSED\`, investigate (failing check, unresolved thread, branch protection) — fix and retry. Do NOT exit until state is \`MERGED\`.`,
    '7. Exit — do NOT run `/do:push` or open a new PR.',
    '',
    '**Hard stop:** if not converged after 10 rounds, post a PR comment summarising blockers and exit.',
    '**Repeated comments:** if a round only re-raises feedback you intentionally rejected (with a reply explaining why), treat as clean and merge.'
  ].filter(Boolean).join('\n');
}

/**
 * Build the single "## Guidelines" completion-handoff bullet for the full
 * (api) prompt path. Mirrors the helper pattern the light path already uses
 * (`worktreeCommitGuidance`, `buildTuiCompletionSection`) — same 4-branch
 * decision tree (read-only / TUI / worktree+PR / worktree-only / default) but
 * flattened into a function so reading is linear instead of a nested ternary.
 *
 * Returns the bullet body WITHOUT the leading `- ` marker (caller prepends),
 * or `null` when the branch produces no text (the legacy empty-string tail).
 *
 * @param {Object} opts
 * @param {boolean} opts.isReadOnly
 * @param {boolean} opts.isTui
 * @param {string} opts.tuiCompletionCommand - `/do:pr` or `/do:push`
 * @param {Object|null} opts.worktreeInfo
 * @param {boolean} opts.willOpenPR
 * @param {boolean} opts.willReviewLoop
 * @returns {string|null}
 */
export function buildCompletionGuidelineBullet({
  isReadOnly, isTui, tuiCompletionCommand,
  worktreeInfo, willOpenPR, willReviewLoop,
}) {
  if (isReadOnly) {
    return '**This is a read-only task.** Do NOT commit, push, or modify any files in the repository. Only read data and generate reports.';
  }
  if (isTui) {
    return `On successful completion, YOU run the Completion Workflow above (\`${tuiCompletionCommand}\`, write the sentinel, \`/quit\`).`;
  }
  if (worktreeInfo && willOpenPR) {
    const reviewSuffix = willReviewLoop
      ? ' For GitHub PRs, a Copilot code review will also be requested automatically (skipped on GitLab and other non-GitHub forges) — do NOT run `/do:rpr` or attempt to address review comments yourself; you will have already exited.'
      : '';
    return `On successful completion, the system will push your branch and open a pull request — do NOT open a PR manually. (If the task fails, no PR is opened; the worktree is then cleaned up unless a safety check preserves it for manual recovery.)${reviewSuffix}`;
  }
  if (worktreeInfo) {
    return 'Your worktree branch will be automatically merged back to the source branch when your task completes — do NOT open a PR.';
  }
  return null;
}

/**
 * Build the agent prompt.
 *
 * Two context modes, selected by `options.providerType`:
 *
 * - **Light** (`tui` / `cli`): minimal prompt — task description, attached
 *   context, screenshot paths, worktree/jira/pipeline coordinates, and the
 *   completion-workflow contract. Memory, CLAUDE.md, digital twin, tools
 *   summary, planning context, skill templates, and compaction warnings are
 *   deliberately omitted because the agent can fetch them itself.
 * - **Full** (`api`): kitchen-sink prompt with memory + CLAUDE.md + digital
 *   twin + tools + skills + planning + git hygiene. The leading
 *   "# Chief of Staff Agent Briefing" header is dropped from both modes.
 *
 * @param {Object} task - Task object
 * @param {Object} config - CoS configuration
 * @param {string} workspaceDir - Working directory (may be a worktree)
 * @param {Object|null} worktreeInfo - Worktree details if using a worktree
 * @param {Function} isTruthyMetaFn - isTruthyMeta function (passed to avoid circular dep)
 * @param {Object} options
 * @param {string} [options.providerType='api'] - `'tui' | 'cli' | 'api'`
 * @param {string} [options.providerId] - Provider id (e.g. `'claude-code'`). When the
 *   CLI provider has access to the project's slashdo commands (Claude Code), the
 *   light prompt instructs the agent to run `/simplify` and `/do:pr` itself
 *   instead of relying on PortOS's post-exit push+PR. The spawner must then
 *   pass `openPR: false` to `cleanupAgentWorktree` to avoid double-firing.
 */
export async function buildAgentPrompt(task, config, workspaceDir, worktreeInfo = null, isTruthyMetaFn = (v) => v === true || v === 'true', options = {}) {
  const providerType = options.providerType || 'api';
  const providerId = options.providerId || null;
  const isTui = providerType === 'tui';

  if (LIGHT_CONTEXT_PROVIDER_TYPES.has(providerType)) {
    return buildLightContextPrompt(task, workspaceDir, worktreeInfo, isTruthyMetaFn, { isTui, providerId });
  }

  // Full path: API providers don't read CLAUDE.md natively, so always include it.
  const skipClaudeMd = false;
  // Fetch independent context sections in parallel
  const [memorySection, claudeMdSection, digitalTwinSection] = await Promise.all([
    getMemorySection(task, { maxTokens: config.memory?.maxContextTokens || 2000 })
      .catch(err => { console.log(`⚠️ Memory retrieval failed: ${err.message}`); return null; }),
    skipClaudeMd
      ? Promise.resolve(null)
      : getClaudeMdContext(workspaceDir)
          .catch(err => { console.log(`⚠️ CLAUDE.md retrieval failed: ${err.message}`); return null; }),
    getDigitalTwinForPrompt({ maxTokens: config.digitalTwin?.maxContextTokens || config.soul?.maxContextTokens || 2000 })
      .catch(err => { console.log(`⚠️ Digital twin context retrieval failed: ${err.message}`); return null; })
  ]);

  // Build context compaction section if task is retrying after a context-limit failure
  const compactionSection = task.metadata?.compaction?.needed ? buildCompactionSection(task) : '';

  // Build worktree context section if applicable
  const willOpenPR = isTruthyMetaFn(task.metadata?.openPR);
  const willReviewLoop = isTruthyMetaFn(task.metadata?.reviewLoop);
  const isWorktreeOnExistingBranch = worktreeInfo?.existingBranch === true;
  const worktreeSection = worktreeInfo ? `
## Git Worktree Context
You are working in an **isolated git worktree** to avoid conflicts with other agents working concurrently.
- **Branch**: \`${worktreeInfo.branchName}\`${isWorktreeOnExistingBranch ? ' *(pre-existing PR branch)*' : ''}
- **Worktree Path**: \`${worktreeInfo.worktreePath}\`
${worktreeInfo.baseBranch ? `- **Based on**: \`${worktreeInfo.baseBranch}\` (latest from origin)` : ''}

**Important**: ${isTui
    ? 'Commit your changes to this branch — see the **Completion Workflow** section below for the full push/PR/exit sequence.'
    : isWorktreeOnExistingBranch
      ? 'Commit and **push** any review-fix commits to this branch — the PR points at it, so pushed commits are how Copilot sees your fixes. Use `git pull --rebase` before pushing if needed.'
      : `Commit your changes to this branch.${willOpenPR ? ' When your task completes, the system will push this branch and open a pull request against the default branch — do NOT push or open a PR yourself.' : ' Your commits will be automatically merged back to the main development branch when your task completes.'}`} Do NOT manually switch branches or modify the worktree configuration.
` : '';

  // Build pipeline context section if this is a pipeline stage
  const pipelineCtx = task.metadata?.pipeline;
  const pipelineSection = pipelineCtx?.previousStageAgentId ? `
## Pipeline Context
This is stage ${pipelineCtx.currentStage + 1} of ${pipelineCtx.stages.length}: "${pipelineCtx.stages[pipelineCtx.currentStage]?.name}"
Previous stage: "${pipelineCtx.stages[pipelineCtx.currentStage - 1]?.name}"

Read the previous stage's output from:
\`${join(AGENTS_DIR, pipelineCtx.previousStageAgentId, 'output.txt')}\`

Use the findings from the previous stage to inform your work. If the previous stage produced a JSON results block, parse it to determine which items to process.
` : '';

  // Build simplify section if enabled. In the worktree-with-openPR flow the
  // system pushes and opens the PR after the agent exits, so the agent must
  // only commit (not push) — keep this wording aligned with the worktree
  // section above. TUI agents own the full simplify+push+PR sequence in the
  // Completion Workflow section below, so this section is suppressed for TUI.
  const simplifyEnabled = isTruthyMetaFn(task.metadata?.simplify);
  const simplifySection = simplifyEnabled && !isTui ? `
## Simplify Step
After completing your work and before committing, run \`/simplify\` to review the changed code for reuse, quality, and efficiency. Fix any issues found, then ${worktreeInfo && willOpenPR ? 'commit your changes (do NOT push — on a successful run the system will push and open the PR after you exit; if the run fails, no push or PR happens)' : 'commit and push using `/do:push`'}.
` : '';

  // TUI completion section — delegate to the shared light-path builder so
  // both prompt paths emit byte-identical workflows. (Background: TUI owns
  // its own `/simplify` → `/do:pr|/do:push` → sentinel → `/quit` sequence
  // because the slashdo submodule mounts those commands at project level —
  // see `buildTuiCompletionSection` below for the full contract.)
  const tuiCompletionCommand = willOpenPR ? '/do:pr' : '/do:push';
  const tuiCompletionSection = isTui
    ? buildTuiCompletionSection({
        willOpenPR, willReviewLoop, simplifyEnabled,
        sentinelPath: `${worktreeInfo?.worktreePath || workspaceDir}/.agent-done`
      })
    : '';

  // Build review loop section if enabled. The agent itself does NOT open the PR
  // or run /do:rpr — by the time the PR exists, the agent has already exited.
  // The system requests Copilot review automatically after PR creation on GitHub
  // PRs. On non-GitHub forges (e.g. GitLab MRs) this step is skipped because the
  // Copilot reviewer is GitHub-only. Only meaningful when a PR will actually be
  // created (willOpenPR), since the Copilot review request is a no-op without a
  // PR URL. Suppressed for TUI agents because TUI agents open the PR themselves
  // and the Completion Workflow above instructs them to request the Copilot
  // review inline — the system-side post-exit handler never fires for TUI.
  const reviewLoopSection = willReviewLoop && willOpenPR && !isTui ? `
## Code Review
After your task completes, the system will request a Copilot code review automatically for GitHub PRs (the step is skipped for GitLab MRs and other non-GitHub forges). The system will then spawn a follow-up agent that runs the full review-and-fix loop until Copilot returns zero comments and merges the PR. You do not need to open the PR, trigger the review, or address feedback yourself — focus on producing high-quality, well-tested code so the review pass goes cleanly.
` : '';

  // Build review-loop follow-up section. This is the agent that addresses Copilot's
  // feedback iteratively and merges the PR — spawned by the previous agent's cleanup
  // hook (see spawnReviewLoopFollowUp in agentLifecycle.js). It needs the full /do:rpr
  // procedure inlined because the agent runs in a one-shot session and won't trigger
  // a slash command itself.
  const isReviewLoopFollowUp = isTruthyMetaFn(task.metadata?.reviewLoopFollowUp);
  let reviewLoopFollowUpSection = '';
  if (isReviewLoopFollowUp) {
    const rprBody = await loadSlashdoFile('rpr').catch(() => null);
    reviewLoopFollowUpSection = buildReviewLoopFollowUpSection(task.metadata || {}, { verbose: true, rprBody });
  }

  // Build JIRA context section if applicable
  const jiraSection = task.metadata?.jiraTicketId ? `
## JIRA Integration
This task is tracked by JIRA ticket **${task.metadata.jiraTicketId}**.
- **Ticket URL**: ${task.metadata.jiraTicketUrl}
${task.metadata.jiraBranch ? `- **Branch**: \`${task.metadata.jiraBranch}\`` : ''}

Include the ticket ID (${task.metadata.jiraTicketId}) in your commit messages, e.g. \`${task.metadata.jiraTicketId}: description of change\`.
${task.metadata.jiraBranch ? 'Commit your changes to this branch. Do NOT switch branches.' : ''}
` : '';

  // Detect and load task-type-specific skill template (only when matched)
  const matchedSkill = detectSkillTemplate(task);
  const skillSection = matchedSkill
    ? await loadSkillTemplate(matchedSkill).catch(err => {
        console.log(`⚠️ Skill template load failed for ${matchedSkill}: ${err.message}`);
        return null;
      })
    : null;

  // Build onboard tools section for agent awareness
  const toolsSection = await getToolsSummaryForPrompt().catch(err => {
    console.log(`⚠️ Tools summary retrieval failed: ${err.message}`);
    return '';
  });

  // Build .planning/ context section for GSD-enabled apps
  let planningContextSection = '';
  if (task.metadata?.app) {
    const planningPath = join(workspaceDir, '.planning');
    const hasPlanningDir = await stat(planningPath).then(s => s.isDirectory()).catch(() => false);
    if (hasPlanningDir) {
      const planningParts = [];
      const [stateContent, concernsContent, roadmapContent] = await Promise.all([
        tryReadFile(join(planningPath, 'STATE.md')),
        tryReadFile(join(planningPath, 'CONCERNS.md')),
        tryReadFile(join(planningPath, 'ROADMAP.md'))
      ]);
      if (stateContent) planningParts.push(`### Current State\n\`\`\`\n${stateContent.slice(0, 1000)}\n\`\`\``);
      if (concernsContent) planningParts.push(`### Known Concerns\n\`\`\`\n${concernsContent.slice(0, 1500)}\n\`\`\``);
      if (roadmapContent) planningParts.push(`### Roadmap\n\`\`\`\n${roadmapContent.slice(0, 1000)}\n\`\`\``);
      if (planningParts.length > 0) {
        planningContextSection = `\n## Project Planning Context (.planning/)\nThis project has GSD planning documents. Use this context to understand priorities and known issues.\n\n${planningParts.join('\n\n')}\n`;
      }
    }
  }

  // Try to use the prompt template system. Skip the template path for
  // review-loop follow-up agents because the user-side template usually
  // predates the {{reviewLoopFollowUpSection}} placeholder; the built-in
  // fallback is the source of truth for that section, and silently dropping
  // it would leave the agent with no instructions and the loop would not run.
  const promptData = isReviewLoopFollowUp ? null : await buildPrompt('cos-agent-briefing', {
    task,
    config,
    memorySection,
    claudeMdSection,
    digitalTwinSection,
    worktreeSection,
    pipelineSection,
    jiraSection,
    simplifySection,
    tuiCompletionSection,
    reviewLoopSection,
    reviewLoopFollowUpSection,
    compactionSection,
    skillSection,
    planningContextSection,
    toolsSection,
    soulSection: digitalTwinSection, // Backwards compatibility for prompt templates
    timestamp: new Date().toISOString()
  }).catch(() => null);

  if (promptData?.prompt) {
    return promptData.prompt;
  }

  const taskBlock = buildTaskBlock(task, { screenshotsAsList: false });

  // Fallback to built-in template
  return `${claudeMdSection || ''}

${memorySection || ''}

${taskBlock.description}
${task.metadata?.context ? (task.metadata.context.includes('\n') ? `\n### Task Context\n\n${task.metadata.context.trimEnd()}\n` : `\n### Task Context\n\n${task.metadata.context}\n`) : ''}
${taskBlock.targetApp}
${taskBlock.screenshots}
${worktreeSection}
${pipelineSection}
${jiraSection}
${simplifySection}
${tuiCompletionSection}
${reviewLoopSection}
${reviewLoopFollowUpSection}
${compactionSection}
${skillSection ? `## Task-Type Skill Guidelines\n\n${skillSection}\n` : ''}${toolsSection ? `\n${toolsSection}\n` : ''}${planningContextSection}
## Instructions
1. Analyze the task requirements carefully
2. Make necessary changes to complete the task
3. Test your changes when possible
4. ${isTui
  ? `Commit, push, and ${willOpenPR ? 'open the PR (see Completion Workflow above)' : 'push the branch (see Completion Workflow above)'}`
  : worktreeInfo && willOpenPR
    ? 'Commit your changes (see Git Hygiene below) — do NOT push, the system handles that on exit'
    : 'Commit and push your changes (see Git Hygiene below)'}
5. Provide a summary of what was done

## Guidelines
- Focus only on the assigned task
- Make minimal, targeted changes
- Follow existing code patterns and conventions
- Do not make unrelated changes
- If blocked, explain clearly why
- Never update the PortOS changelog (\`.changelog/\`) for work on managed apps — the PortOS changelog tracks PortOS core changes only
${(() => {
  const bullet = buildCompletionGuidelineBullet({
    isReadOnly: isTruthyMetaFn(task.metadata?.readOnly),
    isTui, tuiCompletionCommand, worktreeInfo, willOpenPR, willReviewLoop,
  });
  return bullet ? `- ${bullet}` : '';
})()}

## Git Hygiene (CRITICAL)
- **Before starting work**, run \`git status\` to verify a clean working tree. Do NOT stash or discard uncommitted changes — other agents may be working concurrently and expecting those changes to be present. If the tree is dirty, only commit files YOU changed for this task.
- **NEVER use \`git stash\`** in any form (\`git stash push\`, \`git stash pop\`, etc.). This is a multi-agent system — stashing can silently destroy or corrupt another agent's or the user's in-progress work. Work around uncommitted changes instead. (Note: the backend may use \`--autostash\` in user-triggered pull operations — that is safe because those are single-user UI actions, not concurrent agent operations.)
- **Only commit files YOU changed** for this task. Never use \`git add -A\` or \`git add .\` — always stage specific files by name.
${isTui
  ? `- **Use \`${tuiCompletionCommand}\` to ${willOpenPR ? 'commit, push, and open the PR' : 'commit and push the branch'}** — see the Completion Workflow section above. Stage specific files (no \`git add -A\`), use \`feat:\`/\`fix:\`/\`breaking:\` prefix in the commit message, no Co-Authored-By annotations.`
  : worktreeInfo && willOpenPR
    ? `- **Commit only — do NOT push.** Stage specific files, use \`feat:\`/\`fix:\`/\`breaking:\` prefix in the commit message, no Co-Authored-By annotations. The system will push your branch and open the PR after you exit, so do NOT run \`git push\` or \`/do:push\` yourself.`
    : `- **Commit and push using \`/do:push\`** — this handles changelog updates, staging specific files, writing a conventional commit message, and pushing safely. If \`/do:push\` is unavailable, follow its conventions manually: stage specific files, use \`feat:\`/\`fix:\`/\`breaking:\` prefix, no Co-Authored-By annotations, and push with \`git pull --rebase && git push\`.`}
${worktreeInfo ? `- **Your PR should contain only your task's commits.** If you see unrelated commits in your branch history, something is wrong — do not open a PR with other agents' work.` : `- **Commit directly to the current branch.** Do NOT create feature branches or PRs unless explicitly instructed.`}

## Working Directory
${task.metadata?.app ? `You are working in the target app directory: \`${workspaceDir}\`. All code changes, research, plans, and docs for this task belong in this directory — NOT in the PortOS repo.` : 'You are working in the project directory.'} Use the available tools to explore, modify, and test code.

Begin working on the task now.`;
}

/**
 * Build the **light-context** prompt for agents that have native filesystem
 * tools and CLAUDE.md loading (Claude Code, Codex, Gemini — `tui` or `cli`).
 *
 * The agent already has direct access to the project, so we don't paste in:
 *   memory dumps, CLAUDE.md contents, digital twin, tools summary,
 *   `.planning/` snippets, auto-matched skill templates, or compaction
 *   warnings. We just hand it the task, any user-attached context/screenshots,
 *   and the PortOS-specific contract bits it can't infer (worktree branch,
 *   JIRA ticket, pipeline predecessors, completion-sentinel protocol,
 *   review-loop follow-up procedure).
 *
 * Falls back gracefully when worktree/jira/pipeline metadata is absent — only
 * the present sections render.
 */
export function buildLightContextPrompt(task, workspaceDir, worktreeInfo, isTruthyMetaFn, { isTui = true, providerId = null } = {}) {
  const willOpenPR = isTruthyMetaFn(task.metadata?.openPR);
  const willReviewLoop = isTruthyMetaFn(task.metadata?.reviewLoop);
  const simplifyEnabled = isTruthyMetaFn(task.metadata?.simplify);
  const isReadOnly = isTruthyMetaFn(task.metadata?.readOnly);
  const isReviewLoopFollowUp = isTruthyMetaFn(task.metadata?.reviewLoopFollowUp);
  const isWorktreeOnExistingBranch = worktreeInfo?.existingBranch === true;
  // Claude Code CLI providers can drive `/simplify` + `/do:pr` themselves
  // (the slashdo submodule mounts those as project-level slash commands).
  // Other CLI providers (codex, gemini) can't — they get the legacy
  // commit-only block where PortOS handles push+PR on exit.
  const hasSlashdo = !isTui && (providerId === 'claude-code' || providerId === 'claude-code-bedrock');

  const sections = [];

  // --- Task block --------------------------------------------------------
  // cwd is set by the spawner and the agent knows its own id from the
  // runner, so the prompt skips that metadata. Target app is kept because
  // it scopes managed-app work. Shared with the full path via buildTaskBlock.
  const taskBlock = buildTaskBlock(task, { screenshotsAsList: true });
  sections.push(taskBlock.description);
  if (taskBlock.targetApp) sections.push(taskBlock.targetApp);

  const context = task.metadata?.context;
  if (context) {
    sections.push(context.includes('\n')
      ? `### Context\n\n${context.trimEnd()}`
      : `### Context\n${context}`);
  }

  if (taskBlock.screenshots) sections.push(taskBlock.screenshots);

  // --- Worktree ----------------------------------------------------------
  if (worktreeInfo) {
    sections.push([
      '## Git Worktree',
      `- **Branch**: \`${worktreeInfo.branchName}\`${isWorktreeOnExistingBranch ? ' *(pre-existing PR branch)*' : ''}`,
      `- **Path**: \`${worktreeInfo.worktreePath}\``,
      worktreeInfo.baseBranch ? `- **Based on**: \`${worktreeInfo.baseBranch}\`` : null,
      '',
      worktreeCommitGuidance({ isTui, hasSlashdo, isWorktreeOnExistingBranch, willOpenPR }),
      'Do NOT manually switch branches or modify the worktree configuration.'
    ].filter(Boolean).join('\n'));
  }

  // --- Pipeline ----------------------------------------------------------
  const pipelineCtx = task.metadata?.pipeline;
  if (pipelineCtx?.previousStageAgentId) {
    const prevOutput = join(AGENTS_DIR, pipelineCtx.previousStageAgentId, 'output.txt');
    sections.push([
      '## Pipeline Context',
      `Stage ${pipelineCtx.currentStage + 1} of ${pipelineCtx.stages.length}: "${pipelineCtx.stages[pipelineCtx.currentStage]?.name}"`,
      `Previous stage: "${pipelineCtx.stages[pipelineCtx.currentStage - 1]?.name}"`,
      '',
      `Read the previous stage's output from: \`${prevOutput}\``,
      'If it produced a JSON results block, parse it to determine which items to process.'
    ].join('\n'));
  }

  // --- JIRA --------------------------------------------------------------
  if (task.metadata?.jiraTicketId) {
    sections.push([
      '## JIRA',
      `- **Ticket**: ${task.metadata.jiraTicketId} (${task.metadata.jiraTicketUrl})`,
      task.metadata.jiraBranch ? `- **Branch**: \`${task.metadata.jiraBranch}\` — commit here; do NOT switch branches.` : null,
      `Include the ticket ID in commit messages, e.g. \`${task.metadata.jiraTicketId}: description\`.`
    ].filter(Boolean).join('\n'));
  }

  // --- Completion / review-loop ------------------------------------------
  if (isReadOnly) {
    sections.push('## Read-Only Task\nDo NOT commit, push, or modify any files. Read data and report findings only.');
  } else if (isReviewLoopFollowUp) {
    sections.push(buildReviewLoopFollowUpSection(task.metadata || {}, { verbose: false }));
  } else if (isTui) {
    sections.push(buildTuiCompletionSection({
      willOpenPR, willReviewLoop, simplifyEnabled, sentinelPath: `${worktreeInfo?.worktreePath || workspaceDir}/.agent-done`
    }));
  } else {
    sections.push(buildCliCompletionSection({ worktreeInfo, willOpenPR, hasSlashdo, simplifyEnabled }));
  }

  sections.push('Begin working on the task now.');
  return sections.join('\n\n') + '\n';
}

/**
 * Worktree commit-guidance helper for the light prompt. Picks the right
 * single-sentence instruction based on whether the agent will run its own
 * push workflow (TUI or Claude Code CLI with slashdo), reuse an existing PR
 * branch (review fixes), or hand off to PortOS's post-exit push.
 */
function worktreeCommitGuidance({ isTui, hasSlashdo, isWorktreeOnExistingBranch, willOpenPR }) {
  if (isTui) return 'Commit your changes to this branch — see **Completion Workflow** below.';
  if (isWorktreeOnExistingBranch) {
    return 'Commit and **push** any review-fix commits to this branch (the PR points at it). Use `git pull --rebase` before pushing if needed.';
  }
  if (hasSlashdo && willOpenPR) {
    return 'Commit your changes here — the **Completion** section below drives the push and PR.';
  }
  if (hasSlashdo) {
    return 'Commit your changes here — the **Completion** section below drives the push.';
  }
  if (willOpenPR) {
    return 'Commit your changes here. The system will push and open a PR after you exit — do NOT push or open a PR yourself.';
  }
  return 'Commit your changes here. Your branch will be merged back automatically when the task completes.';
}

/**
 * Build the merge-and-verify steps that follow `/do:pr` in completion blocks.
 * Returns `{ lines, nextStep }` — append `lines` to the workflow array and
 * assign `nextStep` back to the caller's step counter so any subsequent
 * numbered steps stay continuous.
 *
 * The agent must drive the merge itself — `/do:pr` runs the Copilot review
 * loop but exits without merging, so without this step the PR sits open and
 * the branch leaks. Mirrors the merge contract in the review-loop follow-up
 * section so both agent flows converge on the same final state.
 */
function buildPostPRMergeSteps(startStep) {
  const lines = [
    `${startStep}. **Merge the PR immediately when the Copilot review loop reports \`clean\` (or \`too-large\`)** — \`/do:pr\` opens the PR and runs the review loop but does NOT merge. Capture the PR URL printed by \`/do:pr\` and run the exact command below (flags: \`--squash --delete-branch\`, nothing else — any merge-deferral flag leaves the PR open after you exit). Skip the merge if the loop ended \`timeout\`, \`error\`, or \`guardrail\`; leave the PR open for human follow-up.`,
    '   ```bash',
    '   gh pr merge "<PR_URL>" --squash --delete-branch',
    '   ```',
    `${startStep + 1}. Confirm the merge before exiting: \`gh pr view "<PR_URL>" --json state -q .state\` must return \`MERGED\`. If it returns \`OPEN\` or \`CLOSED\`, investigate (failing check, unresolved thread, branch protection), fix, and retry. Do NOT exit until state is \`MERGED\` (or you have explicitly decided not to merge per the rule above).`
  ];
  return { lines, nextStep: startStep + 2 };
}

/**
 * TUI completion-workflow block. The TUI owns its own commit → push → PR
 * pipeline via slashdo commands and signals "done" with a sentinel file.
 */
function buildTuiCompletionSection({ willOpenPR, willReviewLoop, simplifyEnabled, sentinelPath }) {
  const cmd = willOpenPR ? '/do:pr' : '/do:push';
  const reviewSuffix = willOpenPR && willReviewLoop
    ? ' — after the PR opens, request a Copilot review (e.g. via `gh`).' : '';
  const simplifyStep = simplifyEnabled ? '1. `/simplify`' : '1. (simplify disabled — skip)';
  const sentinelTail = willOpenPR ? '   ## PR\n   <PR URL>' : '   ## Branch\n   <branch name>';
  const merge = willOpenPR ? buildPostPRMergeSteps(3) : { lines: [], nextStep: 3 };
  const sentinelStep = merge.nextStep;
  const quitStep = sentinelStep + 1;

  return [
    '## Completion Workflow',
    'When the task is complete, run these in order:',
    '',
    simplifyStep,
    `2. \`${cmd}\`${reviewSuffix}`,
    ...merge.lines,
    `${sentinelStep}. Write a short markdown summary (~5–15 lines) to the completion sentinel — PortOS polls this every 2s; without it the agent sits idle until a 3-minute fallback fires.`,
    '',
    '   ```bash',
    `   cat > "${sentinelPath}" <<'EOF'`,
    '   ## Summary',
    '   <one-sentence statement of what was accomplished>',
    '',
    '   ## Changes',
    '   - <key file or area>: <what changed and why>',
    '',
    sentinelTail,
    '   EOF',
    '   ```',
    `${quitStep}. \`/quit\`.`
  ].join('\n');
}

/**
 * CLI (non-TUI) completion block.
 *
 * Claude Code CLI agents have slashdo commands available (the submodule
 * mounts them as project-level slash commands), so when `hasSlashdo` is
 * true and a PR is expected, the agent owns the full `/simplify` → `/do:pr`
 * sequence and PortOS skips its post-exit push+PR. Codex/Gemini and other
 * CLI providers fall through to the legacy commit-only block where PortOS
 * handles push+PR on exit.
 */
function buildCliCompletionSection({ worktreeInfo, willOpenPR, hasSlashdo = false, simplifyEnabled = false }) {
  if (hasSlashdo && worktreeInfo && willOpenPR) {
    const lines = ['## Completion', 'When finished, run these in order:'];
    let step = 1;
    if (simplifyEnabled) {
      lines.push(`${step++}. \`/simplify\` — review the changed code for reuse, quality, and efficiency, and fix any findings.`);
    }
    lines.push(`${step++}. \`/do:pr\` — commits your changes, pushes the branch, opens a pull request against the default branch, and drives the Copilot review loop until clean.`);
    const merge = buildPostPRMergeSteps(step);
    lines.push(...merge.lines);
    step = merge.nextStep;
    return lines.join('\n');
  }
  if (hasSlashdo && worktreeInfo) {
    const lines = ['## Completion', 'When finished, run these in order:'];
    let step = 1;
    if (simplifyEnabled) {
      lines.push(`${step++}. \`/simplify\` — review the changed code for reuse, quality, and efficiency, and fix any findings.`);
    }
    lines.push(`${step++}. \`/do:push\` — commits your changes and pushes the branch.`);
    return lines.join('\n');
  }
  let body;
  if (worktreeInfo && willOpenPR) {
    body = 'Commit your changes (stage specific files, `feat:`/`fix:` prefix, no Co-Authored-By). Do NOT push — PortOS will push and open the PR after you exit.';
  } else if (worktreeInfo) {
    body = 'Commit your changes to this branch. PortOS will merge it back when the task completes.';
  } else {
    body = 'Commit and push your changes (`git pull --rebase && git push`, conventional commit prefix, no `git add -A`).';
  }
  return `## Completion\n${body}`;
}

/**
 * Get workspace path for an app.
 */
export async function getAppWorkspace(appName) {
  const appsFile = join(ROOT_DIR, 'data/apps.json');

  const data = await readJSONFile(appsFile, null);
  if (!data) {
    return ROOT_DIR;
  }

  // Handle both object format { apps: { id: {...} } } and array format [...]
  const apps = data.apps || data;

  if (Array.isArray(apps)) {
    const app = apps.find(a => a.name === appName || a.id === appName);
    return app?.repoPath || ROOT_DIR;
  }

  // Object format - keys are app IDs
  const app = apps[appName] || Object.values(apps).find(a => a.name === appName);
  return app?.repoPath || ROOT_DIR;
}

/**
 * Get full app data for a task (including jira config).
 * Returns the app object or null if not found.
 */
export async function getAppDataForTask(task) {
  const appName = task?.metadata?.app;
  if (!appName) return null;

  const appsFile = join(ROOT_DIR, 'data/apps.json');
  const data = await readJSONFile(appsFile, null);
  if (!data) return null;

  const apps = data.apps || data;

  if (Array.isArray(apps)) {
    return apps.find(a => a.name === appName || a.id === appName) || null;
  }

  return apps[appName] || Object.values(apps).find(a => a.name === appName) || null;
}

/**
 * Generate a concise JIRA ticket title from a task description using AI.
 * Falls back to truncated description on failure.
 */
export async function generateJiraTitle(description) {
  const fallback = `[CoS] ${(description || 'Automated task').substring(0, 120)}`;

  const provider = await getActiveProvider().catch(() => null);
  if (!provider) return fallback;

  const model = provider.defaultModel || provider.models?.[0];
  if (!model) return fallback;

  const prompt = `Generate a concise JIRA ticket title (max 80 chars) for this task. Output ONLY the title text, nothing else.\n\nTask: ${description}`;

  // Best-effort title — failures are non-fatal (the task still gets the
  // truncated-description fallback). 30s is the legacy cap; titles should
  // be near-instant, and a slow model shouldn't block task creation.
  const result = await runPromptThroughProvider({
    provider, prompt, source: 'jira-title', model, timeout: 30000,
  }).catch(err => {
    console.warn(`⚠️ JIRA title generation failed: ${err.message}`);
    return null;
  });
  if (!result) return fallback;

  const title = (result.text || '').trim().replace(/^["']|["']$/g, '');
  return title || fallback;
}

/**
 * Create a JIRA ticket for a task if the app has JIRA integration enabled.
 * Non-blocking — returns null on failure.
 * @returns {Promise<{ticketId: string, ticketUrl: string, summary: string}|null>}
 */
export async function createJiraTicketForTask(task, app) {
  const jira = app?.jira;
  if (!jira?.enabled || !jira.instanceId || !jira.projectKey) return null;

  const summary = await generateJiraTitle(task.description);
  const description = [
    `Automated task created by PortOS Chief of Staff.`,
    ``,
    `*Task ID:* ${task.id}`,
    `*Priority:* ${task.priority || 'MEDIUM'}`,
    `*App:* ${app.name || task.metadata?.app || 'unknown'}`,
    ``,
    `{quote}`,
    task.description || '',
    `{quote}`
  ].join('\n');

  const result = await jiraService.createTicket(jira.instanceId, {
    projectKey: jira.projectKey,
    summary,
    description,
    issueType: jira.issueType || 'Task',
    labels: jira.labels || [],
    assignee: jira.assignee,
    epicKey: jira.epicKey
  }).catch(err => {
    emitLog('warn', `Failed to create JIRA ticket: ${err.message}`, { taskId: task.id, app: app.name });
    return null;
  });

  if (!result?.ticketId) return null;

  emitLog('success', `Created JIRA ticket ${result.ticketId}`, {
    taskId: task.id,
    ticketId: result.ticketId,
    ticketUrl: result.url
  });

  return { ticketId: result.ticketId, ticketUrl: result.url, summary };
}
