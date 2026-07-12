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
import { DEFAULT_REVIEWER, DEFAULT_REVIEWERS, DEFAULT_REVIEW_STOP_MODE, LOCAL_LLM_REVIEWERS, MODEL_CAPABLE_CLI_REVIEWERS, normalizeReviewers, normalizeReviewUsernames, resolveKeyedReviewers, buildReviewWithArgs } from '../lib/validation.js';
import { PROVIDER_TYPES } from '../lib/aiToolkit/constants.js';
import { isOpencodeCommand } from '../lib/providerModels.js';
import { shellQuote } from '../lib/shellQuote.js';
import * as jiraService from './jira.js';
import { emitLog } from './cosEvents.js';
import { PORTOS_APP_ID } from './apps.js';

const ROOT_DIR = PATHS.root;
const AGENTS_DIR = PATHS.cosAgents;
const SKILLS_DIR = join(ROOT_DIR, 'data/prompts/skills');

// Appended to every agent briefing. PortOS shares ONE pm2 daemon across many
// apps; an agent restarting "the server" once ran `pm2 kill` and took the whole
// machine (incl. PortOS) down. A PATH shim (server/lib/agentGuard) hard-blocks
// the destructive subcommands, but the prompt rule keeps a well-behaved agent
// from even attempting them.
export const PM2_SAFETY_RULE = `## ⚠️ PM2 Safety (shared server)
PortOS runs MANY apps under one shared pm2 daemon. To restart an app, use a SCOPED command — \`pm2 restart <that-app's-process-name>\`. NEVER run \`pm2 kill\`, \`pm2 stop\`, \`pm2 delete\`, \`pm2 startup\`/\`unstartup\`, or any \`pm2 <verb> all\` form: they take down EVERY app on this machine, including PortOS itself, and are blocked (they will fail).`;

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
 * filesystem tools and CLAUDE.md loading (Claude Code, Codex, Antigravity —
 * whether running interactively as `tui` or one-shot as `cli`). Everything
 * else (`api`: LM Studio, raw OpenAI/Anthropic) needs the full pasted-in
 * context because it has no native filesystem access.
 */
const LIGHT_CONTEXT_PROVIDER_TYPES = new Set([PROVIDER_TYPES.TUI, PROVIDER_TYPES.CLI]);

// Inline reuse/quality/efficiency self-review wording for agents that can't run
// the Claude Code `/simplify` built-in (API providers + codex/antigravity CLIs).
// Shared by both prompt paths so the two phrasings can't drift apart.
const SIMPLIFY_INLINE_REVIEW = 'review your changed code for reuse, quality, and efficiency (DRY, dead code, naming, simpler equivalents, missed edge cases)';

/**
 * Render a file-list task field (screenshots, attachments, …) either as a
 * `### Header` + bulleted-path list (light path) or a single inline
 * `**Header**: a, b` line (full path). Shared by every file-list field in
 * `buildTaskBlock` so a wording tweak or a new field can't drift between them.
 *
 * @param {string} header - Section heading / inline label (e.g. "Screenshots").
 * @param {Array} items - Task-metadata array; anything else renders as ''.
 * @param {(item: any) => string} formatItem - Renders one item for the bulleted list.
 * @param {(item: any) => string} formatInline - Renders one item for the inline join.
 * @param {boolean} asList - Bulleted-list style vs. inline style.
 * @returns {string}
 */
function renderFileListField(header, items, formatItem, formatInline, asList) {
  if (!Array.isArray(items) || items.length === 0) return '';
  return asList
    ? `### ${header}\nUse your filesystem tools to inspect each path:\n` +
      items.map(i => `- ${formatItem(i)}`).join('\n')
    : `**${header}**: ${items.map(formatInline).join(', ')}`;
}

/**
 * Build the shared task block — the description plus optional `**Target App**`,
 * `**Screenshots**`, and `**Attachments**` fields. Used by BOTH the light and
 * full prompt paths so a new task-metadata field gets surfaced in both without
 * drift.
 *
 * Returns pre-rendered slots (`description`, `targetApp`, `screenshots`,
 * `attachments`). Absent fields come back as empty strings so the full path's
 * template literal can interpolate them in fixed positions and preserve
 * byte-identical line spacing. The light path filters out the empty strings
 * and joins what remains.
 *
 * @param {Object} task
 * @param {Object} [opts]
 * @param {boolean} [opts.screenshotsAsList=false] - When true, render screenshots
 *   and attachments as a header followed by a bulleted list of paths (light
 *   path style). When false, render as a single inline `**Field**: a, b`
 *   line (full path style).
 * @returns {{ description: string, targetApp: string, screenshots: string, attachments: string }}
 */
export function buildTaskBlock(task, { screenshotsAsList = false } = {}) {
  const description = task.description;
  // Only surface **Target App** for MANAGED apps — it scopes cross-repo work the
  // agent's cwd wouldn't otherwise reveal. For the PortOS default app the agent
  // already runs in the PortOS directory, so the line is redundant noise.
  const app = task.metadata?.app;
  const targetApp = app && app !== PORTOS_APP_ID ? `**Target App**: ${app}` : '';
  const screenshots = renderFileListField(
    'Screenshots', task.metadata?.screenshots,
    (s) => `\`${s}\``, (s) => s, screenshotsAsList
  );
  const label = (f) => (f?.originalName || f?.filename || f?.path || '').toString();
  const path = (f) => (f?.path || '').toString();
  const attachments = renderFileListField(
    'Attachments', task.metadata?.attachments,
    (f) => `\`${path(f)}\` (${label(f)})`, (f) => `${label(f)} (${path(f)})`, screenshotsAsList
  );
  return { description, targetApp, screenshots, attachments };
}

/**
 * Undo the COS-TASKS.md round-trip split before rendering. The queue path in
 * `cosTaskGenerator.js` persists a generated multi-line prompt by moving the
 * full body into `metadata.context` and keeping only its first line as
 * `description`, so the markdown stays one-line-per-task. Coming back out,
 * `context` therefore *leads with a verbatim copy* of `description` — and every
 * render path emits both (the task block, then the full body again under a
 * `### Context` header). For a swarm task that surfaces as the reported
 * double `# ⚡ SWARM MODE …` header; the same duplication hits any other
 * generated/scheduled/system task that round-trips through the queue.
 *
 * When the split signature is present (`context` is a string whose first
 * non-empty line equals `description`), fold `context` back into `description`
 * and drop the redundant `metadata.context` so the prompt renders once, as one
 * clean body with no spurious header. A genuinely-separate user-supplied
 * `context` (first line differs from `description`) is left untouched.
 *
 * Pure and idempotent: returns the same task when nothing matched, otherwise a
 * shallow clone (never mutates the caller's task, so the stored task keeps its
 * one-line `description` for the task-list UI).
 */
