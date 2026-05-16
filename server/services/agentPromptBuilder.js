/**
 * Agent Prompt Builder
 *
 * Builds the full agent prompt including memory context, CLAUDE.md instructions,
 * digital twin, worktree/pipeline/JIRA sections, skill templates, and tools summary.
 * Also handles JIRA ticket creation and app workspace resolution.
 */

import { join } from 'path';
import { readFile, stat } from 'fs/promises';
import { homedir } from 'os';
import { getMemorySection } from './memoryRetriever.js';
import { getDigitalTwinForPrompt } from './digital-twin.js';
import { buildPrompt } from './promptService.js';
import { getToolsSummaryForPrompt } from './tools.js';
import { getActiveProvider } from './providers.js';
import { executeApiRun, executeCliRun, createRun } from './runner.js';
import { readJSONFile, loadSlashdoFile, PATHS } from '../lib/fileUtils.js';
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
  const content = await readFile(join(SKILLS_DIR, `${skillName}.md`), 'utf-8').catch(() => null);
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
  const globalContent = await readFile(globalPath, 'utf-8').catch(() => null);
  if (globalContent?.trim()) {
    contexts.push({ type: 'Global Instructions', path: globalPath, content: globalContent.trim() });
  }

  // Try to read project-specific CLAUDE.md from workspace directory
  const projectPath = join(workspaceDir, 'CLAUDE.md');
  const projectContent = await readFile(projectPath, 'utf-8').catch(() => null);
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

  // TUI Completion Workflow. Claude Code TUI has direct access to the
  // slashdo commands (the submodule mounts them as project-level slash
  // commands), so the agent runs the whole tail end itself instead of
  // having PortOS drive push/PR creation from cleanup. The sentinel file
  // (.agent-done) is what PortOS polls for to know the agent has finished
  // — write it AFTER /do:pr/push succeeds, then /quit exits Claude Code
  // and the spawn's handleExit fires.
  const tuiCompletionCommand = willOpenPR ? '/do:pr' : '/do:push';
  const tuiCompletionSection = isTui ? `
## Completion Workflow
You are running inside the Claude Code TUI, which has the project's slashdo commands available as slash commands. **You own the entire commit → push → ${willOpenPR ? 'PR' : 'push'} sequence — PortOS will NOT push or open a PR on your behalf.** When your task is complete, run the following — in order — without further user input:

1. ${simplifyEnabled ? '`/simplify` — review the changed code for reuse, quality, and efficiency, and fix any issues it surfaces.' : '(simplify is disabled for this task — skip step 1)'}
2. \`${tuiCompletionCommand}\` — commits${willOpenPR ? `, pushes, and opens a pull request against the default branch. Write the PR title and body yourself based on the actual changes you made; do NOT let any tool auto-generate the body from terminal output.${willReviewLoop ? ' After the PR is open, request a Copilot review (e.g. via `gh` if available).' : ''}` : ' and pushes the branch'}.
3. Write your task summary to the completion sentinel as a SHORT markdown report — this becomes the task summary PortOS displays in the agent card and feeds into downstream features (memory extraction, completion hooks, etc.). Aim for ~5–15 lines. Use this exact shell-quoted heredoc form:

   \`\`\`bash
   cat > "${worktreeInfo?.worktreePath || workspaceDir}/.agent-done" <<'EOF'
   ## Summary
   <one-sentence statement of what was accomplished>

   ## Changes
   - <key file or area>: <what changed and why>
   - <…>

   ${willOpenPR ? '## PR\n   <PR URL>' : '## Branch\n   <branch name>'}
   EOF
   \`\`\`

   PortOS polls for this file every 2 seconds; without it the agent will sit idle until the 3-minute fallback timer fires.
4. Run \`/quit\` to exit the Claude Code session cleanly.

Do not wait for further user input between these steps — run them in sequence as soon as the implementation work is finished.
` : '';

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
    const prUrl = task.metadata?.reviewLoopPRUrl || '';
    const prBranch = task.metadata?.reviewLoopPRBranch || '';
    const prNumber = task.metadata?.reviewLoopPRNumber ?? '';
    const prOwner = task.metadata?.reviewLoopPROwner ?? '';
    const prRepo = task.metadata?.reviewLoopPRRepo ?? '';
    const sourceTaskId = task.metadata?.sourceTaskId || 'unknown';
    const rprBody = await loadSlashdoFile('rpr').catch(() => null);

    reviewLoopFollowUpSection = `
## Review-Loop Follow-up (PRIMARY OBJECTIVE)
A previous agent finished implementing the work for source task **${sourceTaskId}** and opened **PR ${prUrl}** on branch \`${prBranch}\`. The system has already requested an initial Copilot code review. **Your job is to drive the review-and-fix loop to completion and merge the PR.**

**Run this loop UNTIL the PR has zero unresolved Copilot comments OR you hit the iteration cap of 10:**

1. Wait for the latest Copilot review to complete (poll every 5–15s, max 5 minutes per round).
2. If there are unresolved review threads, fix them in this worktree, run the project's tests, commit (\`feat:\`/\`fix:\` prefix, no Co-Authored-By), push, and resolve the addressed threads.
3. Re-request a Copilot review.
4. Repeat from step 1.
5. When Copilot returns "0 comments" / no unresolved threads, merge the PR with:
   \`\`\`bash
   gh pr merge "${prUrl}" --squash --auto --delete-branch
   \`\`\`
   ${prOwner && prRepo && prNumber ? `(Equivalent: \`gh pr merge ${prNumber} --repo ${prOwner}/${prRepo} --squash --auto --delete-branch\`.)` : ''}
