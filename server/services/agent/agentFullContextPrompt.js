/** Build the full briefing and optional project sections for API agents. */

import { join } from 'path';
import { stat } from 'fs/promises';
import { getToolsSummaryForPrompt } from '../tools.js';
import { isTruthyMeta } from '../../lib/metadataFlags.js';
import { tryReadFile } from '../../lib/fileUtils.js';
import { loadSlashdoFile } from '../../lib/slashdoLoader.js';
import { DEFAULT_REVIEWER, resolveReviewPolicy } from '../../lib/reviewerConfig.js';
import { PROVIDER_TYPES } from '../../lib/aiToolkit/constants.js';
import { canTypeSlashCommands } from '../../lib/slashdoInvocation.js';
import { taskContextBlock } from '../../lib/cos/cosTaskPrompt.js';
import { PR_COMPLETIONS, leavesPrForHuman, prStaysOpen } from '../../lib/prDisposition.js';
import { repositoryCleanupMergeTarget } from '../../lib/recoveryMergeTarget.js';
import { resolveTaskHookType } from '../taskTypeHooks.js';
import { SIMPLIFY_INLINE_REVIEW } from '../promptSections/constants.js';
import { detectSkillTemplates, loadSkillTemplates } from '../promptSections/instructions.js';
import { buildCompactionSection, buildTaskBlock } from '../promptSections/taskContext.js';
import { resolveManualForgeCli } from '../promptSections/forge.js';
import { buildOrchestrationDoctrineSection } from '../promptSections/orchestrationDoctrine.js';
import { buildIssueFilingSection } from '../promptSections/plannerAttribution.js';
import { buildPrAttributionSection } from '../promptSections/prAttribution.js';
import { COMPLETION_MODES, resolveCompletionMode } from '../../lib/agent/agentCompletionMode.js';
import {
  buildActionOutputCompletionSection, buildExternalRepositoryCompletionSection,
  buildAuditOutputCompletionSection, buildClaimFlowCompletionSection, buildMergeAdmissionSection,
  claimResumeContext, buildReleaseFlowCompletionSection, buildReconcileFlowCompletionSection,
  buildCheckoutRecoveryCompletionSection, buildAuditFlowCompletionSection,
  buildCompletionGuidelineBullet, buildFallbackCompletionInstructions, NO_CHANGE_AUDIT_GUIDANCE,
  buildProgrammaticOutputCompletionSection, buildToolFreeReasoningCompletionSection, buildResumeSection,
  buildUnnecessaryDispatchSection, buildSentinelWriteSteps, claimReviewersCsv, worktreeCommitGuidance,
} from '../promptSections/completion.js';
import { buildReviewLoopFollowUpSection } from '../promptSections/reviewLifecycle.js';
import {
  buildUiAuditRuntimeRule, isUiAuditTask, resolveSentinelPath, pipelineContextLines,
  taskVisibleToPipelineReviewer, PM2_SAFETY_RULE, UNATTENDED_RUN_RULE, mergeAdmissionOptions,
  usesSwarmClaim, mergeHandoffEnabled, reviewLoopPromptMetadata, worktreeBranchSuffix, DRAFT_PR_RULE,
} from './agentPromptSections.js';