export function reconcileSplitContext(task) {
  const context = task?.metadata?.context;
  if (typeof context !== 'string' || typeof task.description !== 'string') return task;
  // Mirror firstLine() in cosTaskStore.js: first non-empty, trimmed line.
  const firstNonEmpty = context.split('\n').map(l => l.trim()).find(Boolean) || '';
  if (firstNonEmpty !== task.description.trim()) return task;
  const { context: _dropped, ...restMeta } = task.metadata;
  return { ...task, description: context, metadata: restMeta };
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
  // Arbitrary GitHub reviewer usernames (gate-only PR reviewers), appended to
  // the review flow after the keyed reviewers.
  const usernames = normalizeReviewUsernames(metadata.reviewLoopReviewerUsernames);
  // Ordered keyed reviewer list (back-compat: legacy single `reviewLoopReviewer`).
  // `reviewLoopReviewers` from spawnReviewLoopFollowUp is authoritative (copilot
  // already stripped on non-GitHub forges); resolveKeyedReviewers keeps an
  // explicit empty list empty when usernames carry the review (username-only).
  const reviewerSource = Array.isArray(metadata.reviewLoopReviewers)
    ? metadata.reviewLoopReviewers
    : (metadata.reviewLoopReviewer ? [metadata.reviewLoopReviewer] : undefined);
  const reviewers = resolveKeyedReviewers(reviewerSource, usernames.length > 0);
  const stopMode = metadata.reviewLoopStopMode || DEFAULT_REVIEW_STOP_MODE;
  const reviewerApplies = metadata.reviewLoopReviewerApplies === true;
  const hasCopilot = reviewers.includes(DEFAULT_REVIEWER);
  const hasLocalLlm = reviewers.some(r => LOCAL_LLM_REVIEWERS.includes(r));
  const hasCli = reviewers.some(r => r !== DEFAULT_REVIEWER && !LOCAL_LLM_REVIEWERS.includes(r));
  const hasGithubUser = usernames.length > 0;
  // Optional per-CLI-reviewer model tiers chosen on the Code Review Defaults panel,
  // threaded as a reviewer-keyed map. Each configured, model-capable reviewer that
  // is actually in this loop's list gets a `<reviewer> --model <id>` note (empty =
  // let that CLI use its own default). For an Ollama-backed `claude` reviewer the id
  // is the local Ollama model. Falls back to the legacy codex-scalar metadata key so
  // a follow-up task persisted by an older install still threads its codex model.
  const reviewerModelMap = (metadata.reviewLoopReviewerModels && typeof metadata.reviewLoopReviewerModels === 'object')
    ? metadata.reviewLoopReviewerModels
    : (typeof metadata.reviewLoopCodexModel === 'string' && metadata.reviewLoopCodexModel
        ? { codex: metadata.reviewLoopCodexModel }
        : {});
  const reviewerModelEntries = MODEL_CAPABLE_CLI_REVIEWERS
    .filter(r => reviewers.includes(r) && typeof reviewerModelMap[r] === 'string' && reviewerModelMap[r])
    .map(r => `\`${r} --model ${reviewerModelMap[r]} …\``);
  const reviewerModelNote = reviewerModelEntries.length
    ? ` When invoking a reviewer with a pinned model, pass it: ${reviewerModelEntries.join(', ')}.`
    : '';
  // "multi" reflects the TOTAL number of review sources (keyed reviewers +
  // username reviewers) so the ordered per-reviewer loop wording kicks in as
  // soon as there's more than one thing to satisfy.
  const multi = (reviewers.length + usernames.length) > 1;
  // The system pre-requests the initial Copilot review only when copilot LEADS the
  // order; otherwise the agent must request it at copilot's turn (so Copilot reviews
  // the post-CLI-fix state, not a stale diff).
  const copilotIsFirst = reviewers[0] === DEFAULT_REVIEWER;
  const reviewerLabel = [
    ...reviewers.map(r => `\`${r}\``),
    ...usernames.map(u => `\`@${u}\``),
  ].join(' → ');
  const equivArgs = buildReviewWithArgs(reviewers, stopMode, reviewerApplies, usernames);
  const equiv = equivArgs ? ` (equivalent to \`/do:pr ${equivArgs}\`)` : '';

  // First step: how to obtain a review. For a single copilot/CLI reviewer keep the
  // focused wording; for a list, dispatch each reviewer in order. Only emit the
  // per-reviewer-kind bullet that actually applies to the configured list.
  // `lmstudio`/`ollama` don't have CLIs the agent can spawn — PortOS exposes
  // `POST /api/code-review/local` which runs the configured local model against
  // the diff and returns findings text. The agent always reaches it via
  // `http://localhost:5555` (the canonical loopback API port).
  const localLlmInvocation = `POST the diff to PortOS's local reviewer endpoint: \`gh pr diff ${prNumber || '<PR_NUMBER>'} | jq -Rs '{ backend: "<lmstudio|ollama>", diff: . }' | curl -sS -X POST http://localhost:5555/api/code-review/local -H 'Content-Type: application/json' -d @-\`. Substitute the active reviewer name for \`<lmstudio|ollama>\`. The response \`.findings\` field is the review text — treat it like any other reviewer's findings.`;
  // Instruct the agent to request each username reviewer as a PR reviewer and
  // gate the merge on their approval. `gh pr edit --add-reviewer` takes the bare
  // login, so strip the `@`.
  const githubUsersInvocation = `request ${usernames.map(u => `\`@${u}\``).join(', ')} as PR reviewer${usernames.length > 1 ? 's' : ''} (\`gh pr edit ${prNumber || '<PR_NUMBER>'} --add-reviewer <user>\`, drop the \`@\`), then wait for their review (poll every 5–15s) and address any findings; their approval gates the merge.`;
  const multiBullets = [
    hasCopilot ? `**copilot**: ${copilotIsFirst
      ? 'wait for the initial Copilot review the system already pre-requested (Copilot leads the list)'
      : 'request a Copilot review when you reach its turn'} (poll every 5–15s, max 5 min/round), then re-request on later rounds.` : null,
    hasCli ? `**codex / antigravity / claude / grok**: invoke that CLI to review this branch's diff against its base (use the CLI's own base-diff mode or \`git diff <base-branch>...HEAD\`; on GitHub \`gh pr diff ${prNumber || ''}\` also works).${reviewerModelNote}` : null,
    hasLocalLlm ? `**lmstudio / ollama**: ${localLlmInvocation}` : null,
    hasGithubUser ? `**@github reviewers**: ${githubUsersInvocation}` : null,
  ].filter(Boolean).join(' ');
  const singleCliInvocation = `Invoke the ${reviewerLabel} CLI to review this branch's diff against its base (use the CLI's own base-diff mode or \`git diff <base-branch>...HEAD\`; on GitHub \`gh pr diff ${prNumber || ''}\` also works). Capture its findings as concrete issues to address.${reviewerModelNote}`;
  // Resolved sequentially so a future reviewer kind only adds one branch
  // instead of deepening the nested ternary.
  let waitOrInvokeStep;
  if (multi) waitOrInvokeStep = `For EACH reviewer in order — ${reviewerLabel} — run a full review-and-fix sub-loop before advancing to the next. ${multiBullets}`;
  else if (hasCopilot) waitOrInvokeStep = 'Wait for the latest Copilot review to complete (poll every 5–15s, max 5 minutes per round); the system already requested the initial review.';
  else if (hasLocalLlm) waitOrInvokeStep = localLlmInvocation;
  else if (hasCli) waitOrInvokeStep = singleCliInvocation;
  else waitOrInvokeStep = `To obtain a review, ${githubUsersInvocation}`;

  const stopModeNote = stopMode === 'on-findings'
    ? '**Stop mode (on-findings):** stop after the FIRST reviewer whose findings you actually fixed and committed; skip the remaining reviewers.'
    : stopMode === 'on-clean'
      ? '**Stop mode (on-clean):** stop after the FIRST reviewer that reports zero findings; skip the remaining reviewers.'
      : (multi ? '**Stop mode (all):** run every reviewer in the list, in order, before merging.' : '');

  const applyNote = hasCli
    ? (reviewerApplies
        ? '**Reviewer applies:** let each CLI reviewer apply its own fixes to the working tree, then verify, run tests, and push.'
        : "**Reviewer applies (off):** read each CLI reviewer's findings and apply the fixes yourself (default).")
    : '';

  const initialReviewState = (hasCopilot && copilotIsFirst)
    ? 'The system has already requested the initial Copilot code review (Copilot leads the order).'
    : hasCopilot
      ? 'Copilot is configured after another reviewer, so the system did NOT pre-request it — request the Copilot review yourself when you reach its turn (after the earlier reviewers’ fixes are pushed), and invoke the other reviewers yourself.'
      : 'The system did NOT pre-request a reviewer because no Copilot review leads the order — you must request/invoke each configured reviewer yourself against the PR diff.';
  const repeatedCommentsNote = '**Repeated comments:** If a fresh review round only re-raises feedback you intentionally rejected (with a reply explaining why), treat that round as clean and move on.';
  // Challenge protocol (#2471): auto-invoke the bounded worker↔reviewer dispute
  // from the review loop. When a reviewer's BLOCKING finding is a false positive,
  // the agent disputes it once via POST /challenge instead of silently complying
  // or accepting a false block, then RE-CHECKS (re-run reviewer) to overturn or
  // escalate. One challenge per task, also bounded by the task's retry budget —
  // a second dispute or an out-of-retries task returns 409.
  const challengeProtocolNote = [
    '**Challenge protocol (dispute a wrong rejection — use sparingly):** If a reviewer raises a BLOCKING finding you have strong, specific evidence is a false positive (it misread the diff, flagged intended behavior, or contradicts a documented repo convention), do NOT silently "fix" it or accept a false block — dispute it **exactly once** for this task:',
    '```bash',
    `curl -sS -X POST http://localhost:5555/api/cos/tasks/${sourceTaskId}/challenge -H 'Content-Type: application/json' -d '{"reason":"<why the finding is wrong>","evidence":"<file:line or diff quote>","reviewer":"<disputed reviewer>"}'`,
    '```',
    'A `409` (`CHALLENGE_EXHAUSTED` = the one challenge is spent, or `CHALLENGE_BUDGET_EXHAUSTED` = the task is out of retry budget) means you can\'t dispute — then fix the finding or, if genuinely blocked, post a PR comment and stop. After filing, RE-CHECK: re-run the disputed reviewer (or another configured reviewer) against the current diff, then resolve — overturned → `POST .../challenge/resolve` with `{"outcome":"upheld"}` and continue to merge; confirmed → fix it, or send `{"outcome":"escalated"}` to hand the dispute to the user.' + (hasLocalLlm ? ' For a local reviewer you may instead POST `{"recheck":{"backend":"<lmstudio|ollama>","diff":"<unified diff>"}}` and let the server re-run it and auto-derive the outcome.' : ''),
  ].join('\n');
  const extraNotes = [stopModeNote, applyNote].filter(Boolean);

  if (verbose) {
    return `
## Review-Loop Follow-up (PRIMARY OBJECTIVE)
A previous agent finished implementing the work for source task **${sourceTaskId}** and opened **PR ${prUrl}** on branch \`${prBranch}\`. ${initialReviewState} **Your job is to drive the review-and-fix loop to completion and merge the PR.**

**Reviewers (in order)**: ${reviewerLabel}${equiv}.
${extraNotes.length ? '\n' + extraNotes.join('\n') + '\n' : ''}
**Run this loop UNTIL all configured reviewers are satisfied (or the stop mode triggers), capped at 10 iterations per reviewer:**

1. ${waitOrInvokeStep}
2. If there are unresolved review findings, fix them in this worktree, run the project's tests, commit (\`feat:\`/\`fix:\` prefix, no Co-Authored-By), push, and (for Copilot) resolve the addressed threads.
3. Re-review with the same reviewer until it reports clean, then advance to the next reviewer in the list.
4. When the reviewer list is exhausted (or the stop mode triggers), merge the PR **immediately** with this exact command (flags: \`--merge --delete-branch\`, nothing else — a true merge commit keeps the branch tip in main's history so automated worktree cleanup can prove the branch is merged):
   \`\`\`bash
   gh pr merge "${prUrl}" --merge --delete-branch
   \`\`\`
   ${prOwner && prRepo && prNumber ? `(Equivalent: \`gh pr merge ${prNumber} --repo ${prOwner}/${prRepo} --merge --delete-branch\`.)` : ''}
   You have already verified the review is clean, so force the immediate merge. Adding any merge-deferral flag would leave the PR open after you exit.
5. Confirm the PR is actually merged before exiting: \`gh pr view "${prUrl}" --json state -q .state\` must return \`MERGED\`. If it returns \`OPEN\` or \`CLOSED\`, investigate (a check is failing, a thread is still unresolved, or branch protection is blocking) — fix and retry the merge. Do NOT exit until state is \`MERGED\`.
6. Exit. Do **not** run \`/do:push\` or open a new PR — the merge handles everything. The system will clean up your worktree on exit.

**Hard stop:** if a reviewer's loop hasn't converged after 10 iterations, post a PR comment summarising the unresolved blockers and exit. Do not loop indefinitely.

${repeatedCommentsNote}

${challengeProtocolNote}

PR Details:
- **URL**: ${prUrl}
- **Branch**: \`${prBranch}\`
${prNumber !== '' ? `- **Number**: ${prNumber}` : ''}
${prOwner && prRepo ? `- **Repo**: ${prOwner}/${prRepo}` : ''}
- **Source task**: ${sourceTaskId}
- **Reviewers**: ${reviewerLabel}
${rprBody ? `\n### /do:rpr Reference (full procedure)\n\nWhen following the procedure below, run it once per reviewer in the list (${reviewerLabel}); substitute the active reviewer for any reference to Copilot — the loop structure is the same but the reviewer source differs.\n\n${rprBody}\n` : ''}`;
  }

  // Compact light-path variant.
  return [
    '## Review-Loop Follow-up (PRIMARY OBJECTIVE)',
    `A previous agent finished task **${sourceTaskId}** and opened **PR ${prUrl}** on \`${prBranch}\`. ${initialReviewState} Drive the review-and-fix loop to completion and merge.`,
    `**Reviewers (in order)**: ${reviewerLabel}${equiv}.`,
    ...extraNotes,
    '',
    '**Loop UNTIL all reviewers are satisfied (or the stop mode triggers), capped at 10 iterations per reviewer:**',
    `1. ${waitOrInvokeStep}`,
    '2. If unresolved findings: fix in this worktree, run tests, commit (`feat:`/`fix:` prefix, no Co-Authored-By), push' + (hasCopilot ? ', and (for Copilot) resolve the addressed threads.' : '.'),
    '3. Re-review with the same reviewer until clean, then advance to the next reviewer in the list.',
    '4. When the list is exhausted (or the stop mode triggers), merge **immediately** with this exact command (flags: `--merge --delete-branch`, nothing else — a true merge commit keeps the branch tip in main\'s history so automated worktree cleanup can prove the branch is merged):',
    '   ```bash',
    `   gh pr merge "${prUrl}" --merge --delete-branch`,
    '   ```',
    prOwner && prRepo && prNumber ? `   (Equivalent: \`gh pr merge ${prNumber} --repo ${prOwner}/${prRepo} --merge --delete-branch\`.)` : null,
    '   You have already verified the review is clean, so force the immediate merge. Adding any merge-deferral flag would leave the PR open after you exit.',
    `5. Confirm the merge happened before exiting: \`gh pr view "${prUrl}" --json state -q .state\` must return \`MERGED\`. If it returns \`OPEN\` or \`CLOSED\`, investigate (failing check, unresolved thread, branch protection) — fix and retry. Do NOT exit until state is \`MERGED\`.`,
    '6. Exit — do NOT run `/do:push` or open a new PR.',
    '',
    '**Hard stop:** if a reviewer is not converged after 10 rounds, post a PR comment summarising blockers and exit.',
    repeatedCommentsNote,
    '',
    challengeProtocolNote
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
 * @param {boolean} [opts.slashdoFree] - TUI without slashdo (OpenCode): the bullet
 *   points at the manual git/gh Completion Workflow instead of a `/do:*` command.
 * @param {Object|null} opts.worktreeInfo
 * @param {boolean} opts.willOpenPR
 * @param {boolean} opts.willReviewLoop
 * @returns {string|null}
 */
export function buildCompletionGuidelineBullet({
  isReadOnly, isTui, tuiCompletionCommand, slashdoFree = false,
  worktreeInfo, willOpenPR, willReviewLoop, discardWorktree = false,
}) {
  if (discardWorktree) {
    return '**This is a reasoning-only task.** The worktree is discarded on exit — do NOT commit, push, merge, or open a PR. Write your result to the completion sentinel (see the Completion section) and stop.';
  }
  if (isReadOnly) {
    return '**This is a read-only task.** Do NOT commit, push, or modify any files in the repository. Only read data and generate reports.';
  }
  if (isTui) {
    // NOTE: in production this branch is only reachable from the full/api prompt
    // path, where `isTui` is currently always false (TUI providers route through
    // buildLightContextPrompt, which emits the live TUI completion via
    // buildTuiCompletionSection — not this bullet). It's kept provider-aware and
    // directly unit-tested so the guideline stays correct if that routing changes.
    const howTo = slashdoFree
      ? 'the Completion Workflow above (plain `git`/`gh` commands — this provider has no slashdo commands)'
      : `the Completion Workflow above (\`${tuiCompletionCommand}\`)`;
    return `On successful completion, YOU run ${howTo}, then write the sentinel and stop — PortOS closes the session once it sees the sentinel; do NOT run \`/quit\`.`;
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

// One-line worktree note for a discard (reasoning-only) task, replacing the
// "commit / push / auto-merge" guidance the normal worktree section emits. The
// worktree exists only so the reasoner can make scratch edits without touching
// the real tree — cleanup discards it with no commit/merge/PR (see
// `discardWorktree` in agentWorktreeCleanup.js).
const DISCARD_WORKTREE_NOTE = 'Do NOT commit, push, or open a PR — this worktree is discarded on exit. Make any scratch edits that help you reason; only the completion sentinel is kept.';

/**
 * Completion block for a **programmatic-output** (throwaway-worktree) task: the
 * agent reasons in a worktree that is discarded on exit, so it must NOT commit,
 * push, merge, or open a PR. Its only channel out is the `.agent-done` sentinel,
 * whose exact payload shape is specified by the task instructions (a task-type
 * output hook — see `taskTypeHooks.js` / `layeredIntelligenceHooks.js`). This
 * replaces the normal `/do:push`+markdown-sentinel completion workflow, which
 * would tell the agent to push code (defeating the discard guarantee) and write
 * a markdown summary (breaking the hook's structured-JSON sentinel contract).
 */
export function buildProgrammaticOutputCompletionSection(sentinelPath) {
  return [
    '## Completion (Reasoning-Only Task)',
    'This is a reasoning task, not a code change. The worktree you are in is **discarded on exit** — any commits, pushes, or PRs are thrown away and have no effect. Do NOT run `/do:push`, `/do:pr`, `git commit`, `git push`, or open a pull request.',
    '',
    `When you have finished reasoning, write your result to \`${sentinelPath}\` in the exact payload format described in your task instructions, then stop. PortOS polls this sentinel every 2s, finalizes the run, and closes the session for you — do NOT run \`/quit\` and do NOT wait for anything after writing the sentinel.`
  ].join('\n');
}

/**
 * Completion block for a **read-only** task (e.g. reference-watch, pr-reviewer's
 * scan stage). The agent must NOT commit/push/modify source; its real output is
 * recorded elsewhere DURING the run (a tracker issue, PLAN.md, a report).
 *
 * A TUI agent still needs a `.agent-done` sentinel to signal completion — the 2s
 * sentinel poll in `spawnTuiAgent` is the primary finalize path and the channel
 * that ingests the run summary. Without it a read-only TUI run only finalizes via
 * the idle reaper / shell-exit fallback, so the resolution summary is never
 * captured cleanly (the bug this repairs). CLI/API read-only agents complete on
 * process exit and never poll a sentinel, so they get the bare notice only.
 */
export function buildReadOnlyCompletionSection({ isTui = false, sentinelPath = null } = {}) {
  const notice = '## Read-Only Task\nDo NOT commit, push, or modify any files. Read data and report findings only.';
  if (!isTui || !sentinelPath) return notice;
  return [
    notice,
    '',
    `When you have finished, write a short markdown summary of what you found (and where you recorded it) to \`${sentinelPath}\`, then stop. PortOS polls this sentinel every 2s, finalizes the run, and closes the session for you — do NOT run \`/quit\` and do NOT wait for anything after writing the sentinel.`
  ].join('\n');
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
 * @param {string} [options.providerCommand] - Provider launch command (e.g. `'opencode'`).
 *   Used to detect a slashdo-free TUI (OpenCode): such a TUI can't run `/do:pr` / `/do:push`,
 *   so its completion workflow falls back to plain `git`/`gh` commands.
 * @param {boolean} [options.leanMode] - Ollama-backed Claude session launched with
 *   `--bare` (see `applyLeanClaudeArgs`): the completion workflow drops slashdo
 *   commands (bare mode skips command discovery) in favor of plain `git`/`gh`.
 * @param {boolean} [options.split] - Light path only: return
 *   `{ userPrompt, systemPrompt }` (see `buildLightContextPromptParts`) instead
 *   of a single string, for providers spawned with `--append-system-prompt-file`.
 *   Ignored on the full/api path, which always returns a string.
 */
export async function buildAgentPrompt(task, config, workspaceDir, worktreeInfo = null, isTruthyMetaFn = (v) => v === true || v === 'true', options = {}) {
  // Undo the queue-path description/context split so a round-tripped generated
  // prompt (swarm, scheduled claim-work, other system tasks) renders once
  // instead of double-printing its first line under a `### Context` header.
  // Feeds both the briefing template (via the reconciled `task` object) and the
  // full-path fallback below.
  task = reconcileSplitContext(task);
  const providerType = options.providerType || PROVIDER_TYPES.API;
  const providerId = options.providerId || null;
  const providerCommand = options.providerCommand || null;
  const isTui = providerType === PROVIDER_TYPES.TUI;

  if (LIGHT_CONTEXT_PROVIDER_TYPES.has(providerType)) {
    const lightOptions = { isTui, providerId, providerCommand, leanMode: options.leanMode === true };
    return options.split === true
      ? buildLightContextPromptParts(task, workspaceDir, worktreeInfo, isTruthyMetaFn, lightOptions)
      : buildLightContextPrompt(task, workspaceDir, worktreeInfo, isTruthyMetaFn, lightOptions);
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
    getDigitalTwinForPrompt({ maxTokens: config.digitalTwin?.maxContextTokens || config.soul?.maxContextTokens || 2000, personaId: 'active' })
      .catch(err => { console.log(`⚠️ Digital twin context retrieval failed: ${err.message}`); return null; })
  ]);

  // Build context compaction section if task is retrying after a context-limit failure
  const compactionSection = task.metadata?.compaction?.needed ? buildCompactionSection(task) : '';

  // Build worktree context section if applicable
  const willOpenPR = isTruthyMetaFn(task.metadata?.openPR);
  const willReviewLoop = isTruthyMetaFn(task.metadata?.reviewLoop);
  // A discard (reasoning-only) worktree: the agent reasons in it but it's thrown
  // away on exit with no commit/merge/PR (see agentWorktreeCleanup.js). Suppresses
  // all commit/push/PR completion guidance in favor of the sentinel-only contract.
  const discardWorktree = isTruthyMetaFn(task.metadata?.discardWorktree);
  const isWorktreeOnExistingBranch = worktreeInfo?.existingBranch === true;
  const worktreeSection = worktreeInfo ? `
## Git Worktree Context
You are working in an **isolated git worktree** to avoid conflicts with other agents working concurrently.
- **Branch**: \`${worktreeInfo.branchName}\`${isWorktreeOnExistingBranch ? ' *(pre-existing PR branch)*' : ''}
- **Worktree Path**: \`${worktreeInfo.worktreePath}\`
${worktreeInfo.baseBranch ? `- **Based on**: \`${worktreeInfo.baseBranch}\` (latest from origin)` : ''}

**Important**: ${discardWorktree
    ? DISCARD_WORKTREE_NOTE
    : isTui
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
  // `/simplify` is a Claude Code built-in slash command — only Claude providers
  // can run it. Everyone else (API/CLI) gets the inline equivalent describing the
  // same reuse/quality/efficiency self-review so the pass still happens.
  const canRunSlashCommands = providerId === 'claude-code' || providerId === 'claude-code-bedrock';
  const simplifyInstruction = canRunSlashCommands
    ? 'run `/simplify` to review the changed code for reuse, quality, and efficiency'
    : SIMPLIFY_INLINE_REVIEW;
  // Discard tasks don't commit, so the simplify-before-commit step is moot.
  const simplifySection = simplifyEnabled && !isTui && !discardWorktree ? `
## Simplify Step
After completing your work and before committing, ${simplifyInstruction}. Fix any issues found, then ${worktreeInfo && willOpenPR ? 'commit your changes (do NOT push — on a successful run the system will push and open the PR after you exit; if the run fails, no push or PR happens)' : 'commit and push using `/do:push`'}.
` : '';

  // Resolve the user's ordered reviewer list + flags (default `[copilot]`). Declared
  // up here so the TUI completion block can thread `--review-with …` into `/do:pr`.
  const taskReviewers = normalizeReviewers(task.metadata);
  const taskReviewerUsernames = normalizeReviewUsernames(task.metadata?.usernames);
  const taskReviewStopMode = task.metadata?.reviewStopMode || DEFAULT_REVIEW_STOP_MODE;
  const taskReviewerApplies = isTruthyMetaFn(task.metadata?.reviewerApplies);

  // TUI completion section — delegate to the shared light-path builder so
  // both prompt paths emit byte-identical workflows. (Background: TUI owns
  // its own `/simplify` → `/do:pr|/do:push` → sentinel sequence because the
  // slashdo submodule mounts those commands at project level. Writing the
  // sentinel is the done signal — PortOS finalizes via the 2s poll and kills
  // the session, so the prompt does NOT ask the agent to `/quit` (it's a UI
  // command the agent can't invoke). See `buildTuiCompletionSection` below.)
  const tuiCompletionCommand = willOpenPR ? '/do:pr' : '/do:push';
  const sentinelPath = `${worktreeInfo?.worktreePath || workspaceDir}/.agent-done`;
  // A discard task's completion is the sentinel-only contract (no push/PR/merge),
  // and this applies to every provider type — so it wins over the isTui fork and
  // over the fallback template's commit/push instructions below.
  const tuiCompletionSection = discardWorktree
    ? buildProgrammaticOutputCompletionSection(sentinelPath)
    : isTui
      ? buildTuiCompletionSection({
          willOpenPR, willReviewLoop, simplifyEnabled, providerId,
          sentinelPath,
          reviewers: taskReviewers,
          usernames: taskReviewerUsernames,
          reviewStopMode: taskReviewStopMode,
          reviewerApplies: taskReviewerApplies
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
After your task completes, the system will spawn a follow-up agent that runs the review-and-fix loop until all configured reviewers are satisfied, then merges the PR. The follow-up uses **${taskReviewers.join(' → ')}** (in order). ${taskReviewers[0] === DEFAULT_REVIEWER
    ? 'Copilot leads the list, so for GitHub PRs the system pre-requests its initial review automatically (skipped on GitLab MRs and other non-GitHub forges); the follow-up then drives the rest of the chain.'
    : taskReviewers.includes(DEFAULT_REVIEWER)
      ? 'The follow-up invokes the CLI reviewers itself and requests Copilot at its turn (Copilot is GitHub-only, so it is skipped on non-GitHub forges).'
      : 'The follow-up agent will invoke the configured CLI reviewers directly to critique the PR diff, then iterate on their feedback.'} You do not need to open the PR, trigger the review, or address feedback yourself — focus on producing high-quality, well-tested code so the review passes go cleanly.
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
  // Precomputed display label for the stock "Target Application" heading in the
  // cos-agent-briefing template. Mirrors buildTaskBlock's predicate: suppress
  // the redundant heading for the PortOS default app (empty string → the
  // template section is falsy and renders nothing), surface the app id for
  // managed apps. `task.metadata.app` stays in the context for any custom
  // template references — only the stock heading gates on this.
  const briefingApp = task.metadata?.app;
  const targetAppLabel = briefingApp && briefingApp !== PORTOS_APP_ID ? briefingApp : '';
  const promptData = isReviewLoopFollowUp ? null : await buildPrompt('cos-agent-briefing', {
    task,
    targetAppLabel,
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
    return `${promptData.prompt}\n\n${PM2_SAFETY_RULE}`;
  }

  const taskBlock = buildTaskBlock(task, { screenshotsAsList: false });

  // Fallback to built-in template
  return `${claudeMdSection || ''}

${memorySection || ''}

${taskBlock.description}
${task.metadata?.context ? (task.metadata.context.includes('\n') ? `\n### Task Context\n\n${task.metadata.context.trimEnd()}\n` : `\n### Task Context\n\n${task.metadata.context}\n`) : ''}
${taskBlock.targetApp}
${taskBlock.screenshots}
${taskBlock.attachments}
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
4. ${discardWorktree
  ? 'Write your result to the completion sentinel (see the Completion section above) — do NOT commit, push, or open a PR; this worktree is discarded on exit'
  : isTui
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
    isTui, tuiCompletionCommand, slashdoFree: isTui && isOpencodeCommand(providerCommand),
    worktreeInfo, willOpenPR, willReviewLoop, discardWorktree,
  });
  return bullet ? `- ${bullet}` : '';
})()}

## Git Hygiene (CRITICAL)
- **Before starting work**, run \`git status\` to verify a clean working tree. Do NOT stash or discard uncommitted changes — other agents may be working concurrently and expecting those changes to be present. If the tree is dirty, only commit files YOU changed for this task.
- **NEVER use \`git stash\`** in any form (\`git stash push\`, \`git stash pop\`, etc.). This is a multi-agent system — stashing can silently destroy or corrupt another agent's or the user's in-progress work. Work around uncommitted changes instead. (Note: the backend may use \`--autostash\` in user-triggered pull operations — that is safe because those are single-user UI actions, not concurrent agent operations.)
- **Only commit files YOU changed** for this task. Never use \`git add -A\` or \`git add .\` — always stage specific files by name.
${discardWorktree
  ? `- **Do NOT commit, push, or open a PR.** This worktree is discarded on exit — your only output is the completion sentinel (see the Completion section above).`
  : isTui
    ? `- **Use \`${tuiCompletionCommand}\` to ${willOpenPR ? 'commit, push, and open the PR' : 'commit and push the branch'}** — see the Completion Workflow section above. Stage specific files (no \`git add -A\`), use \`feat:\`/\`fix:\`/\`breaking:\` prefix in the commit message, no Co-Authored-By annotations.`
    : worktreeInfo && willOpenPR
      ? `- **Commit only — do NOT push.** Stage specific files, use \`feat:\`/\`fix:\`/\`breaking:\` prefix in the commit message, no Co-Authored-By annotations. The system will push your branch and open the PR after you exit, so do NOT run \`git push\` or \`/do:push\` yourself.`
      : `- **Commit and push using \`/do:push\`** — this handles changelog updates, staging specific files, writing a conventional commit message, and pushing safely. If \`/do:push\` is unavailable, follow its conventions manually: stage specific files, use \`feat:\`/\`fix:\`/\`breaking:\` prefix, no Co-Authored-By annotations, and push with \`git pull --rebase && git push\`.`}
${discardWorktree ? '' : worktreeInfo ? `- **Your PR should contain only your task's commits.** If you see unrelated commits in your branch history, something is wrong — do not open a PR with other agents' work.` : `- **Commit directly to the current branch.** Do NOT create feature branches or PRs unless explicitly instructed.`}

## Working Directory
${task.metadata?.app ? `You are working in the target app directory: \`${workspaceDir}\`. All code changes, research, plans, and docs for this task belong in this directory — NOT in the PortOS repo.` : 'You are working in the project directory.'} Use the available tools to explore, modify, and test code.

${PM2_SAFETY_RULE}

Begin working on the task now.`;
}

/**
 * Build the **light-context** prompt for agents that have native filesystem
 * tools and CLAUDE.md loading (Claude Code, Codex, Antigravity — `tui` or `cli`).
 *
 * The agent already has direct access to the project, so we don't paste in:
 *   memory dumps, CLAUDE.md contents, digital twin, tools summary,
 *   `.planning/` snippets, auto-matched skill templates, or compaction
 *   warnings. We just hand it the task, any user-attached context/screenshots/attachments,
 *   and the PortOS-specific contract bits it can't infer (worktree branch,
 *   JIRA ticket, pipeline predecessors, completion-sentinel protocol,
 *   review-loop follow-up procedure).
 *
 * Falls back gracefully when worktree/jira/pipeline metadata is absent — only
 * the present sections render.
 */
export function buildLightContextPrompt(task, workspaceDir, worktreeInfo, isTruthyMetaFn, options = {}) {
  const { taskSections, contractSections } = buildLightContextSections(task, workspaceDir, worktreeInfo, isTruthyMetaFn, options);
  return [...taskSections, ...contractSections, BEGIN_WORKING_LINE].join('\n\n') + '\n';
}

/**
 * Split variant of `buildLightContextPrompt` for providers with a real system
 * channel (Claude Code's `--append-system-prompt-file`): the task-specific
 * content (description, context, screenshots, attachments) becomes the user
 * prompt, and the PortOS operating contract (worktree/pipeline/JIRA
 * coordinates + completion workflow) rides in the system prompt where models
 * weight it as instructions rather than conversation. Section content is
 * byte-identical to the combined prompt — only the placement differs.
 *
 * @returns {{ userPrompt: string, systemPrompt: string|null }}
 */
export function buildLightContextPromptParts(task, workspaceDir, worktreeInfo, isTruthyMetaFn, options = {}) {
  const { taskSections, contractSections } = buildLightContextSections(task, workspaceDir, worktreeInfo, isTruthyMetaFn, options);
  return {
    userPrompt: [...taskSections, BEGIN_WORKING_LINE].join('\n\n') + '\n',
    systemPrompt: contractSections.length ? contractSections.join('\n\n') + '\n' : null,
  };
}

const BEGIN_WORKING_LINE = 'Begin working on the task now.';

function buildLightContextSections(task, workspaceDir, worktreeInfo, isTruthyMetaFn, { isTui = true, providerId = null, providerCommand = null, leanMode = false } = {}) {
  // Idempotent with the reconcile in buildAgentPrompt; also protects the
  // directly-exported buildLightContextPrompt/Parts entry points.
  task = reconcileSplitContext(task);
  const willOpenPR = isTruthyMetaFn(task.metadata?.openPR);
  const willReviewLoop = isTruthyMetaFn(task.metadata?.reviewLoop);
  const simplifyEnabled = isTruthyMetaFn(task.metadata?.simplify);
  const isReadOnly = isTruthyMetaFn(task.metadata?.readOnly);
  const discardWorktree = isTruthyMetaFn(task.metadata?.discardWorktree);
  const isReviewLoopFollowUp = isTruthyMetaFn(task.metadata?.reviewLoopFollowUp);
  const isWorktreeOnExistingBranch = worktreeInfo?.existingBranch === true;
  // Ordered reviewer list + flags for the Review Loop (default `[copilot]`).
  // Flows as `/do:pr --review-with a,b,c [--review-stop-on-*] [--reviewer-applies]`.
  const lightReviewers = normalizeReviewers(task.metadata);
  const lightReviewerUsernames = normalizeReviewUsernames(task.metadata?.usernames);
  const lightReviewStopMode = task.metadata?.reviewStopMode || DEFAULT_REVIEW_STOP_MODE;
  const lightReviewerApplies = isTruthyMetaFn(task.metadata?.reviewerApplies);
  // Claude Code CLI providers can drive `/simplify` + `/do:pr` themselves
  // (the slashdo submodule mounts those as project-level slash commands).
  // Other CLI providers (codex, antigravity) can't — they get the legacy
  // commit-only block where PortOS handles push+PR on exit.
  const hasSlashdo = !isTui && (providerId === 'claude-code' || providerId === 'claude-code-bedrock');
  // A TUI that does NOT load Claude Code slash commands can't run `/do:pr` /
  // `/do:push`, so its completion workflow uses plain git/gh instead. Two ways
  // to land here: an OpenCode TUI (keyed on the launch command, not the id, so
  // a path-configured or renamed OpenCode provider is still recognised —
  // mirrors the arg-builder gate), or a lean-mode Claude session (`--bare`
  // skips project command discovery, and the small local models lean mode
  // targets fumble multi-step slashdo flows anyway).
  const tuiSlashdoFree = isTui && (isOpencodeCommand(providerCommand) || leanMode);

  const taskSections = [];
  const contractSections = [];
  // Alias preserving the original single-list flow below: task-block pushes go
  // to `taskSections`, then `sections` is repointed at `contractSections` for
  // the operating-contract blocks.
  let sections = taskSections;

  // --- Task block --------------------------------------------------------
  // cwd is set by the spawner and the agent knows its own id from the
  // runner, so the prompt skips that metadata. Target app is kept only for
  // MANAGED apps because it scopes cross-repo work; the PortOS default app is
  // suppressed in buildTaskBlock since cwd already reveals it. Shared with the
  // full path via buildTaskBlock.
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
  if (taskBlock.attachments) sections.push(taskBlock.attachments);

  // Everything below is the PortOS operating contract (not task content) —
  // route it to `contractSections` so the split path can lift it into the
  // system prompt.
  sections = contractSections;

  // --- Worktree ----------------------------------------------------------
  if (worktreeInfo) {
    sections.push([
      '## Git Worktree',
      `- **Branch**: \`${worktreeInfo.branchName}\`${isWorktreeOnExistingBranch ? ' *(pre-existing PR branch)*' : ''}`,
      `- **Path**: \`${worktreeInfo.worktreePath}\``,
      worktreeInfo.baseBranch ? `- **Based on**: \`${worktreeInfo.baseBranch}\`` : null,
      '',
      worktreeCommitGuidance({ isTui, hasSlashdo, isWorktreeOnExistingBranch, willOpenPR, discardWorktree }),
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
  if (discardWorktree) {
    // Reasoning-only task: the sentinel payload (shape set by the task-type
    // output hook) is the sole output; the worktree is discarded on exit. Wins
    // over the isTui / CLI push-and-PR completion workflows below.
    sections.push(buildProgrammaticOutputCompletionSection(`${worktreeInfo?.worktreePath || workspaceDir}/.agent-done`));
  } else if (isReadOnly) {
    sections.push(buildReadOnlyCompletionSection({
      isTui,
      sentinelPath: `${worktreeInfo?.worktreePath || workspaceDir}/.agent-done`,
    }));
  } else if (isReviewLoopFollowUp) {
    sections.push(buildReviewLoopFollowUpSection(task.metadata || {}, { verbose: false }));
  } else if (isTui) {
    sections.push(buildTuiCompletionSection({
      willOpenPR, willReviewLoop, simplifyEnabled, providerId, slashdoFree: tuiSlashdoFree,
      sentinelPath: `${worktreeInfo?.worktreePath || workspaceDir}/.agent-done`,
      branchName: worktreeInfo?.branchName || null,
      baseBranch: worktreeInfo?.baseBranch || null,
      reviewers: lightReviewers, usernames: lightReviewerUsernames, reviewStopMode: lightReviewStopMode, reviewerApplies: lightReviewerApplies
    }));
  } else {
    sections.push(buildCliCompletionSection({ worktreeInfo, willOpenPR, willReviewLoop, hasSlashdo, simplifyEnabled, reviewers: lightReviewers, usernames: lightReviewerUsernames, reviewStopMode: lightReviewStopMode, reviewerApplies: lightReviewerApplies }));
  }

  return { taskSections, contractSections };
}

/**
 * Worktree commit-guidance helper for the light prompt. Picks the right
 * single-sentence instruction based on whether the agent will run its own
 * push workflow (TUI or Claude Code CLI with slashdo), reuse an existing PR
 * branch (review fixes), or hand off to PortOS's post-exit push.
 */
function worktreeCommitGuidance({ isTui, hasSlashdo, isWorktreeOnExistingBranch, willOpenPR, discardWorktree }) {
  if (discardWorktree) return DISCARD_WORKTREE_NOTE;
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
 * The agent must drive the merge itself — `/do:pr` runs the review loop but
 * exits without merging, so without this step the PR sits open and the branch
 * leaks. Mirrors the merge contract in the review-loop follow-up section so
 * both agent flows converge on the same final state. `reviewers` only colors
 * the wording — the merge step itself is reviewer-agnostic.
 */
function buildPostPRMergeSteps(startStep, { reviewers = DEFAULT_REVIEWERS, usernames = [], reviewStopMode = DEFAULT_REVIEW_STOP_MODE } = {}) {
  // Trailing space when present so the sentence reads "the Copilot review loop"
  // (lone copilot, no usernames) or "the review loop" (multi/CLI/username) —
  // never "the the review loop".
  const reviewerLabel = (reviewers.length === 1 && reviewers[0] === DEFAULT_REVIEWER && usernames.length === 0) ? 'Copilot ' : '';
  // Under an explicit stop-mode, the multi-reviewer loop can exit `partial` (later
  // reviewers intentionally skipped after the short-circuit) — that's a successful
  // outcome the user opted into, so merge on it too. Match the known stop-modes
  // explicitly so an unknown/invalid value falls through to the safe default
  // (only `clean`/`too-large` mergeable).
  const explicitStopMode = reviewStopMode === 'on-findings' || reviewStopMode === 'on-clean';
  const mergeStatuses = explicitStopMode
    ? '`clean`, `partial` (a stop-mode short-circuit you opted into), or `too-large`'
    : '`clean` (or `too-large`)';
  const lines = [
    `${startStep}. **Merge the PR immediately when the ${reviewerLabel}review loop reports ${mergeStatuses}** — \`/do:pr\` opens the PR and runs the review loop but does NOT merge. Capture the PR URL printed by \`/do:pr\` and run the exact command below (flags: \`--merge --delete-branch\`, nothing else — a true merge commit keeps the branch tip in main's history so automated worktree cleanup can prove the branch is merged; any merge-deferral flag leaves the PR open after you exit). Skip the merge if the loop ended \`timeout\`, \`error\`, \`inconclusive\`, or \`guardrail\`; leave the PR open for human follow-up.`,
    '   ```bash',
    '   gh pr merge "<PR_URL>" --merge --delete-branch',
    '   ```',
    `${startStep + 1}. Confirm the merge before exiting: \`gh pr view "<PR_URL>" --json state -q .state\` must return \`MERGED\`. If it returns \`OPEN\` or \`CLOSED\`, investigate (failing check, unresolved thread, branch protection), fix, and retry. Do NOT exit until state is \`MERGED\` (or you have explicitly decided not to merge per the rule above).`
  ];
  return { lines, nextStep: startStep + 2 };
}

/**
 * TUI completion-workflow block. The TUI owns its own commit → push → PR
 * pipeline via slashdo commands and signals "done" with a sentinel file.
 *
 * When `slashdoFree` is set (an OpenCode TUI, which does not load Claude Code
 * slash commands), the agent can't run `/do:pr` / `/do:push`, so it delegates to
 * the plain-git/`gh` variant below — same sentinel handshake, no slashdo.
 */
function buildTuiCompletionSection({ willOpenPR, willReviewLoop, simplifyEnabled, sentinelPath, providerId = null, slashdoFree = false, branchName = null, baseBranch = null, reviewers = DEFAULT_REVIEWERS, usernames = [], reviewStopMode = DEFAULT_REVIEW_STOP_MODE, reviewerApplies = false }) {
  if (slashdoFree) {
    // The manual path never auto-merges (it opens the PR for review), so it
    // doesn't need willReviewLoop — the review gate holds unconditionally.
    return buildManualTuiCompletionSection({ willOpenPR, simplifyEnabled, sentinelPath, branchName, baseBranch });
  }
  const cmd = willOpenPR ? '/do:pr' : '/do:push';
  const reviewUsernames = normalizeReviewUsernames(usernames);
  // `/do:pr` may inherit a saved `review-with` default. Explicitly opt out
  // when the task's Review Loop control is off so that default cannot start a
  // Copilot (or other external) review unexpectedly.
  const reviewArgs = willOpenPR
    ? (willReviewLoop ? buildReviewWithArgs(reviewers, reviewStopMode, reviewerApplies, reviewUsernames) : '--review-with none')
    : '';
  const reviewerArg = reviewArgs ? ` ${reviewArgs}` : '';
  const copilotOnly = reviewers.length === 1 && reviewers[0] === DEFAULT_REVIEWER && reviewUsernames.length === 0;
  const reviewerListLabel = [...reviewers, ...reviewUsernames.map(u => `@${u}`)].join(', ');
  const reviewSuffix = willOpenPR && willReviewLoop
    ? (copilotOnly
        ? ' — `/do:pr` runs the Copilot review loop after the PR opens.'
        : ` — \`/do:pr\` runs the review loop for ${reviewerListLabel} in order after the PR opens.`)
    : (willOpenPR ? ' — external review is disabled for this task.' : '');
  // `/simplify` is a Claude Code TUI built-in. Non-Claude TUI providers
  // (codex-tui, antigravity-tui) can't run it, so give them the inline equivalent.
  // Default (no providerId) stays Claude-shaped for backward compatibility.
  const canRunSimplifyCommand = !providerId || /claude/i.test(providerId);
  const simplifyStep = simplifyEnabled
    ? (canRunSimplifyCommand ? '1. `/simplify`' : `1. Before committing, ${SIMPLIFY_INLINE_REVIEW} and fix any findings.`)
    : '1. (simplify disabled — skip)';
  const sentinelTail = willOpenPR ? '   ## PR\n   <PR URL>' : '   ## Branch\n   <branch name>';
  const merge = willOpenPR && willReviewLoop
    ? buildPostPRMergeSteps(3, { reviewers, usernames: reviewUsernames, reviewStopMode })
    : { lines: [], nextStep: 3 };
  const sentinelStep = merge.nextStep;

  return [
    '## Completion Workflow',
    'When the task is complete, run these in order:',
    '',
    simplifyStep,
    `2. \`${cmd}${reviewerArg}\`${reviewSuffix}`,
    ...merge.lines,
    `${sentinelStep}. Write a short markdown summary (~5–15 lines) to the completion sentinel, then stop — this sentinel is the done signal. PortOS polls it every 2s, finalizes the run, and closes the session for you. Do NOT run \`/quit\` (it's a UI command, not something you can invoke) and do NOT wait for anything after writing the sentinel.`,
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
    '   ```'
  ].join('\n');
}

/**
 * Manual (slashdo-free) TUI completion-workflow block — for an OpenCode TUI that
 * does NOT load Claude Code slash commands and so can't run `/do:pr` / `/do:push`.
 * Drives a plain `git` commit → push → (open PR/MR) → sentinel handshake, so the
 * `.agent-done` signal still fires and the task completes.
 *
 * PortOS forces `openPR:false, skipMerge:true` on TUI worktree cleanup (see
 * agentTuiSpawning.js), so nothing happens after the agent exits — the agent owns
 * the push and the PR itself. It opens the PR/MR for review but does NOT merge:
 * this provider can't drive the reviewer CLIs (no slashdo `/do:pr` review loop)
 * and PortOS runs no post-exit review for a TUI, so auto-merging would ship
 * unreviewed work. A configured reviewer / human reviews and merges. Forge-aware
 * (GitHub `gh` + GitLab `glab`) to match the slashdo path; refs are shell-quoted
 * because a git ref can legally contain shell metacharacters.
 */
function buildManualTuiCompletionSection({ willOpenPR, simplifyEnabled, sentinelPath, branchName = null, baseBranch = null }) {
  const branchRef = shellQuote(branchName || 'HEAD');
  // Pin the PR base to the worktree's base branch when known, so the forge CLI
  // doesn't guess (and a fork install targets the intended branch). `--fill`
  // still supplies title/body from the commits.
  const ghBaseArg = baseBranch ? ` --base ${shellQuote(baseBranch)}` : '';
  const glabBaseArg = baseBranch ? ` --target-branch ${shellQuote(baseBranch)}` : '';
  const simplifyStep = simplifyEnabled
    ? `1. Before committing, ${SIMPLIFY_INLINE_REVIEW} and fix any findings.`
    : '1. (simplify disabled — skip)';
  const sentinelTail = willOpenPR ? '   ## PR\n   <PR URL>' : '   ## Branch\n   <branch name>';

  const lines = [
    '## Completion Workflow',
    'This provider does NOT have slashdo (`/do:*`) commands, so finish the handoff with plain `git` (and your forge\'s CLI). Run these in order:',
    '',
    simplifyStep,
    '2. Stage only the files you changed (never `git add -A` / `git add .`) and commit with a conventional message (`feat:`/`fix:`/`breaking:` prefix, no Co-Authored-By annotations):',
    '',
    '   ```bash',
    '   git add <file> [<file> ...]',
    '   git commit -m "feat: <description>"',
    '   ```',
    '3. Push your branch (it is a fresh worktree branch, so set upstream on first push):',
    '',
    '   ```bash',
    `   git push -u origin ${branchRef}`,
    '   ```',
  ];

  let step = 4;
  if (willOpenPR) {
    lines.push(
      `${step++}. Open a pull/merge request against the base branch using the CLI for this repo's forge (check \`git remote -v\`), and capture the URL it prints. **Leave it open for review — do NOT merge it yourself.** This provider can't run the reviewer loop, and PortOS won't merge it for a TUI task, so a configured reviewer or a human reviews and merges it.`,
      '',
      '   ```bash',
      `   # GitHub:  gh pr create --fill${ghBaseArg}`,
      `   # GitLab:  glab mr create --fill${glabBaseArg}`,
      '   ```',
    );
  }

  lines.push(
    `${step}. Write a short markdown summary (~5–15 lines) to the completion sentinel, then stop — this sentinel is the done signal. PortOS polls it every 2s, finalizes the run, and closes the session for you. Do NOT run \`/quit\` (it's a UI command, not something you can invoke) and do NOT wait for anything after writing the sentinel.`,
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
  );

  return lines.join('\n');
}

/**
 * CLI (non-TUI) completion block.
 *
 * Claude Code CLI agents have slashdo commands available (the submodule
 * mounts them as project-level slash commands), so when `hasSlashdo` is
 * true and a PR is expected, the agent owns the full `/simplify` → `/do:pr`
 * sequence and PortOS skips its post-exit push+PR. Codex/Antigravity and other
 * CLI providers fall through to the legacy commit-only block where PortOS
 * handles push+PR on exit.
 */
function buildCliCompletionSection({ worktreeInfo, willOpenPR, willReviewLoop = false, hasSlashdo = false, simplifyEnabled = false, reviewers = DEFAULT_REVIEWERS, usernames = [], reviewStopMode = DEFAULT_REVIEW_STOP_MODE, reviewerApplies = false }) {
  const reviewUsernames = normalizeReviewUsernames(usernames);
  if (hasSlashdo && worktreeInfo && willOpenPR) {
    const lines = ['## Completion', 'When finished, run these in order:'];
    let step = 1;
    if (simplifyEnabled) {
      lines.push(`${step++}. \`/simplify\` — review the changed code for reuse, quality, and efficiency, and fix any findings.`);
    }
    const reviewArgs = willReviewLoop
      ? buildReviewWithArgs(reviewers, reviewStopMode, reviewerApplies, reviewUsernames)
      : '--review-with none';
    const reviewerArg = reviewArgs ? ` ${reviewArgs}` : '';
    const completionNote = willReviewLoop
      ? ((reviewers.length === 1 && reviewers[0] === DEFAULT_REVIEWER && reviewUsernames.length === 0)
          ? 'and drives the Copilot review loop until clean.'
          : `and drives the review loop for ${[...reviewers, ...reviewUsernames.map(u => `@${u}`)].join(', ')} in order until clean.`)
      : 'with external review disabled.';
    lines.push(`${step++}. \`/do:pr${reviewerArg}\` — commits your changes, pushes the branch, and opens a pull request against the default branch ${completionNote}`);
    const merge = willReviewLoop
      ? buildPostPRMergeSteps(step, { reviewers, usernames: reviewUsernames, reviewStopMode })
      : { lines: [], nextStep: step };
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
  // Non-slashdo CLIs (codex/antigravity) have no `/simplify` command; when the task
  // enabled simplify, inline the equivalent self-review so the quality pass still
  // runs before they commit.
  const simplifyLine = simplifyEnabled
    ? `Before committing, ${SIMPLIFY_INLINE_REVIEW} and fix any findings. `
    : '';
  return `## Completion\n${simplifyLine}${body}`;
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
