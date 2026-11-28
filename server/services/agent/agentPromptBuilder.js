/** Prepare CoS task context and select the light or full agent prompt. */

import { formatClaimDependencyStatus } from '../claimDependencyLock.js';
import { auditWorkflow, EXTENDED_AUDIT_INSTRUCTIONS } from '../../lib/auditWorkflow.js';
import { getMemorySection } from '../memoryRetriever.js';
import { isTruthyMeta, isFalsyMeta } from '../../lib/metadataFlags.js';
import { PATHS } from '../../lib/fileUtils.js';
import { loadSlashdoLib, writeResolvedSlashdoBody } from '../../lib/slashdoLoader.js';
import { isCliReviewer, resolveReviewerConfig } from '../../lib/reviewerConfig.js';
import { PROVIDER_TYPES } from '../../lib/aiToolkit/constants.js';
import { SLASHDO_INLINE_BUDGET_CHARS } from '../../lib/slashdoInvocation.js';
import { getDigitalTwinForPrompt } from '../digital-twin.js';
import { TASK_PROMPT_KEY } from '../../lib/cos/cosTaskPrompt.js';
import { injectReconcileAgentId } from '../../lib/claimContinuation.js';
import { resolveUseAutoMerge, resolveAutoApprovePR, resolveAdminMerge } from '../../lib/prDisposition.js';
import { PORTOS_APP_ID } from '../../lib/appIdentity.js';
import { localApiBaseUrl } from '../../lib/networkExposure.js';
import { PORTOS_API_URL_TOKEN } from '../../lib/portosUrls.js';
import { getCodeReviewDefaults } from '../codeReview.js';
import { LIGHT_CONTEXT_PROVIDER_TYPES } from '../promptSections/constants.js';
import { getAgentInstructionsContext } from '../promptSections/instructions.js';
import { reconcileSplitContext } from '../promptSections/taskContext.js';
import { applySlashdoInvocation } from '../promptSections/slashdo.js';
import { deferClaimSections } from '../promptSections/claimOnDemand.js';
import { resolveManualForgeCli } from '../promptSections/forge.js';
import { isPublicReviewRestrictedProfile } from '../../lib/agent/agentExecutionProfiles.js';
import { buildWorkflowScopeSection, inlinePrLifecycleSection } from '../promptSections/completion.js';
import { isMergeOnlyFollowUp, prepareLocalReviewLoopBody, prepareSandboxedReviewLoopBody } from '../promptSections/reviewLifecycle.js';
import { expandReviewVerdictRunId } from '../promptSections/reviewerOutcome.js';
import { buildFullContextPrompt } from './agentFullContextPrompt.js';
import { buildLightContextPrompt, buildLightContextPromptParts } from './agentLightContextPrompt.js';
import { isClaimFlowTask, resolveTaskMetadataFlags } from './agentPromptSections.js';

export { buildLightContextPrompt, buildLightContextPromptParts } from './agentLightContextPrompt.js';
export {
  UI_AUDIT_TASK_TYPES, buildUiAuditRuntimeRule, isUiAuditTask, isClaimFlowTask, PM2_SAFETY_RULE,
  UNATTENDED_RUN_RULE,
} from './agentPromptSections.js';

export { promptOpensOwnPr } from '../promptSections/completion.js';
export { getAppWorkspace } from '../promptSections/appContext.js';

/**
 * Expand the portosApiUrl token (PORTOS_API_URL_TOKEN) in a finished agent
 * prompt, a string or the split { userPrompt, systemPrompt } shape, to this
 * machine's loopback API origin. Producers emit the token instead of resolving
 * a URL because a task can be forwarded to another instance (targetInstanceId)
 * and only the machine that spawns the agent knows whether its :5555 is
 * TLS-only (#12405). The replacement is function-form so the URL is inserted
 * literally.
 */
function expandPortosApiUrl(prompt) {
  const parts = typeof prompt === 'string' ? [prompt] : [prompt?.userPrompt, prompt?.systemPrompt];
  if (!parts.some(part => typeof part === 'string' && part.includes(PORTOS_API_URL_TOKEN))) return prompt;
  const apiBase = localApiBaseUrl();
  return expandPromptParts(prompt, text => text.replaceAll(PORTOS_API_URL_TOKEN, () => apiBase));
}

