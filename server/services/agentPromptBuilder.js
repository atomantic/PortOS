/**
 * Agent Prompt Builder
 *
 * Builds the full agent prompt including memory context, AGENTS.md instructions,
 * digital twin, worktree/pipeline/JIRA sections, skill templates, and tools summary.
 * Also handles JIRA ticket creation and app workspace resolution.
 */

import { join } from 'path';
import { stat } from 'fs/promises';
import { getMemorySection } from './memoryRetriever.js';
import { getDigitalTwinForPrompt } from './digital-twin.js';
import { buildPrompt } from './promptService.js';
import { getToolsSummaryForPrompt } from './tools.js';
import { PATHS, tryReadFile } from '../lib/fileUtils.js';
import { loadSlashdoFile, loadSlashdoLib, writeResolvedSlashdoBody } from '../lib/slashdoLoader.js';
import { DEFAULT_REVIEWER, DEFAULT_REVIEW_STOP_MODE, LOCAL_LLM_REVIEWERS, isCliReviewer, resolveReviewerConfig } from '../lib/validation.js';
import { PROVIDER_TYPES } from '../lib/aiToolkit/constants.js';
import { doneSentinelName } from '../lib/agentSentinel.js';
import { canTypeSlashCommands, SLASHDO_INLINE_BUDGET_CHARS } from '../lib/slashdoInvocation.js';
import { TASK_CONTEXT_KEY, taskContextBlock } from '../lib/cosTaskPrompt.js';
import { PR_COMPLETIONS, leavesPrForHuman, resolvePrCompletion } from '../lib/prDisposition.js';
import { PORTOS_APP_ID } from './apps.js';
import { getCodeReviewDefaults } from './codeReview.js';
import { LIGHT_CONTEXT_PROVIDER_TYPES, SIMPLIFY_INLINE_REVIEW } from './promptSections/constants.js';
import { detectSkillTemplates, getAgentInstructionsContext, loadSkillTemplates } from './promptSections/instructions.js';
import { buildCompactionSection, buildTaskBlock, reconcileSplitContext } from './promptSections/taskContext.js';
import { applySlashdoInvocation } from './promptSections/slashdo.js';
import { manualForgeCli, resolveManualForgeCli } from './promptSections/forge.js';
import {
  DISCARD_WORKTREE_NOTE,
  buildActionOutputCompletionSection,
  buildClaimFlowCompletionSection,
  buildCliCompletionSection,
  buildCompletionGuidelineBullet,
  buildInlineReviewLoopSection,
  NO_CHANGE_AUDIT_GUIDANCE,
  buildProgrammaticOutputCompletionSection,
  buildReadOnlyCompletionSection,
  buildResumeSection,
  buildSentinelWriteSteps,
  buildTuiCompletionSection,
  claimReviewersCsv,
  inlinePrLifecycleSection,
  isPrBranchWorktree,
  worktreeCommitGuidance,
} from './promptSections/completion.js';
import { buildLocalReviewLoopSection, buildReviewLoopFollowUpSection, isMergeOnlyFollowUp, prepareLocalReviewLoopBody } from './promptSections/reviewLifecycle.js';

export {
  detectDomainSkillTemplate,
  detectSkillTemplate,
  detectSkillTemplates,
  getAgentInstructionsContext,
  loadSkillTemplate,
  loadSkillTemplates,
} from './promptSections/instructions.js';
export { buildCompactionSection, buildTaskBlock, reconcileSplitContext } from './promptSections/taskContext.js';
export {
  buildActionOutputCompletionSection,
  buildCompletionGuidelineBullet,
  buildProgrammaticOutputCompletionSection,
  buildReadOnlyCompletionSection,
  buildResumeSection,
  inlinePrLifecycleSection,
} from './promptSections/completion.js';
export { buildReviewLoopFollowUpSection } from './promptSections/reviewLifecycle.js';
export { createJiraTicketForTask, generateJiraTitle, getAppDataForTask, getAppWorkspace } from './promptSections/appContext.js';

const AGENTS_DIR = PATHS.cosAgents;

// Scheduled claim tasks created before the explicit marker was introduced still
// carry their task kind in analysisType. Keep those persisted queue records on
// the claim-owned lifecycle while new/manual tasks use the explicit marker.
const CLAIM_FLOW_TASK_TYPES = new Set([
  'plan-task', 'claim-issue', 'claim-issue-gitlab', 'claim-issue-jira', 'claim-work'
]);

// These scheduled audits inspect a running web UI. Keep their runtime contract
// in the builder rather than only in the default prompt bodies so customized
// prompts and tasks queued before a prompt revision get the same guidance.
export const UI_AUDIT_TASK_TYPES = Object.freeze([
  'accessibility', 'console-errors', 'ui-bugs', 'mobile-responsive', 'ux'
]);
const UI_AUDIT_TASK_TYPE_SET = new Set(UI_AUDIT_TASK_TYPES);

export const UI_AUDIT_RUNTIME_RULE = `## UI Audit Runtime (PortOS local system)
This is an unattended run, but it is not browserless when the target has a web UI. PortOS provides a managed Chromium browser for CoS agents over Chrome DevTools Protocol (CDP). The agent-facing browser bridge is separate from that managed browser: an empty array returned by agent.browsers.list() ([]), getForUrl() returning "No browser is available", or an otherwise unusable agent-browser binding is a provider-bridge failure, not evidence that PortOS's managed Chromium or CDP endpoint is unavailable. Do not skip live UI verification because the provider bridge is empty, unusable, or no human is present.

- Use the available Playwright/browser tools against that PortOS-managed browser when the provider has a working browser bridge; fall back to the configured CDP endpoint from the local shell when the provider has no browser bridge, or when its bridge is empty or unusable.
- When the agent browser bridge is empty or unusable, query the configured PortOS browser health endpoint (usually http://127.0.0.1:5557/health, or its configured healthPort) and the CDP /json/version or /json/list endpoints before stopping. The richer /api/browser/health check may require the instance password; a 401 from that API route is an authentication response, not evidence that PortOS's managed browser is unavailable. A healthy PortOS health/CDP response overrides the provider's "No browser is available" response.
- Reuse the PortOS-managed browser over CDP instead of launching a separate browser. Check the browser status/configuration when needed; the CDP endpoint is local and its port is configurable (the shipped default is 127.0.0.1:5556). For a local smoke check, select a normal type: "page" target from /json/list and attach to its webSocketDebuggerUrl with Node's WebSocket or another installed CDP client; if /json/list is empty, create an about:blank page target with PUT /json/new?about:blank. Navigate the page with Page.navigate, then inspect it with Runtime.evaluate on that same page socket. Do not send Page or Runtime commands to the browser-level socket from /json/version; use Page, Runtime, Log, and Network domains on the page socket for live evidence.
- Treat the target as a running local system: discover its actual UI/API URL and ports from the app configuration, PortOS app/process state, and health endpoints, then inspect scoped server logs when diagnosing console or request failures. Do not guess a URL or treat source-only speculation as a UI finding.
- Capture live evidence (snapshots, console/request results, and observed runtime state) before changing code. Do not stop the UI audit merely because the provider bridge is unavailable. Stop the web-UI portion only after the PortOS health/CDP probes fail or no usable page target can be created, navigated, and inspected; the handoff must name the concrete endpoint, HTTP/process, or WebSocket failure. A provider-only "No browser is available" result is not enough, and a failed CDP probe must not become a source-only UX finding. For a native or source-only target with no web surface, continue the relevant audit without inventing a browser target and record that limitation.`;