6. Exit. Do **not** run \`/do:push\` or open a new PR — the merge handles everything. The system will clean up your worktree on exit (no auto-merge will be re-attempted because \`gh pr merge\` already merged on the remote).

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
        readFile(join(planningPath, 'STATE.md'), 'utf-8').catch(() => null),
        readFile(join(planningPath, 'CONCERNS.md'), 'utf-8').catch(() => null),
        readFile(join(planningPath, 'ROADMAP.md'), 'utf-8').catch(() => null)
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

  // Fallback to built-in template
  return `${claudeMdSection || ''}

${memorySection || ''}

## Task Assignment

### Task Details
- **ID**: ${task.id}
- **Priority**: ${task.priority}
- **Description**: ${task.description}
${task.metadata?.context ? (task.metadata.context.includes('\n') ? `\n### Task Context\n\n${task.metadata.context.trimEnd()}\n` : `- **Context**: ${task.metadata.context}`) : ''}
${task.metadata?.app ? `- **Target App**: ${task.metadata.app}\n- **Target App Directory**: ${workspaceDir}` : ''}
${Array.isArray(task.metadata?.screenshots) && task.metadata.screenshots.length > 0 ? `- **Screenshots**: ${task.metadata.screenshots.join(', ')}` : ''}
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
${isTruthyMetaFn(task.metadata?.readOnly) ? `- **This is a read-only task.** Do NOT commit, push, or modify any files in the repository. Only read data and generate reports.` : isTui ? `- On successful completion, YOU run the Completion Workflow above (\`${tuiCompletionCommand}\`, write the sentinel, \`/quit\`). PortOS will NOT push or open a PR on your behalf.` : worktreeInfo && willOpenPR ? `- On successful completion, the system will push your branch and open a pull request — do NOT open a PR manually. (If the task fails, no PR is opened; the worktree is then cleaned up unless a safety check preserves it for manual recovery.)${willReviewLoop ? ' For GitHub PRs, a Copilot code review will also be requested automatically (skipped on GitLab and other non-GitHub forges) — do NOT run \`/do:rpr\` or attempt to address review comments yourself; you will have already exited.' : ''}` : worktreeInfo ? `- Your worktree branch will be automatically merged back to the source branch when your task completes — do NOT open a PR.` : ``}

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
  const taskLines = [
    '## Task',
    `- **ID**: ${task.id}`,
    `- **Priority**: ${task.priority}`,
    `- **Description**: ${task.description}`
  ];
  if (task.metadata?.app) taskLines.push(`- **Target App**: ${task.metadata.app}`);
  taskLines.push(`- **Working Directory**: \`${workspaceDir}\``);
  sections.push(taskLines.join('\n'));

  const context = task.metadata?.context;
  if (context) {
    sections.push(context.includes('\n')
      ? `### Context\n\n${context.trimEnd()}`
      : `### Context\n${context}`);
  }

  if (Array.isArray(task.metadata?.screenshots) && task.metadata.screenshots.length > 0) {
    sections.push(
      '### Screenshots\nUse your filesystem tools to inspect each path:\n' +
      task.metadata.screenshots.map(s => `- \`${s}\``).join('\n')
    );
  }

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
    const prUrl = task.metadata?.reviewLoopPRUrl || '';
    const prBranch = task.metadata?.reviewLoopPRBranch || '';
    const prNumber = task.metadata?.reviewLoopPRNumber ?? '';
    const prOwner = task.metadata?.reviewLoopPROwner ?? '';
    const prRepo = task.metadata?.reviewLoopPRRepo ?? '';
    const sourceTaskId = task.metadata?.sourceTaskId || 'unknown';
    sections.push([
      '## Review-Loop Follow-up (PRIMARY OBJECTIVE)',
      `A previous agent finished task **${sourceTaskId}** and opened **PR ${prUrl}** on \`${prBranch}\`. The system has requested an initial Copilot review. Drive the review-and-fix loop to completion and merge.`,
      '',
      '**Loop UNTIL zero unresolved Copilot comments OR 10 iterations:**',
      '1. Wait for the latest Copilot review (poll 5–15s, max 5 min per round).',
      '2. If unresolved threads: fix in this worktree, run tests, commit (`feat:`/`fix:` prefix, no Co-Authored-By), push, resolve threads.',
      '3. Re-request a Copilot review.',
      '4. Repeat.',
      '5. When clean, merge with:',
      '   ```bash',
      `   gh pr merge "${prUrl}" --squash --auto --delete-branch`,
      '   ```',
      prOwner && prRepo && prNumber ? `   (Equivalent: \`gh pr merge ${prNumber} --repo ${prOwner}/${prRepo} --squash --auto --delete-branch\`.)` : null,
      '6. Exit — do NOT run `/do:push` or open a new PR.',
      '',
      '**Hard stop:** if not converged after 10 rounds, post a PR comment summarising blockers and exit.',
      '**Repeated comments:** if a round only re-raises feedback you intentionally rejected (with a reply explaining why), treat as clean and merge.'
    ].filter(Boolean).join('\n'));
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
    return 'Commit your changes here — the **Completion** section below drives the push and PR. PortOS will NOT push or open a PR on your behalf.';
  }
  if (hasSlashdo) {
    return 'Commit your changes here — the **Completion** section below drives the push. PortOS will NOT push on your behalf.';
  }
  if (willOpenPR) {
    return 'Commit your changes here. The system will push and open a PR after you exit — do NOT push or open a PR yourself.';
  }
  return 'Commit your changes here. Your branch will be merged back automatically when the task completes.';
}