/** Apply a string transform to a finished prompt, a string or the split { userPrompt, systemPrompt } shape. */
function expandPromptParts(prompt, expandText) {
  const expand = text => (typeof text === 'string' ? expandText(text) : text);
  if (typeof prompt === 'string') return expand(prompt);
  if (!prompt || typeof prompt !== 'object') return prompt;
  const userPrompt = expand(prompt.userPrompt);
  const systemPrompt = expand(prompt.systemPrompt);
  if (userPrompt === prompt.userPrompt && systemPrompt === prompt.systemPrompt) return prompt;
  return {
    ...prompt,
    ...('userPrompt' in prompt && { userPrompt }),
    ...('systemPrompt' in prompt && { systemPrompt }),
  };
}

/** Load and safely stage the review recipe shared by full and light prompts. */
async function prepareReviewLoopRecipe(task, {
  providerType, providerId, providerCommand, leanMode, worktreeInfo,
  codeReviewDefaults, defaultReviewers,
}) {
  // Preload slashdo's local-agent review-loop recipe once for review-loop
  // follow-up tasks; both the light/TUI path (via lightOptions) and the full
  // path (the verbose builder below) reuse this single value to inline the exact
  // CLI-reviewer invocation. Cheap + cached; only read for follow-ups — and not
  // for a merge-only follow-up, which has no reviewer to invoke and renders a
  // section that ignores this body entirely.
  const isFollowUpNeedingRecipes = isTruthyMeta(task.metadata?.reviewLoopFollowUp)
    && !isMergeOnlyFollowUp(task.metadata || {});
  // …and a slashdo-free harness driving its OWN review loop inline needs the
  // identical recipe (`buildInlineReviewLoopSection`). Same predicate the render
  // side uses, so a run whose section never materializes — read-only,
  // leave-open, JIRA, or a merge gate with no reviewer to invoke — doesn't pay
  // for the read and the staging write. The reviewer-list term matters too: the
  // section only inlines the recipe when a SPAWNABLE CLI reviewer resolves, so a
  // copilot-only or username-only list (including an unconfigured install)
  // would otherwise
  // read + `atomicWrite` 56KB and then render nothing from it.
  const isInlineNeedingRecipes = inlinePrLifecycleSection(task, {
    providerType, providerId, providerCommand, leanMode, worktreeInfo,
  }) === 'review-loop'
    && resolveReviewerConfig(task.metadata, codeReviewDefaults, defaultReviewers).reviewers.some(isCliReviewer);
  const localAgentLoopBody = (isFollowUpNeedingRecipes || isInlineNeedingRecipes)
    ? await loadSlashdoLib('local-agent-review-loop').catch(() => null)
    : null;
  const inlineOnly = isInlineNeedingRecipes && !isFollowUpNeedingRecipes;
  const localAgentLoopBodyForInline = inlineOnly
    ? prepareLocalReviewLoopBody(prepareSandboxedReviewLoopBody(localAgentLoopBody))
    : localAgentLoopBody;
  // The recipe is ~40KB. A follow-up agent inlines it — driving the loop is that
  // agent's entire job, so it will read all of it anyway. An INLINE loop is a
  // later phase of a run whose context is already carrying the actual task, so an
  // over-budget recipe is sanitized, then staged on disk and pointed at instead
  // (#3110's split, applied to the same body). Every host that reaches here has
  // file tools. Sanitizing before the write is load-bearing: otherwise the file
  // pointer would bypass the public-content sandbox applied during rendering.
  const localAgentLoopBodyPath = (inlineOnly
    && localAgentLoopBodyForInline && localAgentLoopBodyForInline.length > SLASHDO_INLINE_BUDGET_CHARS)
    ? await writeResolvedSlashdoBody('local-agent-review-loop', localAgentLoopBodyForInline).catch((err) => {
        console.warn(`⚠️ Could not stage the CLI-reviewer recipe, inlining instead: ${err.message}`);
        return null;
      })
    : null;

  return {
    isFollowUpNeedingRecipes, localAgentLoopBody,
    localAgentLoopBodyForInline, localAgentLoopBodyPath,
  };
}