export async function buildFullContextPrompt({
  task, workspaceDir, worktreeInfo, taskFlags, skipDevContext,
  providerType, providerId, providerCommand, providerModel, leanMode, isTui, agentId,
  defaultReviewers, codeReviewDefaults, isFollowUpNeedingRecipes, localAgentLoopBody,
  workflowScopeStagedPath, agentInstructionsSection, memorySection, digitalTwinSection,
}) {
  const orchestrationSection = buildOrchestrationDoctrineSection(task);

  // Build context compaction section if task is retrying after a context-limit failure
  const compactionSection = task.metadata?.compaction?.needed ? buildCompactionSection(task) : '';

  // Task-metadata flags shared with the light path (see resolveTaskMetadataFlags).
  // `noCodeOutput` includes the Creative Director marker, so pre-upgrade `pending`
  // CD tasks are recognized without a metadata migration.
  const {
    willOpenPR, claimFlow, portosMergesBranch, prCompletion, simplifyEnabled, isReadOnly,
    discardWorktree, noCodeOutput, externalRepositoryOutput, toolFreeReasoning, sentinelPayloadOutput, noChangeSuccess,
    isReviewLoopFollowUp, isWorktreeOnExistingBranch,
  } = taskFlags;
  const whenDone = task.metadata?.whenDone === 'commit-push' ? 'commit-push' : 'leave-uncommitted';

  // Build pipeline context section if this is a pipeline stage
  const pipelineCtx = task.metadata?.pipeline;
  const pipelineLines = pipelineContextLines(pipelineCtx);
  const pipelineSection = pipelineLines.length
    ? `\n## Pipeline Context\n${pipelineLines.join('\n')}\n`
    : '';

  // Build simplify section if enabled. In the worktree-with-openPR flow the
  // system pushes and opens the PR after the agent exits, so the agent must
  // only commit (not push) — keep this wording aligned with the worktree
  // section above. TUI agents own the full simplify+push+PR sequence in the
  // Completion Workflow section below, so this section is suppressed for TUI.
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

  // Resolve the user's ordered reviewer list + flags (task metadata wins; else the
  // install's configured Code Review Defaults; else `[]`). Declared up here
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
  // A PR/MR review consumes public contributor-controlled content, so opening a
  // PR clamps `reviewerApplies` off (the policy documents the rule).
  const reviewPolicy = resolveReviewPolicy(task.metadata, codeReviewDefaults, defaultReviewers, { crossesPublicForge: willOpenPR });

  // TUI completion section — delegate to the shared light-path builder so
  // both prompt paths emit byte-identical workflows. (Background: TUI owns
  // its own `/simplify` → `/do:pr|/do:push` → sentinel sequence because the
  // slashdo submodule mounts those commands at project level. Writing the
  // sentinel is the done signal — PortOS finalizes via the watcher and kills
  // the session, so the prompt does NOT ask the agent to `/quit` (it's a UI
  // command the agent can't invoke). See `buildTuiCompletionSection` below.)
  // `null` under the auto-merge posture: there is no command to run — the step
  // is a plain commit (buildCompletionGuidelineBullet renders that case).
  const tuiCompletionCommand = willOpenPR ? '/do:pr' : portosMergesBranch ? null : '/do:push';
  const sentinelPath = resolveSentinelPath(worktreeInfo, workspaceDir, agentId);
  // THE completion decision, made once. Every section below renders this key;
  // none re-derives it. See lib/agent/agentCompletionMode.js for the rule order.
  const completionMode = resolveCompletionMode({
    taskHookType: resolveTaskHookType(task),
    toolFreeReasoning, sentinelPayloadOutput, noCodeOutput, externalRepositoryOutput, discardWorktree, claimFlow,
    isReadOnly, isReviewLoopFollowUp, isTui, canRunSlashCommands, portosMergesBranch,
    worktreeInfo, willOpenPR, slashdoCommand: task.metadata?.slashdoCommand,
  });
  const worktreeCommitNote = worktreeInfo
    ? worktreeCommitGuidance({
        isTui,
        mode: completionMode,
        canTypeSlashCommands: false,
        rendersInlinePrLifecycle: false,
        isWorktreeOnExistingBranch,
        willOpenPR,
        discardWorktree,
        claimFlow,
        noChangeSuccess,
        headIsDefaultBranch: worktreeInfo.headIsDefaultBranch === true,
      })
    : '';
  const worktreeSection = worktreeInfo ? `
## Git Worktree Context
You are working in an **isolated git worktree** to avoid conflicts with other agents working concurrently.
- **Branch**: \`${worktreeInfo.branchName}\`${worktreeBranchSuffix(worktreeInfo, isWorktreeOnExistingBranch)}
- **Worktree Path**: \`${worktreeInfo.worktreePath}\`
${worktreeInfo.baseBranch ? `- **Based on**: \`${worktreeInfo.baseBranch}\` (latest from origin)` : ''}

