/**
 * Agent Prompt Builder
 *
 * Builds the full agent prompt including memory context, CLAUDE.md instructions,
 * digital twin, worktree/pipeline/JIRA sections, skill templates, and tools summary.
 * Also handles JIRA ticket creation and app workspace resolution.
 */

import { join } from 'path';
import { readFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
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
  const templatePath = join(SKILLS_DIR, `${skillName}.md`);
  if (!existsSync(templatePath)) return null;
  const content = await readFile(templatePath, 'utf-8');
  console.log(`🎯 Loaded skill template: ${skillName}`);
  return content;
}

/**
 * Read CLAUDE.md files for agent context.
 * Reads both global (~/.claude/CLAUDE.md) and project-specific (./CLAUDE.md).
 */
export async function getClaudeMdContext(workspaceDir) {
  const contexts = [];

  // Try to read global CLAUDE.md from ~/.claude/CLAUDE.md
  try {
    const globalPath = join(homedir(), '.claude', 'CLAUDE.md');
    if (existsSync(globalPath)) {
      const content = await readFile(globalPath, 'utf-8');
      if (content.trim()) {
        contexts.push({
          type: 'Global Instructions',
          path: globalPath,
          content: content.trim()
        });
      }
    }
  } catch (err) {
    // Silently ignore if global CLAUDE.md doesn't exist or can't be read
  }

  // Try to read project-specific CLAUDE.md from workspace directory
  try {
    const projectPath = join(workspaceDir, 'CLAUDE.md');
    if (existsSync(projectPath)) {
      const content = await readFile(projectPath, 'utf-8');
      if (content.trim()) {
        contexts.push({
          type: 'Project Instructions',
          path: projectPath,
          content: content.trim()
        });
      }
    }
  } catch (err) {
    // Silently ignore if project CLAUDE.md doesn't exist or can't be read
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
 * Build the full agent prompt.
 * @param {Object} task - Task object
 * @param {Object} config - CoS configuration
 * @param {string} workspaceDir - Working directory (may be a worktree)
 * @param {Object|null} worktreeInfo - Worktree details if using a worktree
 * @param {Function} isTruthyMetaFn - isTruthyMeta function (passed to avoid circular dep)
 */
export async function buildAgentPrompt(task, config, workspaceDir, worktreeInfo = null, isTruthyMetaFn = (v) => v === true || v === 'true') {
  // Get relevant memories for context injection
  const memorySection = await getMemorySection(task, {
    maxTokens: config.memory?.maxContextTokens || 2000
  }).catch(err => {
    console.log(`⚠️ Memory retrieval failed: ${err.message}`);
    return null;
  });

  // Get CLAUDE.md instructions for context injection
  const claudeMdSection = await getClaudeMdContext(workspaceDir).catch(err => {
    console.log(`⚠️ CLAUDE.md retrieval failed: ${err.message}`);
    return null;
  });

  // Get digital twin context for persona alignment
  const digitalTwinSection = await getDigitalTwinForPrompt({
    maxTokens: config.digitalTwin?.maxContextTokens || config.soul?.maxContextTokens || 2000
  }).catch(err => {
    console.log(`⚠️ Digital twin context retrieval failed: ${err.message}`);
    return null;
  });

  // Build context compaction section if task is retrying after a context-limit failure
  const compactionSection = task.metadata?.compaction?.needed ? buildCompactionSection(task) : '';

  // Build worktree context section if applicable
  const willOpenPR = isTruthyMetaFn(task.metadata?.openPR);
  const willReviewLoop = isTruthyMetaFn(task.metadata?.reviewLoop);
  // When reviewLoop is enabled alongside openPR, the agent opens the PR during its run
  const prHandledByAgent = willReviewLoop && willOpenPR;
  const worktreeSection = worktreeInfo ? `
## Git Worktree Context
You are working in an **isolated git worktree** to avoid conflicts with other agents working concurrently.
- **Branch**: \`${worktreeInfo.branchName}\`
- **Worktree Path**: \`${worktreeInfo.worktreePath}\`
${worktreeInfo.baseBranch ? `- **Based on**: \`${worktreeInfo.baseBranch}\` (latest from origin)` : ''}

**Important**: Commit your changes to this branch.${willOpenPR && !prHandledByAgent ? ' Your commits will be submitted as a pull request to the default branch when your task completes.' : ' Your commits will be automatically merged back to the main development branch when your task completes.'} Do NOT manually switch branches or modify the worktree configuration.
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

  // Build simplify section if enabled
  const simplifySection = isTruthyMetaFn(task.metadata?.simplify) ? `
## Simplify Step
After completing your work and before committing, run \`/simplify\` to review the changed code for reuse, quality, and efficiency. Fix any issues found before committing.
` : '';

  // Build review loop section if enabled
  const reviewLoopSection = willReviewLoop ? `
## Review Loop
After opening the PR, run \`/do:rpr\` to resolve PR review feedback and complete the merge validation. Continue running the review loop until all checks pass and the PR is approved.
` : '';

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
      const stateContent = await readFile(join(planningPath, 'STATE.md'), 'utf-8').catch(() => null);
      if (stateContent) planningParts.push(`### Current State\n\`\`\`\n${stateContent.slice(0, 1000)}\n\`\`\``);
      const concernsContent = await readFile(join(planningPath, 'CONCERNS.md'), 'utf-8').catch(() => null);
      if (concernsContent) planningParts.push(`### Known Concerns\n\`\`\`\n${concernsContent.slice(0, 1500)}\n\`\`\``);
      const roadmapContent = await readFile(join(planningPath, 'ROADMAP.md'), 'utf-8').catch(() => null);
      if (roadmapContent) planningParts.push(`### Roadmap\n\`\`\`\n${roadmapContent.slice(0, 1000)}\n\`\`\``);
      if (planningParts.length > 0) {
        planningContextSection = `\n## Project Planning Context (.planning/)\nThis project has GSD planning documents. Use this context to understand priorities and known issues.\n\n${planningParts.join('\n\n')}\n`;
      }
    }
  }

  // Try to use the prompt template system
  const promptData = await buildPrompt('cos-agent-briefing', {
    task,
    config,
    memorySection,
    claudeMdSection,
    digitalTwinSection,
    worktreeSection,
    pipelineSection,
    jiraSection,
    simplifySection,
    reviewLoopSection,
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
  return `# Chief of Staff Agent Briefing

${claudeMdSection || ''}

${memorySection || ''}

## Task Assignment
You are an autonomous agent working on behalf of the Chief of Staff.

### Task Details
- **ID**: ${task.id}
- **Priority**: ${task.priority}
- **Description**: ${task.description}
${task.metadata?.context ? `- **Context**: ${task.metadata.context}` : ''}
${task.metadata?.app ? `- **Target App**: ${task.metadata.app}\n- **Target App Directory**: ${workspaceDir}` : ''}
${Array.isArray(task.metadata?.screenshots) && task.metadata.screenshots.length > 0 ? `- **Screenshots**: ${task.metadata.screenshots.join(', ')}` : ''}
${worktreeSection}
${pipelineSection}
${jiraSection}
${simplifySection}
${reviewLoopSection}
${compactionSection}
${skillSection ? `## Task-Type Skill Guidelines\n\n${skillSection}\n` : ''}${toolsSection ? `\n${toolsSection}\n` : ''}${planningContextSection}
## Instructions
1. Analyze the task requirements carefully
2. Make necessary changes to complete the task
3. Test your changes when possible
4. Provide a summary of what was done

## Guidelines
- Focus only on the assigned task
- Make minimal, targeted changes
- Follow existing code patterns and conventions
- Do not make unrelated changes
- If blocked, explain clearly why
- Never update the PortOS changelog (\`.changelog/\`) for work on managed apps — the PortOS changelog tracks PortOS core changes only
- **BTW Messages**: The user may send you additional context while you work. Check for a \`BTW.md\` file in your working directory root — if it exists, read it for important messages from the user. Incorporate that context into your work. Do not delete or modify BTW.md.
${isTruthyMetaFn(task.metadata?.readOnly) ? `- **This is a read-only task.** Do NOT commit, push, or modify any files in the repository. Only read data and generate reports.` : task.metadata?.app && worktreeInfo && willOpenPR ? `- Commit code after each feature or bug fix using the git tools or /cam skill. A pull request will be automatically created when your task completes — do NOT open a PR manually.` : task.metadata?.app && worktreeInfo ? `- Commit code after each feature or bug fix using the git tools or /cam skill. Your worktree branch will be automatically merged back to the source branch when your task completes — do NOT open a PR.` : `- Commit code after each feature or bug fix using the git tools or /cam skill`}

## Git Hygiene (CRITICAL)
- **Before starting work**, run \`git status\` to verify a clean working tree. If there are uncommitted changes from a previous agent or manual work, **stash or discard them** before proceeding — do NOT commit someone else's changes.
- **Only commit files YOU changed** for this task. Never use \`git add -A\` or \`git add .\` — always stage specific files by name.
${worktreeInfo ? `- **Your PR should contain only your task's commits.** If you see unrelated commits in your branch history, something is wrong — do not open a PR with other agents' work.` : `- **Commit directly to the current branch.** Do NOT create feature branches or PRs unless explicitly instructed.`}
- If the working tree is dirty with changes unrelated to your task, run \`git stash\` to set them aside before starting.

## Working Directory
${task.metadata?.app ? `You are working in the target app directory: \`${workspaceDir}\`. All code changes, research, plans, and docs for this task belong in this directory — NOT in the PortOS repo.` : 'You are working in the project directory.'} Use the available tools to explore, modify, and test code.

Begin working on the task now.`;
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
  }).catch(() => {});

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