function fillReconcileAgentId(task, agentId) {
  const description = injectReconcileAgentId(task.description, agentId);
  const prompt = injectReconcileAgentId(task.metadata?.[TASK_PROMPT_KEY], agentId);
  if (description === task.description && prompt === task.metadata?.[TASK_PROMPT_KEY]) return task;
  return {
    ...task, description,
    ...(prompt !== task.metadata?.[TASK_PROMPT_KEY] ? { metadata: { ...task.metadata, [TASK_PROMPT_KEY]: prompt } } : {}),
  };
}

async function pinAutoMergeChoice(task) {
  const { getAppById } = await import('../apps.js');
  const app = await getAppById(task.metadata?.app || PORTOS_APP_ID).catch(() => null);
  const metadata = { ...task.metadata, mergeHandoffMinQueuedRuns: task.metadata?.mergeHandoffMinQueuedRuns ?? app?.mergeHandoffMinQueuedRuns ?? null };
  const resolvedApp = app || { id: task.metadata?.app || PORTOS_APP_ID };
  // Pin each choice independently: an explicit per-task useAutoMerge must not skip the code-owner choices.
  if (!isTruthyMeta(metadata.useAutoMerge) && !isFalsyMeta(metadata.useAutoMerge)) {
    metadata.useAutoMerge = resolveUseAutoMerge(resolvedApp, task.metadata);
  }
  metadata.autoApprovePR = resolveAutoApprovePR(resolvedApp, task.metadata);
  metadata.adminMerge = resolveAdminMerge(resolvedApp, task.metadata);
  return { ...task, metadata };
}

// Checkout recovery gets the live sessions and PortOS-authored commits PortOS
// observed in the checkout, so its blocker names the real owner (#16075).
async function attachCheckoutOwnership(task, workspaceDir) {
  const { isCheckoutRecoveryTask, describeCheckoutOwnership } = await import('../checkoutOwnership.js');
  if (!isCheckoutRecoveryTask(task) || !workspaceDir) return task;
  const checkoutOwnership = await describeCheckoutOwnership(workspaceDir).catch(() => null);
  return checkoutOwnership ? { ...task, metadata: { ...task.metadata, checkoutOwnership } } : task;
}

// A claim that merges its own PR needs to know up front whether the forge token
// can merge workflow-file changes (#15680). Probe only for claim flows.
async function attachWorkflowScope(task, workspaceDir) {
  if (!isClaimFlowTask(task) || task.metadata?.forgeWorkflowScope) return task;
  const { getWorkflowScopeStatus } = await import('../forgeAuth.js');
  const forgeWorkflowScope = await getWorkflowScopeStatus(workspaceDir).catch(() => ({ status: 'unknown' }));
  return { ...task, metadata: { ...task.metadata, forgeWorkflowScope } };
}

export function renderClaimDependencyStatus(prompt, dependencies) {
  const status = formatClaimDependencyStatus(dependencies);
  return expandPromptParts(prompt, text => text.replaceAll('CLAIM_DEPENDENCY_PROVISIONING_STATUS', () => status));
}

/**
 * Build the agent prompt.
 *
 * Two context modes, selected by `options.providerType`:
 *
 * - **Light** (`tui` / `cli`): minimal prompt — task description, attached
 *   context, screenshot paths, worktree/jira/pipeline coordinates, and the
 *   completion-workflow contract, plus eligible Memory and Digital Twin
 *   context. Native agents load repository instructions and tools themselves.
 * - **Full** (`api`): kitchen-sink prompt with memory + AGENTS.md + digital
 *   twin + tools + skills + planning + git hygiene. The leading
 *   "# Chief of Staff Agent Briefing" header is dropped from both modes.
 *
 * @param {Object} task - Task object
 * @param {Object} config - CoS configuration
 * @param {string} workspaceDir - Working directory (may be a worktree)
 * @param {Object|null} worktreeInfo - Worktree details if using a worktree
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
 * @param {object} [options.promptTrace] - Out-parameter: both paths set
 *   `promptTrace.injectedMemories` to the `[{ id, version, relevance, preview }]` list
 *   whose text went into the prompt.
 */