**Important**: ${worktreeCommitNote} ${[COMPLETION_MODES.RELEASE_FLOW, COMPLETION_MODES.AUDIT_FLOW, COMPLETION_MODES.RECONCILE_FLOW, COMPLETION_MODES.CHECKOUT_RECOVERY].includes(completionMode) ? 'Follow the bundled workflow branch instructions while preserving unrelated work.' : 'Do NOT manually switch branches or modify the worktree configuration.'}
${buildResumeSection(task, worktreeInfo)}` : '';

  const simplifySection = buildSimplifySection({
    mode: completionMode, canRunSlashCommands, simplifyEnabled, isTui, discardWorktree, claimFlow,
    worktreeInfo, willOpenPR, portosMergesBranch,
  });
  // Step 4, the Git Hygiene bullet and the commit-target bullet as ONE record,
  // so the three cannot contradict each other the way they did (#6616).
  const completionInstructions = buildFallbackCompletionInstructions({
    mode: completionMode, worktreeInfo, willOpenPR, tuiCompletionCommand,
  });
  // The `## Guidelines` completion bullet: same mode, rendered here so the
  // fallback template stays pure interpolation.
  const guidelineBullet = buildCompletionGuidelineBullet({
    mode: completionMode, whenDone,
    tuiCompletionCommand,
    worktreeInfo, willOpenPR, prCompletion, noChangeSuccess,
    humanLandsPr: leavesPrForHuman(task),
  });
  const completionBullet = guidelineBullet ? `- ${guidelineBullet}` : '';
  // Which completion section this mode gets. A mode with no entry renders
  // nothing HERE because the full path carries its contract elsewhere: the
  // review-loop follow-up has its own procedure section below, read-only and
  // the commit/push modes are covered by the Guidelines bullet and Git Hygiene.
  const completionSection = ({
    [COMPLETION_MODES.TOOL_FREE]: () => buildToolFreeReasoningCompletionSection(),
    [COMPLETION_MODES.SENTINEL_PAYLOAD]: () => buildProgrammaticOutputCompletionSection(sentinelPath),
    [COMPLETION_MODES.ACTION_OUTPUT]: () => buildActionOutputCompletionSection({ isTui, sentinelPath }),
    [COMPLETION_MODES.EXTERNAL_REPOSITORY]: () => buildExternalRepositoryCompletionSection({ isTui, sentinelPath }),
    [COMPLETION_MODES.DISCARD_WORKTREE]: () => buildProgrammaticOutputCompletionSection(sentinelPath),
    [COMPLETION_MODES.CLAIM_FLOW]: () => buildClaimFlowCompletionSection({
      isTui, sentinelPath, reviewersCsv: claimReviewersCsv(task, codeReviewDefaults, defaultReviewers),
      prStaysOpen: prStaysOpen(task),
      rawPrCompletion: task.metadata?.prCompletion || null,
      claimResume: claimResumeContext(task, worktreeInfo),
      swarmClaim: usesSwarmClaim(task),
      agentId,
      ...mergeAdmissionOptions(task),
      workflowScope: task.metadata?.forgeWorkflowScope || null,
      workflowScopeStagedPath,
      serverCheckout: isTruthyMeta(task.metadata?.claimServerCheckout),
    }),
    [COMPLETION_MODES.AUDIT_FLOW]: () => buildAuditFlowCompletionSection({ isTui, sentinelPath }),
    [COMPLETION_MODES.RECONCILE_FLOW]: () => buildReconcileFlowCompletionSection({ sentinelPath }),
    [COMPLETION_MODES.CHECKOUT_RECOVERY]: () => buildCheckoutRecoveryCompletionSection({ sentinelPath, ownership: task.metadata?.checkoutOwnership }),
    [COMPLETION_MODES.RELEASE_FLOW]: () => buildReleaseFlowCompletionSection({ isTui, isCli: providerType === PROVIDER_TYPES.CLI, sentinelPath }),
  }[completionMode] || (() => ''))();
  const tuiCompletionSection = [completionSection, buildAuditOutputCompletionSection(task, sentinelPath)]
    .filter(Boolean).join('\n\n');

  const {
    reviewLoopSection, reviewLoopFollowUpSection, jiraSection, skillSection, skillIndexSection,
    toolsSection, planningContextSection,
  } = await buildFullPathOptionalSections({
    task, workspaceDir, agentId, worktreeInfo, isTui, prCompletion, willOpenPR,
    reviewPolicy, isReviewLoopFollowUp, isFollowUpNeedingRecipes, localAgentLoopBody,
    skipDevContext,
  });

  // The task's prompt payload + human note as ONE block (#4153), taken from the
  // reviewer-visible projection so a Security Scan report meant for the human
  // never reaches a pipeline reviewer's prompt.
  const contextBlock = taskContextBlock(taskVisibleToPipelineReviewer(task));
  // Resolve the code forge even for Jira claims; attribution labels live on
  // the PR/MR, not the ticket. Creative Director runs need no dev contracts.
  const attributionOptions = skipDevContext ? null : {
    providerId, model: providerModel,
    forgeCli: await resolveManualForgeCli(workspaceDir, worktreeInfo, task),
  };
  const issueFilingSection = skipDevContext
    ? ''
    : [
      buildIssueFilingSection({ ...attributionOptions, taskBody: [task.description, contextBlock] }),
      buildPrAttributionSection(attributionOptions),
    ].filter(Boolean).join('\n\n');
  const uiAuditRuntimeSection = isUiAuditTask(task) ? buildUiAuditRuntimeRule(agentId) : '';

  return buildFullAgentPrompt({
    task, workspaceDir, agentInstructionsSection, memorySection, digitalTwinSection, contextBlock,
    worktreeSection, pipelineSection, jiraSection, orchestrationSection,
    issueFilingSection, simplifySection, tuiCompletionSection,
    reviewLoopSection, reviewLoopFollowUpSection, compactionSection, skillSection, skillIndexSection,
    toolsSection, planningContextSection, uiAuditRuntimeSection,
    completionBullet, completionInstructions, noChangeSuccess, completionMode,
  });
}