export function isUiAuditTask(task) {
  const taskType = task?.metadata?.analysisType
    || task?.metadata?.taskAnalysisType
    || task?.metadata?.selfImprovementType
    || task?.taskType;
  return UI_AUDIT_TASK_TYPE_SET.has(taskType);
}

export function isClaimFlowTask(task, isTruthyMetaFn = (value) => value === true || value === 'true') {
  return isTruthyMetaFn(task?.metadata?.claimFlow)
    || CLAIM_FLOW_TASK_TYPES.has(task?.metadata?.analysisType);
}

/**
 * Absolute path of the completion sentinel this run must write. The spawners'
 * pollers resolve the same per-instance filename from the same helper (see
 * `doneSentinelName`), so the path in the prompt and the path PortOS watches
 * cannot drift apart.
 */
function resolveSentinelPath(worktreeInfo, workspaceDir, agentId) {
  return `${worktreeInfo?.worktreePath || workspaceDir}/${doneSentinelName(agentId)}`;
}

// Appended to every agent briefing. PortOS shares ONE pm2 daemon across many
// apps; an agent restarting "the server" once ran `pm2 kill` and took the whole
// machine (incl. PortOS) down. A PATH shim (server/lib/agentGuard) hard-blocks
// the destructive subcommands, but the prompt rule keeps a well-behaved agent
// from even attempting them.
export const PM2_SAFETY_RULE = `## ⚠️ PM2 Safety (shared server)
PortOS runs MANY apps under one shared pm2 daemon. To restart an app, use a SCOPED command — \`pm2 restart <that-app's-process-name>\`. NEVER run \`pm2 kill\`, \`pm2 stop\`, \`pm2 delete\`, \`pm2 startup\`/\`unstartup\`, or any \`pm2 <verb> all\` form: they take down EVERY app on this machine, including PortOS itself, and are blocked (they will fail).`;

// Also appended to every agent briefing. A CoS agent runs headless: the TUI has
// no human attached, so an interactive selector or approval gate is a dead end —
// the session can sit there indefinitely and the work may never complete.
// Nothing in the briefing used to SAY that, so a `/do:plan-task` run (whose
// skill shows its drafted issue for approval before filing) parked on a scope
// question for its whole life and was retried into the same gate three times,
// filing nothing. The rule names the escape hatch too: slash commands that gate
// on approval take a flag to skip it.
export const UNATTENDED_RUN_RULE = `## ⚠️ Unattended Run (no human is present)
PortOS launched you autonomously. Nobody is watching this session and nothing can answer you — if you present an interactive choice (a multiple-choice question, an approval gate, a "which option?" selector, a confirmation), the session can wait indefinitely and **your work may never complete**.
- **Never ask the user to choose or approve.** Make the call yourself, state the assumption in your summary, and proceed.
- **Invoke commands and skills in their non-interactive form.** If one drafts something and gates on approval before acting, pass the flag that skips that gate (\`--yes\` for the slashdo commands that have one).
- **Ambiguous task?** Pick the most reasonable reading, do the work, and note the alternatives you rejected in your completion summary.
- **Genuinely blocked** (missing credential, contradictory requirements)? Write why to the completion sentinel and stop. Do NOT wait for a reply.`;