/**
 * TUI completion-workflow block. The TUI owns its own commit → push → PR
 * pipeline via slashdo commands and signals "done" with a sentinel file.
 */
function buildTuiCompletionSection({ willOpenPR, willReviewLoop, simplifyEnabled, sentinelPath }) {
  const cmd = willOpenPR ? '/do:pr' : '/do:push';
  const verb = willOpenPR ? 'PR' : 'push';
  const cmdEffect = willOpenPR
    ? ', pushes, and opens a PR against the default branch. Write the PR title and body yourself; do NOT let any tool auto-generate from terminal output'
    : ' and pushes the branch';
  const reviewSuffix = willOpenPR && willReviewLoop
    ? ' After the PR is open, request a Copilot review (e.g. via `gh`).' : '';
  const simplifyStep = simplifyEnabled
    ? '1. `/simplify` — review the changed code for reuse/quality/efficiency and fix any findings.'
    : '1. (simplify disabled — skip)';
  const sentinelTail = willOpenPR ? '   ## PR\n   <PR URL>' : '   ## Branch\n   <branch name>';

  return [
    '## Completion Workflow',
    `You own the entire commit → push → ${verb} sequence. PortOS will NOT push or open a PR for you. When the task is complete, run these in order without further user input:`,
    '',
    simplifyStep,
    `2. \`${cmd}\` — commits${cmdEffect}.${reviewSuffix}`,
    '3. Write the completion sentinel as a SHORT markdown report (~5–15 lines):',
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
    '',
    '   PortOS polls for this file every 2 seconds; without it the agent sits idle until the 3-minute fallback fires.',
    '4. Run `/quit` to exit cleanly.'
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
    const lines = ['## Completion', 'When finished, run these in order without further user input:'];
    let step = 1;
    if (simplifyEnabled) {
      lines.push(`${step++}. \`/simplify\` — review the changed code for reuse, quality, and efficiency, and fix any findings.`);
    }
    lines.push(`${step++}. \`/do:pr\` — commits your changes, pushes the branch, and opens a pull request against the default branch.`);
    lines.push('', 'PortOS will NOT push or open a PR on your behalf.');
    return lines.join('\n');
  }
  if (hasSlashdo && worktreeInfo) {
    const lines = ['## Completion', 'When finished, run these in order without further user input:'];
    let step = 1;
    if (simplifyEnabled) {
      lines.push(`${step++}. \`/simplify\` — review the changed code for reuse, quality, and efficiency, and fix any findings.`);
    }
    lines.push(`${step++}. \`/do:push\` — commits your changes and pushes the branch.`);
    lines.push('', 'PortOS will NOT push on your behalf.');
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

  const { runId } = await createRun({ providerId: provider.id, model, prompt, source: 'jira-title' }).catch(() => ({}));
  if (!runId) return fallback;

  let title = '';

  await new Promise((resolve) => {
    const onData = (data) => { title += typeof data === 'string' ? data : (data?.text || ''); };
    const onDone = () => resolve();

    if (provider.type === 'cli') {
      executeCliRun(runId, provider, prompt, process.cwd(), onData, onDone, 30000);
    } else {
      executeApiRun(runId, provider, model, prompt, process.cwd(), [], onData, onDone);
    }
  }).catch(err => console.warn(`⚠️ JIRA title generation failed: ${err.message}`));

  title = title.trim().replace(/^["']|["']$/g, '');
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