/**
 * The "## Simplify Step" section for the full (`api`) path — the
 * reuse/quality/efficiency self-review the agent runs before it commits.
 *
 * `/simplify` is a Claude Code built-in slash command, so only a session that
 * loaded its commands can run it; everyone else gets the inline equivalent
 * describing the same pass. Empty for the contracts that never commit.
 */
function buildSimplifySection({
  mode, canRunSlashCommands, simplifyEnabled, isTui, discardWorktree, claimFlow,
  worktreeInfo, willOpenPR, portosMergesBranch,
}) {
  const simplifyInstruction = canRunSlashCommands
    ? 'run `/simplify` to review the changed code for reuse, quality, and efficiency'
    : SIMPLIFY_INLINE_REVIEW;
  // Discard tasks don't commit, so the simplify-before-commit step is moot.
  const simplifySection = ![COMPLETION_MODES.ACTION_OUTPUT, COMPLETION_MODES.EXTERNAL_REPOSITORY, COMPLETION_MODES.RELEASE_FLOW, COMPLETION_MODES.AUDIT_FLOW, COMPLETION_MODES.RECONCILE_FLOW, COMPLETION_MODES.CHECKOUT_RECOVERY].includes(mode) && simplifyEnabled && !isTui && !discardWorktree && !claimFlow ? `
## Simplify Step
After completing your work and before committing, ${simplifyInstruction}. Fix any issues found, then ${worktreeInfo && willOpenPR ? 'commit your changes (do NOT push — on a successful run the system will push and open the PR after you exit; if the run fails, no push or PR happens)' : portosMergesBranch ? 'commit your changes (do NOT push — PortOS merges this branch back into the source checkout after you exit; a pushed copy would only be left behind on origin)' : 'commit and push using `/do:push`'}.
` : '';
  return simplifySection;
}

/**
 * The full (`api`) path's per-task optional sections: the review-loop notice,
 * the review-loop follow-up procedure, JIRA context, the auto-matched skill
 * templates, the tools summary and any `.planning/` context.
 *
 * Each is independent of the others and of the completion contract — lifting
 * them out of `buildAgentPrompt` keeps that function about ORDER (resolve,
 * then render) rather than about every section's presence test.
 */