/**
 * Build the agent prompt.
 *
 * Two context modes, selected by `options.providerType`:
 *
 * - **Light** (`tui` / `cli`): minimal prompt — task description, attached
 *   context, screenshot paths, worktree/jira/pipeline coordinates, and the
 *   completion-workflow contract. Memory, AGENTS.md, digital twin, tools
 *   summary, planning context, skill templates, and compaction warnings are
 *   deliberately omitted because the agent can fetch them itself.
 * - **Full** (`api`): kitchen-sink prompt with memory + AGENTS.md + digital
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
 * `providerId` + `providerCommand` + `leanMode` together decide whether the
 * session can TYPE a Claude Code slash command (`canTypeSlashCommands`, #3114):
 * a capable session is instructed to drive its own `/simplify` + `/do:pr` /
 * `/do:push`, and everything else gets plain `git`/`gh` (TUI) or PortOS's
 * post-exit push+PR (CLI). `agentCompletionCleanup.js` derives the same predicate
 * from the agent record so it passes `openPR: false` and avoids double-firing.
 *
 * @param {string} [options.providerId] - Provider id (e.g. `'claude-code'`). Not an
 *   allowlist: it only matters when `providerCommand` is blank, where the
 *   spawners' `inferTuiCommand` fallback resolves the command from it.
 * @param {string} [options.providerCommand] - Provider launch command (e.g.
 *   `'claude'`, `'codex'`, `'opencode'`) — the primary signal, so a
 *   path-configured or renamed binary is recognised.
 * @param {string} [options.agentId] - The spawning agent's id. Scopes the
 *   completion sentinel filename to this run (`.agent-done-<agentId>`) so two
 *   worktree-less agents sharing the primary checkout can't overwrite — or
 *   finalize on — each other's done-signal. Omitted → the legacy shared name.
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

  // Feature-agent tasks carry only a compact queue description. Expand the
  // persisted persona briefing at spawn time so scheduled and manually
  // triggered runs share the same feature-specific goals, constraints, branch
  // context, and previous-run history without storing that prompt in the task
  // queue or duplicating it in every task producer.
  if (task.metadata?.featureAgentRun && task.metadata?.featureAgentId) {
    const { getFeatureAgent, buildFeatureAgentPrompt } = await import('./featureAgents.js');
    const featureAgent = await getFeatureAgent(task.metadata.featureAgentId);
    if (featureAgent) {
      const featurePrompt = await buildFeatureAgentPrompt(featureAgent);
      task = { ...task, metadata: { ...task.metadata, prompt: featurePrompt } };
    }
  }
  const providerType = options.providerType || PROVIDER_TYPES.API;
  const providerId = options.providerId || null;
  const providerCommand = options.providerCommand || null;
  const agentId = options.agentId || null;
  const isTui = providerType === PROVIDER_TYPES.TUI;
  const leanMode = options.leanMode === true;

  // Install-wide default reviewer list (Code Review Defaults panel →
  // `settings.codeReview.reviewers`). Threaded as the `normalizeReviewers`
  // fallback so a task that pins no `reviewers` (e.g. every app-improve /
  // self-improvement scheduled task) resolves to the configured default
  // instead of the hardcoded `copilot` — which stalls the review loop on
  // installs without GitHub Copilot review enabled (issue #2507). Unset →
  // `['copilot']` (getCodeReviewDefaults returns the copilot fallback), so
  // behavior is unchanged when nothing is configured. A settings read error
  // degrades to the hardcoded default inside normalizeReviewers.
  //
  // Resolved BEFORE the slashdo section below, which prunes the reviewer
  // variants a run can't reach out of the command body (#3110).
  const codeReviewDefaults = await getCodeReviewDefaults().catch(() => null);
  const defaultReviewers = codeReviewDefaults?.reviewers;

  // Render a slashdo-backed task's invocation now that the provider is known —
  // before the light-path branch below, so both paths carry it. `hasFileTools`
  // is the light/`api` split itself: `cli`/`tui` hosts are agentic CLIs with
  // native file tools (so an over-budget procedure can live on disk), while an
  // HTTP `api` provider has none and must have it pasted (#3110).
  task = await applySlashdoInvocation(task, {
    providerId, providerCommand, leanMode,
    hasFileTools: LIGHT_CONTEXT_PROVIDER_TYPES.has(providerType),
    defaultReviewers, codeReviewDefaults,
  });

  // Preload slashdo's local-agent review-loop recipe once for review-loop
  // follow-up tasks; both the light/TUI path (via lightOptions) and the full
  // path (the verbose builder below) reuse this single value to inline the exact
  // CLI-reviewer invocation. Cheap + cached; only read for follow-ups — and not
  // for a merge-only follow-up, which has no reviewer to invoke and renders a
  // section that ignores this body entirely.
  const isFollowUpNeedingRecipes = isTruthyMetaFn(task.metadata?.reviewLoopFollowUp)
    && !isMergeOnlyFollowUp(task.metadata || {});
  // …and a slashdo-free harness driving its OWN review loop inline needs the
  // identical recipe (`buildInlineReviewLoopSection`). Same predicate the render
  // side uses, so a run whose section never materializes — read-only,
  // leave-open, JIRA, or a merge gate with no reviewer to invoke — doesn't pay
  // for the read and the staging write. The reviewer-list term matters too: the
  // section only inlines the recipe when a SPAWNABLE CLI reviewer resolves, so a
  // copilot-only or username-only list (the default install) would otherwise
  // read + `atomicWrite` 56KB and then render nothing from it.
  const isInlineNeedingRecipes = inlinePrLifecycleSection(task, {
    providerType, providerId, providerCommand, leanMode, worktreeInfo, isTruthyMetaFn,
  }) === 'review-loop'
    && resolveReviewerConfig(task.metadata, codeReviewDefaults, defaultReviewers).reviewers.some(isCliReviewer);
  const localAgentLoopBody = (isFollowUpNeedingRecipes || isInlineNeedingRecipes)
    ? await loadSlashdoLib('local-agent-review-loop').catch(() => null)
    : null;
  const localAgentLoopBodyForInline = (isInlineNeedingRecipes && !isFollowUpNeedingRecipes)
    ? prepareLocalReviewLoopBody(localAgentLoopBody)
    : localAgentLoopBody;
  // The recipe is ~40KB. A follow-up agent inlines it — driving the loop is that
  // agent's entire job, so it will read all of it anyway. An INLINE loop is a
  // later phase of a run whose context is already carrying the actual task, so an
  // over-budget recipe is staged on disk and pointed at instead (#3110's split,
  // applied to the same body). Every host that reaches here has file tools.
  const localAgentLoopBodyPath = (isInlineNeedingRecipes && !isFollowUpNeedingRecipes
    && localAgentLoopBodyForInline && localAgentLoopBodyForInline.length > SLASHDO_INLINE_BUDGET_CHARS)
    ? await writeResolvedSlashdoBody('local-agent-review-loop', localAgentLoopBodyForInline).catch((err) => {
        console.warn(`⚠️ Could not stage the CLI-reviewer recipe, inlining instead: ${err.message}`);
        return null;
      })
    : null;

  if (LIGHT_CONTEXT_PROVIDER_TYPES.has(providerType)) {
    const forgeCli = await resolveManualForgeCli(workspaceDir, worktreeInfo, task);
    const lightOptions = { isTui, providerId, providerCommand, leanMode, agentId, defaultReviewers, codeReviewDefaults, localAgentLoopBody: localAgentLoopBodyForInline, localAgentLoopBodyPath, forgeCli };
    return options.split === true
      ? buildLightContextPromptParts(task, workspaceDir, worktreeInfo, isTruthyMetaFn, lightOptions)
      : buildLightContextPrompt(task, workspaceDir, worktreeInfo, isTruthyMetaFn, lightOptions);
  }

  // Creative Director tasks (scene evaluation, treatment/plan run via API) judge
  // generated content rather than writing PortOS code — shared below by both
  // `skipDevContext` (the repo's instruction files plus memory / digital-twin /
  // onboard-tools are pure noise for that prompt) and `noCodeOutput` (the
  // deliverable is an HTTP PATCH, not a commit).
  const isCreativeDirectorTask = !!task.metadata?.creativeDirector;
  // Full path: API providers read no instruction file natively, so always include it —
  // except for Creative Director tasks, per above. Memory, digital-twin, and the
  // onboard-tools catalog are the same category of dev-oriented noise for a
  // vision/PATCH task (#4650) — CD evaluate uses native Read + HTTP PATCH, and
  // CD plan already receives creative-tool specs via `getToolSpecs()` in its
  // own prompt, not this section.
  const skipDevContext = isCreativeDirectorTask;
  // Fetch independent context sections in parallel
  const [memorySection, agentInstructionsSection, digitalTwinSection] = await Promise.all([
    skipDevContext
      ? Promise.resolve(null)
      : getMemorySection(task, { maxTokens: config.memory?.maxContextTokens || 2000 })
          .catch(err => { console.log(`⚠️ Memory retrieval failed: ${err.message}`); return null; }),
    skipDevContext
      ? Promise.resolve(null)
      : getAgentInstructionsContext(workspaceDir)
          .catch(err => { console.log(`⚠️ Agent instructions retrieval failed: ${err.message}`); return null; }),
    skipDevContext
      ? Promise.resolve(null)
      : getDigitalTwinForPrompt({ maxTokens: config.digitalTwin?.maxContextTokens || config.soul?.maxContextTokens || 2000, personaId: 'active' })
          .catch(err => { console.log(`⚠️ Digital twin context retrieval failed: ${err.message}`); return null; })
  ]);

  // Build context compaction section if task is retrying after a context-limit failure
  const compactionSection = task.metadata?.compaction?.needed ? buildCompactionSection(task) : '';

  // Build worktree context section if applicable
  const willOpenPR = isTruthyMetaFn(task.metadata?.openPR);
  const whenDone = task.metadata?.whenDone === 'commit-push' ? 'commit-push' : 'leave-uncommitted';
  const claimFlow = isClaimFlowTask(task, isTruthyMetaFn);
  const prCompletion = resolvePrCompletion(task.metadata);
  // A discard (reasoning-only) worktree: the agent reasons in it but it's thrown
  // away on exit with no commit/merge/PR (see agentWorktreeCleanup.js). Suppresses
  // all commit/push/PR completion guidance in favor of the sentinel-only contract.
  const discardWorktree = isTruthyMetaFn(task.metadata?.discardWorktree);
  // No-code / API-action task (e.g. Creative Director agents): deliverable is an
  // HTTP PATCH, not a commit — suppress the /do:push completion workflow. Also
  // derive from a CD task's own `creativeDirector` marker so tasks queued as
  // `pending` BEFORE this flag existed (persisted across an upgrade) are still
  // recognized without a metadata migration.
  const noCodeOutput = isTruthyMetaFn(task.metadata?.noCodeOutput) || isCreativeDirectorTask;
  const noChangeSuccess = isTruthyMetaFn(task.metadata?.noChangeSuccess);
  const isWorktreeOnExistingBranch = isPrBranchWorktree(task, worktreeInfo);
  const worktreeCommitNote = worktreeInfo
    ? worktreeCommitGuidance({
        isTui,
        hasSlashdo: false,
        ownsPrWorkflow: false,
        isWorktreeOnExistingBranch,
        willOpenPR,
        discardWorktree,
        claimFlow,
        noChangeSuccess,
      })
    : '';
  const worktreeSection = worktreeInfo ? `
## Git Worktree Context
You are working in an **isolated git worktree** to avoid conflicts with other agents working concurrently.
- **Branch**: \`${worktreeInfo.branchName}\`${isWorktreeOnExistingBranch ? ' *(pre-existing PR branch)*' : ''}
- **Worktree Path**: \`${worktreeInfo.worktreePath}\`
${worktreeInfo.baseBranch ? `- **Based on**: \`${worktreeInfo.baseBranch}\` (latest from origin)` : ''}

**Important**: ${worktreeCommitNote} Do NOT manually switch branches or modify the worktree configuration.
${buildResumeSection(task, worktreeInfo)}` : '';

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
  // `/simplify` is a Claude Code built-in slash command — only a Claude session
  // that loaded its commands can run it. Everyone else (API/CLI) gets the inline
  // equivalent describing the same reuse/quality/efficiency self-review so the
  // pass still happens. Same predicate as the `/do:pr` gates (#3114) — a
  // path-configured `claude` binary qualifies; a lean `--bare` session doesn't.
  // `assumeClaudeWhenUnknown: false` because only HTTP-API providers reach this
  // path (tui/cli return early above): an unidentified API provider is not a
  // latent local `claude` the way a blank CLI/TUI provider is.
  const canRunSlashCommands = canTypeSlashCommands({
    providerId, providerCommand, leanMode, assumeClaudeWhenUnknown: false,
  });
  const simplifyInstruction = canRunSlashCommands
    ? 'run `/simplify` to review the changed code for reuse, quality, and efficiency'
    : SIMPLIFY_INLINE_REVIEW;
  // Discard tasks don't commit, so the simplify-before-commit step is moot.
  const simplifySection = simplifyEnabled && !isTui && !discardWorktree && !claimFlow ? `
## Simplify Step
After completing your work and before committing, ${simplifyInstruction}. Fix any issues found, then ${worktreeInfo && willOpenPR ? 'commit your changes (do NOT push — on a successful run the system will push and open the PR after you exit; if the run fails, no push or PR happens)' : 'commit and push using `/do:push`'}.
` : '';

  // Resolve the user's ordered reviewer list + flags (task metadata wins; else the
  // install's configured Code Review Defaults; else `[copilot]`). Declared up here
  // so the TUI completion block can thread `--review-with …` into `/do:pr`.
  // Thread the install's Code Review Defaults as the fallback for ALL five
  // reviewer fields (not just `reviewers`) with task-over-default precedence —
  // mirroring `resolveReviewLoopOptions` in codeReview.js. #2507 made only the
  // reviewer LIST default-aware on this inline `/do:pr` path (TUI + claude-code
  // agents that own the PR); its four companions (usernames, optionalReviewers,
  // stopMode, reviewerApplies) were still resolved from task metadata alone, so
  // a task pinning no reviewer config would silently drop the configured gating
  // reviewers / stop-mode / reviewer-applies here while the non-PR-owning CLI
  // follow-up path honored them — same defaults, different gating by provider.
  const {
    reviewers: taskReviewers,
    usernames: taskReviewerUsernames,
    optionalReviewers: taskOptionalReviewers,
    reviewerMaxRounds: taskReviewerMaxRounds,
    reviewerModels: taskReviewerModels,
    reviewerEfforts: taskReviewerEfforts
  } = resolveReviewerConfig(task.metadata, codeReviewDefaults, defaultReviewers);
  const taskReviewStopMode = task.metadata?.reviewStopMode || codeReviewDefaults?.stopMode || DEFAULT_REVIEW_STOP_MODE;
  const taskReviewerApplies = task.metadata?.reviewerApplies !== undefined
    ? isTruthyMetaFn(task.metadata?.reviewerApplies)
    : (codeReviewDefaults?.reviewerApplies === true);

  // TUI completion section — delegate to the shared light-path builder so
  // both prompt paths emit byte-identical workflows. (Background: TUI owns
  // its own `/simplify` → `/do:pr|/do:push` → sentinel sequence because the
  // slashdo submodule mounts those commands at project level. Writing the
  // sentinel is the done signal — PortOS finalizes via the watcher and kills
  // the session, so the prompt does NOT ask the agent to `/quit` (it's a UI
  // command the agent can't invoke). See `buildTuiCompletionSection` below.)
  const tuiCompletionCommand = willOpenPR ? '/do:pr' : '/do:push';
  const sentinelPath = resolveSentinelPath(worktreeInfo, workspaceDir, agentId);
  // A discard task's completion is the sentinel-only contract (no push/PR/merge),
  // and this applies to every provider type — so it wins over the isTui fork and
  // over the fallback template's commit/push instructions below.
  // Same precedence as buildCompletionGuidelineBullet: where the deliverable
  // goes (`noCodeOutput`) decides the completion contract, and only then does
  // worktree disposal (`discardWorktree`) pick the reasoning-payload contract.
  // A task doing external work during the run must not be told the sentinel is
  // its output channel.
  const tuiCompletionSection = noCodeOutput
    ? buildActionOutputCompletionSection({ isTui, sentinelPath })
    : discardWorktree
      ? buildProgrammaticOutputCompletionSection(sentinelPath)
      : claimFlow
        ? buildClaimFlowCompletionSection({ isTui, sentinelPath, reviewersCsv: claimReviewersCsv(task, codeReviewDefaults, defaultReviewers) })
      : isTui
        ? buildTuiCompletionSection({
            willOpenPR, prCompletion, simplifyEnabled, noChangeSuccess,
            // Unreachable today — every `tui`/`cli` provider returns early at the
            // LIGHT_CONTEXT gate above, so `isTui` is always false on this path
            // (same situation as buildCompletionGuidelineBullet's `isTui` arm).
            // Kept provider-aware anyway so it can't be the ONE call site that
            // silently promises `/do:pr` to a host that can't type it if the
            // routing ever changes — this arm previously passed no slashdoFree at
            // all, which is how gates like this drift (#3114).
            slashdoFree: !canRunSlashCommands,
            branchName: worktreeInfo?.branchName || null,
            baseBranch: worktreeInfo?.baseBranch || null,
            sentinelPath,
            leavePrOpen: leavesPrForHuman(task),
            reviewers: taskReviewers,
            usernames: taskReviewerUsernames,
            optionalReviewers: taskOptionalReviewers,
            reviewerMaxRounds: taskReviewerMaxRounds,
            reviewerModels: taskReviewerModels,
            reviewerEfforts: taskReviewerEfforts,
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
  const reviewLoopSection = prCompletion === PR_COMPLETIONS.REVIEW_THEN_MERGE && willOpenPR && !isTui ? `
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
    // `/do:rpr` is the Copilot/@github comment-resolution procedure — a merge-only
    // follow-up has no review to resolve, so skip the ~35KB read for it.
    const rprBody = isFollowUpNeedingRecipes ? await loadSlashdoFile('rpr').catch(() => null) : null;
    // localAgentLoopBody (the CLI-reviewer recipe) was already preloaded at the
    // top of buildAgentPrompt under the same reviewLoopFollowUp guard — reuse it
    // rather than re-reading the lib a second time.
    reviewLoopFollowUpSection = buildReviewLoopFollowUpSection(task.metadata || {}, { verbose: true, rprBody, localAgentLoopBody });
    if (isTui) {
      const sentinelPath = resolveSentinelPath(worktreeInfo, workspaceDir, agentId);
      const branchName = worktreeInfo?.branchName || task.metadata?.reviewLoopPRBranch || null;
      const sentinelTail = branchName ? `   ## Branch\n   ${branchName}` : '   ## Branch\n   <branch name>';
      reviewLoopFollowUpSection += '\n\n' + [
        '## Completion Handoff',
        'When finished with the follow-up steps above, write the completion sentinel to signal PortOS that you are done:',
        '',
        ...buildSentinelWriteSteps(1, sentinelPath, sentinelTail)
      ].join('\n');
    }
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

  // Keep the existing lifecycle template first, then append one narrow domain
  // guide when the task explicitly concerns a supported visual stack.
  const skillSection = await loadSkillTemplates(detectSkillTemplates(task));

  // Build onboard tools section for agent awareness
  const toolsSection = skipDevContext
    ? ''
    : await getToolsSummaryForPrompt().catch(err => {
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
  // The task's prompt payload + human note as ONE string (#4153). Templates —
  // the shipped `cos-agent-briefing.md` AND every copy an install has since
  // customized — reference `{{task.metadata.context}}`, so the split is folded
  // back into that key for rendering instead of being pushed out to every
  // template on every install. `metadata.prompt` still travels untouched for a
  // custom template that wants to address it directly.
  const contextBlock = taskContextBlock(task);
  const uiAuditRuntimeSection = isUiAuditTask(task) ? UI_AUDIT_RUNTIME_RULE : '';
  const briefingTask = contextBlock === (task.metadata?.[TASK_CONTEXT_KEY] ?? null)
    ? task
    : { ...task, metadata: { ...task.metadata, [TASK_CONTEXT_KEY]: contextBlock } };
  const promptData = isReviewLoopFollowUp ? null : await buildPrompt('cos-agent-briefing', {
    task: briefingTask,
    targetAppLabel,
    config,
    memorySection,
    agentInstructionsSection,
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
    claudeMdSection: agentInstructionsSection, // Backwards compatibility for prompt templates (pre-#4852 name)
    soulSection: digitalTwinSection, // Backwards compatibility for prompt templates
    timestamp: new Date().toISOString()
  }).catch(() => null);

  if (promptData?.prompt) {
    return `${promptData.prompt}\n\n${UNATTENDED_RUN_RULE}${uiAuditRuntimeSection ? `\n\n${uiAuditRuntimeSection}` : ''}\n\n${PM2_SAFETY_RULE}`;
  }

  const taskBlock = buildTaskBlock(task, { screenshotsAsList: false });

  // Fallback to built-in template
  return `${agentInstructionsSection || ''}

${memorySection || ''}

${taskBlock.description}
${contextBlock ? (contextBlock.includes('\n') ? `\n### Task Context\n\n${contextBlock.trimEnd()}\n` : `\n### Task Context\n\n${contextBlock}\n`) : ''}
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
4. ${noCodeOutput
  ? 'Deliver your result the way the task describes (the API call or command it names) — do NOT commit, push, or open a PR; this task changes no code'
  : discardWorktree
  ? 'Write your result to the completion sentinel (see the Completion section above) — do NOT commit, push, or open a PR; this worktree is discarded on exit'
  : claimFlow
    ? 'Follow the claim workflow prompt above; it owns its worktree, PR/MR, review, merge or human-handoff, and cleanup. Do not stop after committing.'
  : isReviewLoopFollowUp
    ? 'Follow the follow-up section above — push any fixes you make to the PR branch; a run that needed no fix makes no commit and that is a success, not a miss'
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
    isReadOnly: isTruthyMetaFn(task.metadata?.readOnly), whenDone,
    isTui, tuiCompletionCommand, slashdoFree: isTui && !canRunSlashCommands,
    worktreeInfo, willOpenPR, prCompletion, discardWorktree, noCodeOutput, noChangeSuccess,
    leavePrOpen: leavesPrForHuman(task),
    isPrFollowUp: isReviewLoopFollowUp, claimFlow,
  });
  return bullet ? `- ${bullet}` : '';
})()}

## Git Hygiene (CRITICAL)
- **Before starting work**, run \`git status\` to verify a clean working tree. Do NOT stash or discard uncommitted changes — other agents may be working concurrently and expecting those changes to be present. If the tree is dirty, only commit files YOU changed for this task.
- **NEVER use \`git stash\`** in any form (\`git stash push\`, \`git stash pop\`, etc.). This is a multi-agent system — stashing can silently destroy or corrupt another agent's or the user's in-progress work. Work around uncommitted changes instead. (Note: the backend may use \`--autostash\` in user-triggered pull operations — that is safe because those are single-user UI actions, not concurrent agent operations.)
- **Only commit files YOU changed** for this task. Never use \`git add -A\` or \`git add .\` — always stage specific files by name.
${noChangeSuccess ? `- **No-change audits may exit cleanly.** ${NO_CHANGE_AUDIT_GUIDANCE}` : ''}
${noCodeOutput
  ? `- **Do NOT commit, push, or open a PR.** This task changes no code — its result is delivered by the API call or command described above. Without this, a no-worktree task of this shape was told to \`/do:push\` **directly to the branch it is standing on**, which for a task running in the app's live checkout is its default branch.`
  : discardWorktree
  ? `- **Do NOT commit, push, or open a PR.** This worktree is discarded on exit — your only output is the completion sentinel (see the Completion section above).`
  : claimFlow
    ? `- **Follow the claim workflow prompt above.** It owns the claim worktree and the full PR/MR lifecycle; do not stop after committing or hand push/PR/merge/cleanup back to PortOS.`
  : isReviewLoopFollowUp
    ? `- **Push fixes straight to the PR branch you are on** (the follow-up section above is the procedure). Stage specific files, use a \`fix:\` prefix, no Co-Authored-By annotations. Do NOT open a new PR.`
  : isTui && tuiSlashdoFree
    ? `- **Commit only — do NOT push.** Stage specific files, use \`feat:\`/\`fix:\`/\`breaking:\` prefix in the commit message, no Co-Authored-By annotations, then write the completion sentinel. PortOS will handle the branch after it closes the session.`
    : isTui
    ? `- **Use \`${tuiCompletionCommand}\` to ${willOpenPR ? 'commit, push, and open the PR' : 'commit and push the branch'}** — see the Completion Workflow section above. Stage specific files (no \`git add -A\`), use \`feat:\`/\`fix:\`/\`breaking:\` prefix in the commit message, no Co-Authored-By annotations.`
    : worktreeInfo && willOpenPR
      ? `- **Commit only — do NOT push.** Stage specific files, use \`feat:\`/\`fix:\`/\`breaking:\` prefix in the commit message, no Co-Authored-By annotations. The system will push your branch and open the PR after you exit, so do NOT run \`git push\` or \`/do:push\` yourself.`
      : `- **Commit and push using \`/do:push\`** — this handles changelog updates, staging specific files, writing a conventional commit message, and pushing safely. If \`/do:push\` is unavailable, follow its conventions manually: stage specific files, use \`feat:\`/\`fix:\`/\`breaking:\` prefix, no Co-Authored-By annotations, and push with \`git pull --rebase && git push\`.`}
${discardWorktree || noCodeOutput || claimFlow ? '' : worktreeInfo ? `- **Your PR should contain only your task's commits.** If you see unrelated commits in your branch history, something is wrong — do not open a PR with other agents' work.` : `- **Commit directly to the current branch.** Do NOT create feature branches or PRs unless explicitly instructed.`}

## Working Directory
${task.metadata?.app ? `You are working in the target app directory: \`${workspaceDir}\`. All code changes, research, plans, and docs for this task belong in this directory — NOT in the PortOS repo.` : 'You are working in the project directory.'} Use the available tools to explore, modify, and test code.

${UNATTENDED_RUN_RULE}
${uiAuditRuntimeSection ? `\n${uiAuditRuntimeSection}` : ''}

${PM2_SAFETY_RULE}

Begin working on the task now.`;
}

/**
 * Build the **light-context** prompt for agents that have native filesystem
 * tools and agent-instruction loading (Claude Code, Codex, Antigravity — `tui` or `cli`).
 *
 * The agent already has direct access to the project, so we don't paste in:
 *   memory dumps, AGENTS.md contents, digital twin, tools summary,
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

function buildLightContextSections(task, workspaceDir, worktreeInfo, isTruthyMetaFn, { isTui = true, providerId = null, providerCommand = null, leanMode = false, agentId = null, defaultReviewers, codeReviewDefaults, localAgentLoopBody = null, localAgentLoopBodyPath = null, forgeCli = null } = {}) {
  // Idempotent with the reconcile in buildAgentPrompt; also protects the
  // directly-exported buildLightContextPrompt/Parts entry points.
  task = reconcileSplitContext(task);
  const willOpenPR = isTruthyMetaFn(task.metadata?.openPR);
  const claimFlow = isClaimFlowTask(task, isTruthyMetaFn);
  const prCompletion = resolvePrCompletion(task.metadata);
  const simplifyEnabled = isTruthyMetaFn(task.metadata?.simplify);
  const isReadOnly = isTruthyMetaFn(task.metadata?.readOnly);
  const discardWorktree = isTruthyMetaFn(task.metadata?.discardWorktree);
  // A no-code / API-action task (e.g. a Creative Director plan/treatment/evaluate
  // agent): its deliverable is an HTTP PATCH, not a commit — suppress the
  // /do:push completion workflow (see buildActionOutputCompletionSection). Also
  // derive from a CD task's `creativeDirector` marker so pre-upgrade `pending`
  // tasks (queued before this flag existed) are recognized without a migration.
  const noCodeOutput = isTruthyMetaFn(task.metadata?.noCodeOutput) || !!task.metadata?.creativeDirector;
  const noChangeSuccess = isTruthyMetaFn(task.metadata?.noChangeSuccess);
  const isReviewLoopFollowUp = isTruthyMetaFn(task.metadata?.reviewLoopFollowUp);
  const isWorktreeOnExistingBranch = isPrBranchWorktree(task, worktreeInfo);
  // Ordered reviewer list + flags for the Review Loop (task metadata wins; else
  // the install's configured Code Review Defaults threaded from buildAgentPrompt;
  // else `[copilot]`). Flows as `/do:pr --review-with a,b,c [--review-stop-on-*]
  // [--reviewer-applies]`. All five fields fall back to the defaults with
  // task-over-default precedence (see the matching block in buildAgentPrompt and
  // resolveReviewLoopOptions) — not just the reviewer list.
  const {
    reviewers: lightReviewers,
    usernames: lightReviewerUsernames,
    optionalReviewers: lightOptionalReviewers,
    reviewerMaxRounds: lightReviewerMaxRounds,
    reviewerModels: lightReviewerModels,
    reviewerEfforts: lightReviewerEfforts
  } = resolveReviewerConfig(task.metadata, codeReviewDefaults, defaultReviewers);
  const lightReviewStopMode = task.metadata?.reviewStopMode || codeReviewDefaults?.stopMode || DEFAULT_REVIEW_STOP_MODE;
  const lightReviewerApplies = task.metadata?.reviewerApplies !== undefined
    ? isTruthyMetaFn(task.metadata?.reviewerApplies)
    : (codeReviewDefaults?.reviewerApplies === true);
  const resolvedForgeCli = manualForgeCli(forgeCli, worktreeInfo);
  // Can this session TYPE a Claude Code slash command (`/do:pr`, `/do:push`,
  // `/simplify`)? One predicate, both prompt paths (#3114): `canTypeSlashCommands`
  // derives from `resolveSlashdoStyle` with the spawners' blank-command posture,
  // replacing three inline provider-id allowlists that had already drifted apart
  // (a codex TUI used to be told to run `/do:pr`, which it cannot; a
  // path-configured `claude` binary under a custom provider id used to be denied
  // the slashdo workflow).
  const canTypeSlash = canTypeSlashCommands({ providerId, providerCommand, leanMode });
  // CLI (non-TUI): a Claude Code session drives `/simplify` + `/do:pr` itself
  // (the slashdo submodule mounts those as project-level slash commands). Other
  // CLI providers (codex, antigravity, grok, opencode) get the legacy commit-only
  // block where PortOS handles push+PR on exit.
  const hasSlashdo = !isTui && canTypeSlash;
  // TUI: a session that does NOT load Claude Code slash commands can't run
  // `/do:pr` / `/do:push`, so its completion workflow uses plain git and hands
  // the post-exit push / PR lifecycle back to PortOS
  // — an OpenCode TUI, a codex/antigravity/grok TUI, or a lean-mode Claude
  // session (`--bare` skips project command discovery, and the small local models
  // lean mode targets fumble multi-step slashdo flows anyway).
  const tuiSlashdoFree = isTui && !canTypeSlash;
  // Does this session drive commit → push → PR → review → merge itself?
  //
  // ONE value answers both "emit the manual PR steps" and "emit the Review Loop
  // / Merge Gate section they point at", because they are the same decision:
  // the agent opens its own PR exactly when it also lands it. Splitting them let
  // a JIRA run be told to open a PR whose merge section was suppressed — and
  // PortOS opened that PR too. `inlineSection` also names WHICH section follows,
  // so the completion step's cross-reference can't name the wrong one.
  const inlineSection = claimFlow ? null : inlinePrLifecycleSection(task, {
    providerType: isTui ? PROVIDER_TYPES.TUI : PROVIDER_TYPES.CLI,
    providerId, providerCommand, leanMode, worktreeInfo, isTruthyMetaFn,
  });
  const ownsPrWorkflow = inlineSection !== null;
  // Slashdo already partitions reviewers. Plain-git completion prompts need the
  // same split spelled out: local CLIs/local LLMs inspect the committed branch
  // before it is public; Copilot and @login reviewers can only run after a PR.
  const isLocalReviewer = reviewer => isCliReviewer(reviewer) || LOCAL_LLM_REVIEWERS.includes(reviewer);
  const localReviewers = lightReviewers.filter(isLocalReviewer);
  const localReviewRequired = localReviewers.some(reviewer => !lightOptionalReviewers.includes(reviewer));
  const reviewerPositions = [
    ...lightReviewers.map((reviewer, position) => ({ reviewer, position })),
    ...lightReviewerUsernames.map((username, index) => ({ reviewer: `@${username}`, position: lightReviewers.length + index })),
  ];
  const localReviewSection = inlineSection === 'review-loop'
    ? buildLocalReviewLoopSection({
      taskId: task.id,
      branchName: worktreeInfo?.branchName || null,
      baseBranch: worktreeInfo?.baseBranch || null,
      localAgentLoopBody,
      localAgentLoopBodyPath,
      reviewers: lightReviewers,
      optionalReviewers: lightOptionalReviewers,
      reviewerMaxRounds: lightReviewerMaxRounds,
      reviewerModels: lightReviewerModels,
      reviewerEfforts: lightReviewerEfforts,
      reviewStopMode: lightReviewStopMode,
      reviewerApplies: lightReviewerApplies,
      reviewerPositions,
    })
    : '';
  const prSideReviewers = lightReviewers.filter(reviewer => !isLocalReviewer(reviewer));
  const runsPrSideReviewLoop = inlineSection === 'review-loop'
    && (prSideReviewers.length > 0 || lightReviewerUsernames.length > 0);
  const localPhaseCanShortCircuit = localReviewSection !== ''
    && runsPrSideReviewLoop;

  const taskSections = [];
  const contractSections = [];

  // --- Task block --------------------------------------------------------
  // cwd is set by the spawner and the agent knows its own id from the
  // runner, so the prompt skips that metadata. Target app is kept only for
  // MANAGED apps because it scopes cross-repo work; the PortOS default app is
  // suppressed in buildTaskBlock since cwd already reveals it. Shared with the
  // full path via buildTaskBlock.
  const taskBlock = buildTaskBlock(task, { screenshotsAsList: true });
  taskSections.push(taskBlock.description);
  if (taskBlock.targetApp) taskSections.push(taskBlock.targetApp);

  // The task's prompt payload + human note as one block (#4153), so the split is
  // invisible here and a legacy `metadata.context`-as-prompt still renders.
  const context = taskContextBlock(task);
  if (context) {
    taskSections.push(context.includes('\n')
      ? `### Context\n\n${context.trimEnd()}`
      : `### Context\n${context}`);
  }

  if (taskBlock.screenshots) taskSections.push(taskBlock.screenshots);
  if (taskBlock.attachments) taskSections.push(taskBlock.attachments);

  // --- Unattended run ----------------------------------------------------
  // First contract section, and unconditional: the light path is the one that
  // actually stalled on an approval gate, and "no human will answer you" is not
  // something the agent can infer from AGENTS.md or its cwd.
  contractSections.push(UNATTENDED_RUN_RULE);
  if (isUiAuditTask(task)) contractSections.push(UI_AUDIT_RUNTIME_RULE);

  // --- Worktree ----------------------------------------------------------
  if (worktreeInfo) {
    contractSections.push([
      '## Git Worktree',
      `- **Branch**: \`${worktreeInfo.branchName}\`${isWorktreeOnExistingBranch ? ' *(pre-existing PR branch)*' : ''}`,
      `- **Path**: \`${worktreeInfo.worktreePath}\``,
      worktreeInfo.baseBranch ? `- **Based on**: \`${worktreeInfo.baseBranch}\`` : null,
      '',
      worktreeCommitGuidance({ isTui, hasSlashdo, ownsPrWorkflow, isWorktreeOnExistingBranch, willOpenPR, discardWorktree, claimFlow, noChangeSuccess }),
      'Do NOT manually switch branches or modify the worktree configuration.',
      // Resuming a previous failed agent's branch: establish what's already done
      // before writing code (see buildResumeSection). '' when not a resume.
      buildResumeSection(task, worktreeInfo) || null
    ].filter(Boolean).join('\n'));
  }

  // --- Pipeline ----------------------------------------------------------
  const pipelineCtx = task.metadata?.pipeline;
  if (pipelineCtx?.previousStageAgentId) {
    const prevOutput = join(AGENTS_DIR, pipelineCtx.previousStageAgentId, 'output.txt');
    contractSections.push([
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
    contractSections.push([
      '## JIRA',
      `- **Ticket**: ${task.metadata.jiraTicketId} (${task.metadata.jiraTicketUrl})`,
      task.metadata.jiraBranch ? `- **Branch**: \`${task.metadata.jiraBranch}\` — commit here; do NOT switch branches.` : null,
      `Include the ticket ID in commit messages, e.g. \`${task.metadata.jiraTicketId}: description\`.`
    ].filter(Boolean).join('\n'));
  }

  // --- Completion / review-loop ------------------------------------------
  // Ordering matches the full path's (buildCompletionGuidelineBullet and the
  // tuiCompletionSection ternary): the deliverable's destination
  // (`noCodeOutput`) decides the contract, and only then does worktree disposal
  // (`discardWorktree`) pick the reasoning-payload one. THIS is the branch that
  // matters in production — every `tui`/`cli` provider returns from the light
  // path above and never reaches the other two, so a fix applied only there is
  // no fix at all for anything a subscription-quota job can run.
  if (noCodeOutput) {
    contractSections.push(buildActionOutputCompletionSection({
      isTui,
      sentinelPath: resolveSentinelPath(worktreeInfo, workspaceDir, agentId),
    }));
  } else if (discardWorktree) {
    // Reasoning-only task: the sentinel payload (shape set by the task-type
    // output hook) is the sole output; the worktree is discarded on exit. Wins
    // over the isTui / CLI push-and-PR completion workflows below.
    contractSections.push(buildProgrammaticOutputCompletionSection(resolveSentinelPath(worktreeInfo, workspaceDir, agentId)));
  } else if (claimFlow) {
    contractSections.push(buildClaimFlowCompletionSection({
      isTui,
      sentinelPath: resolveSentinelPath(worktreeInfo, workspaceDir, agentId),
      reviewersCsv: claimReviewersCsv(task, codeReviewDefaults, defaultReviewers),
    }));
  } else if (isReadOnly) {
    contractSections.push(buildReadOnlyCompletionSection({
      isTui,
      sentinelPath: resolveSentinelPath(worktreeInfo, workspaceDir, agentId),
    }));
  } else if (isReviewLoopFollowUp) {
    contractSections.push(buildReviewLoopFollowUpSection(task.metadata || {}, { verbose: false, localAgentLoopBody, forgeCli: resolvedForgeCli }));
    if (isTui) {
      const sentinelPath = resolveSentinelPath(worktreeInfo, workspaceDir, agentId);
      const branchName = worktreeInfo?.branchName || task.metadata?.reviewLoopPRBranch || null;
      const sentinelTail = branchName ? `   ## Branch\n   ${branchName}` : '   ## Branch\n   <branch name>';
      contractSections.push([
        '## Completion Handoff',
        'When finished with the follow-up steps above, write the completion sentinel to signal PortOS that you are done:',
        '',
        ...buildSentinelWriteSteps(1, sentinelPath, sentinelTail)
      ].join('\n'));
    }
  } else if (isTui) {
    contractSections.push(buildTuiCompletionSection({
      willOpenPR, prCompletion, simplifyEnabled, noChangeSuccess, slashdoFree: tuiSlashdoFree, ownsPrWorkflow,
      sentinelPath: resolveSentinelPath(worktreeInfo, workspaceDir, agentId),
      branchName: worktreeInfo?.branchName || null,
      baseBranch: worktreeInfo?.baseBranch || null,
      leavePrOpen: leavesPrForHuman(task),
      reviewers: lightReviewers, usernames: lightReviewerUsernames, optionalReviewers: lightOptionalReviewers, reviewerMaxRounds: lightReviewerMaxRounds, reviewerModels: lightReviewerModels, reviewerEfforts: lightReviewerEfforts, reviewStopMode: lightReviewStopMode, reviewerApplies: lightReviewerApplies,
      forgeCli: resolvedForgeCli, localReviewSection, localReviewRequired, postPrReview: ownsPrWorkflow ? runsPrSideReviewLoop : null
    }));
  } else {
    contractSections.push(buildCliCompletionSection({ worktreeInfo, willOpenPR, prCompletion, hasSlashdo, ownsPrWorkflow, simplifyEnabled, noChangeSuccess, leavePrOpen: leavesPrForHuman(task), reviewers: lightReviewers, usernames: lightReviewerUsernames, optionalReviewers: lightOptionalReviewers, reviewerMaxRounds: lightReviewerMaxRounds, reviewerModels: lightReviewerModels, reviewerEfforts: lightReviewerEfforts, reviewStopMode: lightReviewStopMode, reviewerApplies: lightReviewerApplies, forgeCli: resolvedForgeCli, localReviewSection, localReviewRequired, postPrReview: ownsPrWorkflow ? runsPrSideReviewLoop : null }));
  }

  // The manual workflow's step 4 points here — it must follow the completion
  // section it is a step of. Gated on the SAME value that made that step emit,
  // so a dangling "step 4" cross-reference and an orphaned Review Loop section
  // are both unrepresentable.
  if (ownsPrWorkflow) {
    contractSections.push(buildInlineReviewLoopSection({
      taskId: task.id,
      branchName: worktreeInfo?.branchName || null,
      runsReviewLoop: runsPrSideReviewLoop,
      leaveOpen: false,
      localAgentLoopBody: null,
      localAgentLoopBodyPath: null,
      // Only the TUI completion workflow ends on a sentinel write; a CLI run
      // signals completion by exiting.
      writesSentinel: isTui,
      reviewers: prSideReviewers,
      usernames: lightReviewerUsernames,
      optionalReviewers: lightOptionalReviewers,
      reviewerMaxRounds: lightReviewerMaxRounds,
      reviewerModels: lightReviewerModels,
      reviewerEfforts: lightReviewerEfforts,
      reviewStopMode: lightReviewStopMode,
      reviewerApplies: lightReviewerApplies,
      localPhaseReviewers: localReviewers,
      localPhaseCanShortCircuit,
      localPhaseReviewRequired: localReviewSection ? localReviewRequired : false,
      reviewerPositions,
      forgeCli: resolvedForgeCli,
      workflowStep: localReviewSection ? 5 : 4,
    }));
  }

  return { taskSections, contractSections };
}