export async function buildAgentPrompt(task, config, workspaceDir, worktreeInfo = null, options = {}) {
  // Undo the queue-path description/context split so a round-tripped generated
  // prompt (swarm, scheduled claim-work, other system tasks) renders once
  // instead of double-printing its first line under a `### Context` header.
  // Feeds both the briefing template (via the reconciled `task` object) and the
  // full-path fallback below.
  task = reconcileSplitContext(task);

  // A branch-reconcile coordinator's recheck commands carry its own agent id so
  // a successful check reserves the branch for it (#10096). The block was built
  // before the run had an id; fill the slot now, wherever the prompt travels.
  task = fillReconcileAgentId(task, options.agentId);

  task = await pinAutoMergeChoice(task);
  task = await attachWorkflowScope(task, workspaceDir);
  task = await attachCheckoutOwnership(task, workspaceDir);

  // Feature-agent tasks carry only a compact queue description. Expand the
  // persisted persona briefing at spawn time so scheduled and manually
  // triggered runs share the same feature-specific goals, constraints, branch
  // context, and previous-run history without storing that prompt in the task
  // queue or duplicating it in every task producer.
  if (task.metadata?.featureAgentRun && task.metadata?.featureAgentId) {
    const { getFeatureAgent, buildFeatureAgentPrompt } = await import('../featureAgents.js');
    const featureAgent = await getFeatureAgent(task.metadata.featureAgentId);
    if (featureAgent) {
      const featurePrompt = await buildFeatureAgentPrompt(featureAgent);
      task = { ...task, metadata: { ...task.metadata, prompt: featurePrompt } };
    }
  }
  const workflow = auditWorkflow(task.metadata);
  if (workflow === 'legacy') throw new Error('Historical Deep certification runs are read-only; start a new Deep audit');
  const deepAuditContract = [
    workflow === 'extended-v1' ? EXTENDED_AUDIT_INSTRUCTIONS : '',
    Number(task.metadata?.auditDispositionVersion) === 1
      ? await (await import('../auditFindings.js')).buildAuditFindingsPrompt(task, options.agentId) : '',
  ].filter(Boolean).join('\n\n');
  const withDeepAudit = prompt => !deepAuditContract ? prompt : typeof prompt === 'string'
    ? `${deepAuditContract}\n\n${prompt}`
    : { ...prompt, systemPrompt: `${deepAuditContract}\n\n${prompt.systemPrompt || ''}` };
  // CLI review-outcome reports name this run so their verdicts land on its record (#16572).
  const finalizePrompt = prompt => renderClaimDependencyStatus(expandPromptParts(expandPortosApiUrl(withDeepAudit(prompt)), text => expandReviewVerdictRunId(text, options.agentId)), options.claimDependencies);

  const providerType = options.providerType || PROVIDER_TYPES.API;
  const providerId = options.providerId || null;
  const providerCommand = options.providerCommand || null;
  const agentId = options.agentId || null;
  // The dispatched model supplies issue-planner and PR-opener attribution.
  const providerModel = options.providerModel || null;
  const isTui = providerType === PROVIDER_TYPES.TUI;
  const leanMode = options.leanMode === true;

  // Install-wide default reviewer list (Code Review Defaults panel →
  // `settings.codeReview.reviewers`). Threaded as the `normalizeReviewers`
  // fallback so a task that pins no `reviewers` (e.g. every app-improve /
  // self-improvement scheduled task) resolves to the configured default
  // instead of a hardcoded reviewer. Unset → [] (getCodeReviewDefaults keeps
  // code review opt-in), so a fresh install does not silently start a review
  // loop. A settings read error likewise leaves the reviewer list empty.
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
  const hasFileTools = LIGHT_CONTEXT_PROVIDER_TYPES.has(providerType);
  task = await applySlashdoInvocation(task, {
    providerId, providerCommand, leanMode, hasFileTools,
    defaultReviewers, codeReviewDefaults,
  });
  // Stage the claim's conditional procedures at the install root, which local
  // file-tool hosts can read even when working in a managed app's checkout.
  let workflowScopeStagedPath = null;
  if (hasFileTools) {
    task = await deferClaimSections(task, writeResolvedSlashdoBody, PATHS.installRoot);
    const scopeBody = buildWorkflowScopeSection(task.metadata?.forgeWorkflowScope);
    if (scopeBody && isClaimFlowTask(task)) {
      workflowScopeStagedPath = await writeResolvedSlashdoBody('claim-workflow-scope', scopeBody).catch(() => null);
    }
  }

  const {
    isFollowUpNeedingRecipes, localAgentLoopBody,
    localAgentLoopBodyForInline, localAgentLoopBodyPath,
  } = await prepareReviewLoopRecipe(task, {
    providerType, providerId, providerCommand, leanMode, worktreeInfo,
    codeReviewDefaults, defaultReviewers,
  });

  const taskFlags = resolveTaskMetadataFlags(task, worktreeInfo);
  // Both public-review postures must stay isolated from the install's private
  // context, even when a sandboxed stage can run commands.
  // Claim prompts describe a procedure (and may not even have selected an issue).
  // Use the issue, checkout, and explicit handoff, not private background context.
  const skipPersonalContext = taskFlags.claimFlow || taskFlags.noCodeOutput
    || isPublicReviewRestrictedProfile(task.metadata?.executionProfile);
  // Creative Director tasks supply their own creative tools and instructions.
  const skipDevContext = !!task.metadata?.creativeDirector;
  const [{ memorySection, digitalTwinSection, injectedMemories }, forgeCli, agentInstructionsSection] = await Promise.all([
    skipPersonalContext ? { memorySection: null, digitalTwinSection: null, injectedMemories: [] } : loadPersonalContext(task, config),
    hasFileTools ? resolveManualForgeCli(workspaceDir, worktreeInfo, task) : null,
    hasFileTools || skipDevContext ? null : getAgentInstructionsContext(workspaceDir)
      .catch(err => { console.log(`⚠️ Agent instructions retrieval failed: ${err.message}`); return null; }),
  ]);
  // Hand the memory lineage to the caller that creates the run record (#10495).
  if (options.promptTrace) options.promptTrace.injectedMemories = injectedMemories;

  if (hasFileTools) {
    const lightOptions = {
      isTui, providerId, providerCommand, providerModel, leanMode, agentId, defaultReviewers, codeReviewDefaults,
      localAgentLoopBody: localAgentLoopBodyForInline, localAgentLoopBodyPath, forgeCli,
      promptTrace: options.promptTrace || null, workflowScopeStagedPath, memorySection, digitalTwinSection,
    };
    return finalizePrompt(options.split === true
      ? buildLightContextPromptParts(task, workspaceDir, worktreeInfo, lightOptions)
      : buildLightContextPrompt(task, workspaceDir, worktreeInfo, lightOptions));
  }

  return finalizePrompt(await buildFullContextPrompt({
    task, workspaceDir, worktreeInfo, taskFlags, skipDevContext,
    providerType, providerId, providerCommand, providerModel, leanMode, isTui, agentId,
    defaultReviewers, codeReviewDefaults, isFollowUpNeedingRecipes, localAgentLoopBody,
    workflowScopeStagedPath, agentInstructionsSection, memorySection, digitalTwinSection,
  }));
}

async function loadPersonalContext(task, config) {
  let injectedMemories = [];
  const twinMaxTokens = config.digitalTwin?.maxContextTokens || config.soul?.maxContextTokens;
  const [memorySection, digitalTwinSection] = await Promise.all([
    getMemorySection(task, {
      maxTokens: config.memory?.maxContextTokens || 2000,
      scopedToApp: true,
      limit: 3,
      onInjected: (injected) => { injectedMemories = injected; },
    })
      .catch(err => { console.log(`⚠️ Memory retrieval failed: ${err.message}`); return null; }),
    // Empty when the Digital Twin 'auto-inject into CoS' setting is off. Omitting maxTokens lets the saved twin setting apply.
    getDigitalTwinForPrompt({ ...(twinMaxTokens ? { maxTokens: twinMaxTokens } : {}), personaId: 'active' })
      .catch(err => { console.log(`⚠️ Digital twin context retrieval failed: ${err.message}`); return null; }),
  ]);
  return { memorySection, injectedMemories, digitalTwinSection };
}