async function buildFullPathOptionalSections({
  task, workspaceDir, agentId, worktreeInfo, isTui, prCompletion, willOpenPR,
  reviewPolicy, isReviewLoopFollowUp, isFollowUpNeedingRecipes, localAgentLoopBody,
  skipDevContext,
}) {
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
After your task completes, the system will spawn a follow-up agent that runs the review-and-fix loop until all configured reviewers are satisfied, then merges the PR. The follow-up uses **${reviewPolicy.reviewers.join(' → ')}** (in order). ${reviewPolicy.reviewers[0] === DEFAULT_REVIEWER
    ? 'Copilot leads the list, so for GitHub PRs the system pre-requests its initial review automatically (skipped on GitLab MRs and other non-GitHub forges); the follow-up then drives the rest of the chain.'
    : reviewPolicy.reviewers.includes(DEFAULT_REVIEWER)
      ? 'The follow-up invokes the CLI reviewers itself and requests Copilot at its turn (Copilot is GitHub-only, so it is skipped on non-GitHub forges).'
      : 'The follow-up agent will invoke the configured CLI reviewers directly to critique the PR diff, then iterate on their feedback.'} You do not need to open the PR, trigger the review, or address feedback yourself — focus on producing high-quality, well-tested code so the review passes go cleanly.
` : '';

  // Build review-loop follow-up section. This is the agent that addresses Copilot's
  // feedback iteratively and merges the PR — spawned by the previous agent's cleanup
  // hook (see spawnReviewLoopFollowUp in agentLifecycle.js). It needs the full /do:rpr
  // procedure inlined because the agent runs in a one-shot session and won't trigger
  // a slash command itself.
  let reviewLoopFollowUpSection = '';
  if (isReviewLoopFollowUp) {
    // `/do:rpr` is the Copilot/@github comment-resolution procedure — a merge-only
    // follow-up has no review to resolve, so skip the ~35KB read for it.
    const rprBody = isFollowUpNeedingRecipes ? await loadSlashdoFile('rpr').catch(() => null) : null;
    // localAgentLoopBody (the CLI-reviewer recipe) was already preloaded at the
    // top of buildAgentPrompt under the same reviewLoopFollowUp guard — reuse it
    // rather than re-reading the lib a second time.
    reviewLoopFollowUpSection = buildReviewLoopFollowUpSection(reviewLoopPromptMetadata(task, worktreeInfo, reviewPolicy.reviewerCatalogs), { verbose: true, rprBody, localAgentLoopBody, mergeHandoff: mergeHandoffEnabled(task) });
    if (!isTruthyMeta(task.metadata?.reviewLoopLeaveOpen)) reviewLoopFollowUpSection += '\n\n' + buildMergeAdmissionSection(agentId, mergeAdmissionOptions(task));
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
  } else if (repositoryCleanupMergeTarget(task)) {
    // A repository-cleanup recovery lands its parent PR under the same lease (#12251).
    reviewLoopFollowUpSection = buildMergeAdmissionSection(agentId, mergeAdmissionOptions(task));
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
  // Level 0 of the Skill Registry (#17387): ids and one-line descriptions only,
  // so the briefing stays lean; the agent loads a full skill with skills.view.
  // Lazy and failure-tolerant: a broken skill tree must never block a spawn.
  const skillIndexSection = await import('../skills/skillService.js')
    .then(({ buildSkillIndexPromptSection }) => buildSkillIndexPromptSection({ appId: task.metadata?.app || undefined }))
    .catch((err) => {
      console.log(`⚠️ Skill index unavailable for the agent briefing: ${err.message}`);
      return '';
    });

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
  return {
    reviewLoopSection, reviewLoopFollowUpSection, jiraSection, skillSection, skillIndexSection,
    toolsSection, planningContextSection,
  };
}

/**
 * The prompt for the full (`api`) path. It is the only briefing an API-provider
 * agent receives; there is no user-editable template for it (#8200).
 *
 * Pure string assembly, deliberately separate from `buildAgentPrompt`: every
 * optional section it interpolates is decided by the caller, so the
 * orchestrator reads as "resolve the sections, then render" instead of
 * carrying each section's presence ternary in its own body.
 */
function buildFullAgentPrompt({
  task, workspaceDir, agentInstructionsSection, memorySection, digitalTwinSection, contextBlock,
  worktreeSection, pipelineSection, jiraSection, orchestrationSection,
  issueFilingSection, simplifySection, tuiCompletionSection,
  reviewLoopSection, reviewLoopFollowUpSection, compactionSection, skillSection, skillIndexSection,
  toolsSection, planningContextSection, uiAuditRuntimeSection,
  completionBullet, completionInstructions, noChangeSuccess, completionMode,
}) {
const taskBlock = buildTaskBlock(task, { screenshotsAsList: false });

// The full-path briefing
return `${agentInstructionsSection || ''}

${memorySection || ''}
${digitalTwinSection ? `\n${digitalTwinSection}\n` : ''}

${task.metadata?.prCompletion === PR_COMPLETIONS.DRAFT ? DRAFT_PR_RULE : ''}
${taskBlock.description}
${contextBlock ? (contextBlock.includes('\n') ? `\n### Task Context\n\n${contextBlock.trimEnd()}\n` : `\n### Task Context\n\n${contextBlock}\n`) : ''}
${taskBlock.screenshots}
${taskBlock.attachments}
${worktreeSection}
${pipelineSection}
${jiraSection}
${orchestrationSection ? `${orchestrationSection}\n` : ''}${issueFilingSection ? `${issueFilingSection}\n` : ''}${simplifySection}
${tuiCompletionSection}
${buildUnnecessaryDispatchSection(task)}
${reviewLoopSection}
${reviewLoopFollowUpSection}
${compactionSection}
${skillSection ? `## Task-Type Skill Guidelines\n\n${skillSection}\n` : ''}${skillIndexSection ? `\n${skillIndexSection}\n` : ''}${toolsSection ? `\n${toolsSection}\n` : ''}${planningContextSection}
## Instructions
1. Analyze the task requirements carefully
2. Make necessary changes to complete the task
3. Test your changes when possible
4. ${completionInstructions.step4}
5. Provide a summary of what was done

## Guidelines
- Focus only on the assigned task
- Make minimal, targeted changes
- Follow existing code patterns and conventions
- Do not make unrelated changes
- If blocked, explain clearly why
- Never update the PortOS changelog (\`.changelog/\`) for work on managed apps — the PortOS changelog tracks PortOS core changes only
${completionBullet}

## Git Hygiene (CRITICAL)
${completionMode === COMPLETION_MODES.CHECKOUT_RECOVERY ? `- Inspect pending work and active ownership before changing the checkout. Account for pre-existing unique work only within this recovery task's scope, with verified backups and explicit preservation branches. Stage specific files; never use \`git add -A\` or \`git add .\`.
- Never create or pop a stash. Inspect existing stashes and retire only entries accounted for by SHA after publication or proven redundancy; preserve every unaccounted entry and active owner's work.` : `- **Before starting work**, run \`git status\` to verify a clean working tree. Do NOT stash or discard uncommitted changes — other agents may be working concurrently and expecting those changes to be present. If the tree is dirty, only commit files YOU changed for this task.
- **NEVER use \`git stash\`** in any form (\`git stash push\`, \`git stash pop\`, etc.). This is a multi-agent system — stashing can silently destroy or corrupt another agent's or the user's in-progress work. Work around uncommitted changes instead. (Note: the backend may use \`--autostash\` in user-triggered pull operations — that is safe because those are single-user UI actions, not concurrent agent operations.)
- **Only commit files YOU changed** for this task. Never use \`git add -A\` or \`git add .\` — always stage specific files by name.`}
${noChangeSuccess ? `- **No-change audits may exit cleanly.** ${NO_CHANGE_AUDIT_GUIDANCE}` : ''}
${completionInstructions.gitHygiene}
${completionInstructions.commitTarget}

## Working Directory
${task.metadata?.app ? `You are working in the target app directory: \`${workspaceDir}\`. All code changes, research, plans, and docs for this task belong in this directory — NOT in the PortOS repo.` : 'You are working in the project directory.'} Use the available tools to explore, modify, and test code.

${UNATTENDED_RUN_RULE}
${uiAuditRuntimeSection ? `\n${uiAuditRuntimeSection}` : ''}

${PM2_SAFETY_RULE}

Begin working on the task now.`;
}
