/**
 * Server-side contract for the pr-reviewer pipeline.
 *
 * Three stages, two of them owned here in full. Security Scan (stage 0) is a
 * server-side preflight, not an agent: `runPrReviewerSecurityPreflight` lists
 * the external open PRs, runs the model-abuse scan through the direct no-tools
 * path, and writes a synthetic stage-0 result into the task metadata so the
 * rest of task creation cannot tell it from a real agent hand-off. The
 * Eligibility Gate is a reasoning-only, tool-free stage whose only durable
 * result is a boolean allowlist. The Actions stage reuses issue-watcher's
 * deterministic forge coordinator after the eligible set has been narrowed.
 *
 * `ensurePrReviewerPipeline` normalizes the stage list; `processTaskOutput`
 * validates what the agent stages return. Keeping that output wrapper separate
 * means the action hook cannot accidentally consume an eligibility response,
 * and eligibility reasons can never cross into the action stage.
 *
 * `cosTaskGenerator.js` composes the preflight into task generation: it owns
 * the spawn ladder and the gates around this one, never the scan itself.
 */

import { MODEL_ABUSE_GUARD_ID, isSha256Hex, issuePrerequisiteWaived, normalizeEligibilityFacts } from '../lib/modelAbuseGuard.js';
import { PUBLIC_REVIEW_GATE_EXECUTION_PROFILE } from '../lib/agentExecutionProfiles.js';
import { PIPELINE_STAGE_BEHAVIOR_FLAGS } from '../lib/cosValidation.js';
import { createPrReviewerDefaultStages } from './taskScheduleRegistry.js';
import { getCosTasks } from './cosTaskStore.js';
import { emitLog } from './cosEvents.js';
import {
  isTaskOutputPayload as isIssueWatcherPayload,
  processTaskOutput as processIssueWatcherOutput,
} from './issueWatcher.js';

const HEAD_SHA_RE = /^[a-f0-9]{40}$/i;
const MAX_REASON_CHARS = 2_000;

const roleForPromptKey = (promptKey) => ({
  'pr-reviewer-security': 'security',
  'pr-reviewer-eligibility': 'eligibility',
  'pr-reviewer-review': 'actions',
}[promptKey] || null);

export function prReviewerStageRole(stage) {
  if (['security', 'eligibility', 'actions'].includes(stage?.role)) return stage.role;
  return roleForPromptKey(stage?.promptKey);
}

function stageWithContract(stage, role) {
  const base = { ...(stage || {}), role, managed: true, readOnly: true };
  if (role === 'security') {
    return {
      ...base,
      promptKey: 'pr-reviewer-security',
      guardId: MODEL_ABUSE_GUARD_ID,
    };
  }
  // Review yields a validated proposal. Screened code is never safe to execute.
  const executionProfile = PUBLIC_REVIEW_GATE_EXECUTION_PROFILE;
  return {
    ...base,
    promptKey: role === 'eligibility' ? 'pr-reviewer-eligibility' : 'pr-reviewer-review',
    useWorktree: true,
    openPR: false,
    simplify: false,
    reviewLoop: false,
    discardWorktree: true,
    noCodeOutput: true,
    executionProfile,
  };
}

/**
 * Normalize a pr-reviewer pipeline before it is initialized. Old persisted
 * schedules used two stages and unlabelled stage objects; insert the mandatory
 * gate while preserving the old review stage's provider/model/effort pins as
 * the optional Actions stage. The operation is idempotent.
 */
export function ensurePrReviewerPipeline(metadata) {
  const stages = metadata?.pipeline?.stages;
  if (!Array.isArray(stages) || stages.length === 0) return metadata;

  const defaultStages = createPrReviewerDefaultStages();
  const firstIsSecurity = prReviewerStageRole(stages[0]) === 'security';
  const security = stageWithContract(firstIsSecurity ? stages[0] : defaultStages[0], 'security');
  const candidates = firstIsSecurity ? stages.slice(1) : stages;
  const eligibilityCandidate = candidates.find((stage) => prReviewerStageRole(stage) === 'eligibility');
  const eligibility = stageWithContract(eligibilityCandidate || defaultStages[1], 'eligibility');
  const actionCandidates = candidates.filter((stage) => stage !== eligibilityCandidate);
  const actions = actionCandidates.map((stage) => stageWithContract(stage, 'actions'));
  const nextStages = [security, eligibility, ...actions];
  metadata.pipeline = { ...metadata.pipeline, stages: nextStages };
  return metadata;
}

const SECURITY_SCAN_ACTIVE_TASK_STATUSES = new Set(['pending', 'in_progress', 'blocked'])
const SECURITY_SCAN_PIPELINE_OUTPUT_MAX_CHARS = 11_000

function securityScanReports(scan) {
  if (Array.isArray(scan?.reports)) return scan.reports
  if (Array.isArray(scan?.reviewedPrs)) return scan.reviewedPrs
  return []
}

const reportIsSafe = (report) => report?.safe === true

const reportFindingCount = (report) => (
  Array.isArray(report?.securityFindings) && report.securityFindings.length > 0
    ? report.securityFindings.length
    : reportIsSafe(report) ? 0 : 1
)

/**
 * Serialize only the trust decision needed by the app-code reviewer. The
 * human-facing report and the raw model response deliberately never cross
 * this boundary: even a report that calls itself an explanation is still
 * untrusted model output and could contain a second prompt injection.
 */
export function buildSecurityScanPipelineOutput(scan, reports, status) {
  const base = {
    securityScan: status,
    scanCode: scan.code || null,
    reviewedCount: reports.length,
    reviewedPrs: [],
  }
  const included = []
  for (const report of reports) {
    const candidate = {
      number: report.number,
      safe: reportIsSafe(report),
      headRefOid: reportIsSafe(report) && typeof report.headRefOid === 'string' ? report.headRefOid : null,
      findingCount: reportFindingCount(report),
    }
    const next = JSON.stringify({ ...base, reviewedPrs: [...included, candidate] })
    if (next.length <= SECURITY_SCAN_PIPELINE_OUTPUT_MAX_CHARS) {
      included.push(candidate)
      continue
    }
    return JSON.stringify({ ...base, complete: false, reviewedPrs: included })
  }
  return JSON.stringify({ ...base, complete: true, reviewedPrs: included })
}

/**
 * Name the single PR a targeted pr-reviewer run covers. The number goes in the
 * FIRST line specifically: `addTask`'s duplicate guard keys on (first line +
 * app), so without it, targeting a second PR while the first run is still in
 * flight would be rejected as a duplicate of it. The trailing sentence repeats
 * the scope for the agent; the header keeps its `[Improvement: <app>] …` shape
 * so the CoS queue still reads the same way.
 */
export function scopeDescriptionToPullRequest(description, metadata) {
  const number = metadata?.targetPullRequest;
  if (!number) return description;
  const [firstLine, ...rest] = description.split('\n');
  return [
    `${firstLine} — pull request #${number} only`,
    ...rest,
    '',
    `This run is scoped to pull request #${number}: it is the only request the server cleared, and the only one this run may act on.`,
  ].join('\n');
}

function formatSecurityScanContext(scan, reports, status) {
  const findingCount = reports.filter((report) => !reportIsSafe(report)).length
  return [
    `Security scan status: ${status}.`,
    `Reviewed ${reports.length} external pull request${reports.length === 1 ? '' : 's'}${findingCount ? `; ${findingCount} contained model-abuse flags or an unvalidated response` : ''}.`,
    'No GitHub pull request or issue actions have been taken.',
    status === 'findings'
      ? 'This scan is only a model-abuse boundary. Flagged PR content and its source text are withheld from the Eligibility Gate; the gate may process only PRs explicitly marked safe and must not fetch or inspect flagged PRs.'
      : status === 'unavailable'
        ? `The scan stopped with ${scan.code || 'an unknown error'} after retaining the reports collected so far. No PR has a safe status; leave every PR untouched until the scan can be completed.`
        : 'All reviewed PRs have an explicit model-abuse safety status. The Eligibility Gate may process only the PRs marked safe, after approval.',
  ].join('\n')
}

async function findActiveSecurityScanTask(appId, scanKey) {
  if (!scanKey) return { unavailable: false, task: null }
  const cosTasks = await getCosTasks().catch(() => null)
  if (!cosTasks) return { unavailable: true, task: null }
  const task = cosTasks.tasks?.find((candidate) => (
    SECURITY_SCAN_ACTIVE_TASK_STATUSES.has(candidate.status)
    && candidate.metadata?.analysisType === 'pr-reviewer'
    && candidate.metadata?.app === appId
    && candidate.metadata?.pipeline?.securityScan?.scanKey === scanKey
  )) || null
  return { unavailable: false, task }
}

/**
 * Run pr-reviewer's Security Scan through the direct local, no-tools path and
 * hand only safe PR metadata to the Eligibility Gate. A normal stage-0 agent
 * is intentionally never spawned: `readOnly` is prompt guidance, not an OS
 * sandbox, and the generic agent resolver rejects API providers anyway.
 *
 * External contributor PRs are held for human approval before the stage that
 * can review, comment, or merge. The preflight itself remains read-only and
 * does not checkout or execute any contributor branch.
 *
 * `targetPullRequest` narrows the run to ONE open PR — the per-row "Review this
 * PR" trigger on an app's PRs / MRs tab. The narrowing happens BEFORE the
 * fingerprint and the security scan, so every downstream contract (scan key,
 * public-review snapshot, `issueWatcher.pullRequests` coverage, and the output
 * hook's strict envelope check) is scoped to that one PR by construction rather
 * than by a prompt asking the agent to ignore the rest.
 */
export async function runPrReviewerSecurityPreflight(taskType, app, metadata, targetPullRequest = null, taskSchedule = null) {
  if (taskType !== 'pr-reviewer') return { skipped: false };

  // A churn park has to be a STOP, not just a log line (#6124). pr-reviewer runs
  // on the ON_DEMAND cadence, and `shouldRunTask` only reads `parkedUntil` on a
  // `perpetual` interval — so the park `observeAgentChurn` stamps when a stage
  // loops ("parked ${type} so the loop stops burning quota") gated nothing, and
  // the drain regenerated a fresh task seconds later. Ask here, the one place
  // every pr-reviewer run is built, and ask BEFORE the security scan so a parked
  // type does not keep paying for the preflight it is only going to discard.
  // A human "Run" is unaffected: applyOnDemandRunResets clears the park for a
  // USER-origin request before it reaches generation.
  if (taskSchedule && await taskSchedule.isPerpetualParkActive(taskType, app.id)) {
    const reason = 'parked';
    emitLog('info', `Skipping pr-reviewer for ${app.name}: ${reason} until its recheck cadence`, { appId: app.id, analysisType: taskType });
    return { skipped: true, reason };
  }

  const stages = metadata.pipeline?.stages;
  const securityStage = stages?.[0];
  let nextStage = stages?.[1];
  if (!securityStage || !nextStage) {
    const reason = 'pipeline-misconfigured';
    emitLog('warn', `Skipping pr-reviewer for ${app.name}: ${reason} — security pipeline requires an eligibility gate`, { appId: app.id, analysisType: taskType });
    return { skipped: true, reason };
  }

  const { listExternalOpenPullRequests, runPrReviewerSecurityScan, securityScanFingerprint } = await import('./prReviewerSecurity.js');
  const { writePublicReviewInputSnapshot } = await import('./modelAbuseGuard.js');
  let target = await listExternalOpenPullRequests(app);
  if (!target.ok) {
    const reason = target.code || 'security-scan-target-unavailable';
    emitLog('warn', `Skipping pr-reviewer for ${app.name}: ${reason}`, { appId: app.id, analysisType: taskType });
    return { skipped: true, reason };
  }
  if (target.prs.length === 0) {
    const reason = 'no-external-open-prs';
    emitLog('info', `Skipping pr-reviewer for ${app.name}: ${reason}`, { appId: app.id, analysisType: taskType });
    return { skipped: true, reason };
  }
  if (targetPullRequest) {
    const scoped = target.prs.filter((pr) => pr.number === targetPullRequest);
    if (scoped.length === 0) {
      const reason = 'target-pull-request-not-reviewable';
      emitLog('warn', `Skipping pr-reviewer for ${app.name}: ${reason} (#${targetPullRequest})`, { appId: app.id, analysisType: taskType });
      return { skipped: true, reason };
    }
    // A maintainer pressed "Review this PR" on this row. The linked-open-issue
    // prerequisite exists to bound UNATTENDED spend on unsolicited PRs; an
    // explicit per-PR request is the maintainer choosing to spend that review,
    // so the fact set records the waiver. The Eligibility Gate still judges the
    // change itself, and Stage 1 still screens it. Stamped BEFORE the
    // fingerprint so a targeted run never shares a scan key with a sweep.
    target = {
      ...target,
      prs: scoped.map((pr) => ({ ...pr, eligibilityFacts: { ...normalizeEligibilityFacts(pr.eligibilityFacts), maintainerTargeted: true } })),
    };
    metadata.targetPullRequest = targetPullRequest;
  }
  const scanKey = securityScanFingerprint(target);
  const active = await findActiveSecurityScanTask(app.id, scanKey);
  if (active.unavailable) {
    const reason = 'security-scan-task-state-unavailable';
    emitLog('warn', `Skipping pr-reviewer for ${app.name}: ${reason}`, { appId: app.id, analysisType: taskType });
    return { skipped: true, reason };
  }
  if (active.task) {
    emitLog('info', `Skipping pr-reviewer for ${app.name}: security-scan-report-pending`, { appId: app.id, analysisType: taskType, taskId: active.task.id });
    return { skipped: true, reason: 'security-scan-report-pending', task: active.task };
  }

  const scan = await runPrReviewerSecurityScan({
    app,
    target,
    largeInputFallback: securityStage.largeInputFallback,
  });
  const reports = securityScanReports(scan);
  if (!scan.ok && !reports.length) {
    const reason = scan.code || 'security-scan-not-passed';
    emitLog('warn', `Skipping pr-reviewer for ${app.name}: ${reason}`, { appId: app.id, analysisType: taskType });
    return { skipped: true, reason };
  }

  if (scan.ok && scan.usedLargeInputFallback) {
    // A configured fallback replaces the reasoning stages only. The complete
    // evidence has already passed the same mandatory security boundary.
    const fallback = securityStage.largeInputFallback;
    metadata.pipeline.stages = stages.map((stage, index) => index === 0 ? stage : {
      ...stage, providerId: fallback.providerId, model: fallback.model, effort: fallback.effort || null,
    });
    nextStage = metadata.pipeline.stages[1];
  }

  const status = !scan.ok ? 'unavailable' : (scan.passed ? 'passed' : 'findings');
  const snapshotWritten = await writePublicReviewInputSnapshot({
    scanKey: scan.scanKey || scanKey,
    pullRequests: scan.ok ? (scan.reviewInputs || []) : [],
  });
  if (!snapshotWritten) {
    const reason = 'public-review-input-snapshot-failed';
    emitLog('warn', `Skipping pr-reviewer for ${app.name}: ${reason}`, { appId: app.id, analysisType: taskType });
    return { skipped: true, reason };
  }
  const reviewOutput = buildSecurityScanPipelineOutput(scan, reports, status);
  // A partial/unavailable scan is never a usable allowlist. Keeping already
  // safe-looking reports here would let a later stage review a subset while
  // the remaining PRs had no completed safety verdict.
  const safeReports = scan.ok ? reports.filter(reportIsSafe) : [];
  metadata.pipeline = {
    ...metadata.pipeline,
    currentStage: 1,
    stageResults: [{
      stage: 0,
      name: securityStage.name,
      agentId: null,
      success: scan.ok,
      completedAt: new Date().toISOString(),
      summary: {
        guardId: scan.guardId || MODEL_ABUSE_GUARD_ID,
        guardModel: scan.guardModel || null,
        guardRevision: scan.guardRevision || null,
        code: scan.code || null,
        reviewedPrCount: reports.length,
        findingCount: reports.filter((report) => !reportIsSafe(report)).length,
        reportStatus: status,
      },
    }],
    previousStageAgentId: null,
    previousStageOutput: reviewOutput,
    securityScan: {
      usedLargeInputFallback: scan.usedLargeInputFallback === true,
      completed: scan.ok,
      status,
      code: scan.code || null,
      guardId: scan.guardId || MODEL_ABUSE_GUARD_ID,
      guardModel: scan.guardModel || null,
      guardRevision: scan.guardRevision || null,
      layers: scan.layers || null,
      repoFullName: scan.repoFullName || target.repoFullName,
      defaultBranch: scan.defaultBranch || target.defaultBranch,
      scanKey: scan.scanKey || scanKey,
      reviewedPrCount: reports.length,
      findingCount: reports.filter((report) => !reportIsSafe(report)).length,
      reports,
      noActionsTaken: true,
      safePrCount: safeReports.length,
    },
  };
  const safeInputByNumber = new Map((scan.reviewInputs || []).map((input) => [input.number, input]));
  metadata.issueWatcher = {
    repoFullName: scan.repoFullName || target.repoFullName,
    defaultBranch: scan.defaultBranch || target.defaultBranch,
    issueComments: [],
    pullRequests: safeReports.map((report) => ({
      number: report.number,
      headSha: report.headRefOid,
      authorLogin: safeInputByNumber.get(report.number)?.authorLogin || null,
      eligibilityFacts: safeInputByNumber.get(report.number)?.eligibilityFacts || null,
      diffTruncated: false,
      contentFingerprint: report.contentFingerprint,
    })),
    strictPullRequestCoverage: true,
  };
  metadata.executionProfile = nextStage.executionProfile || null;
  metadata.pipeline.reviewInputKey = scan.scanKey || scanKey;
  metadata.context = formatSecurityScanContext(scan, reports, status);

  // Apply the next stage's provider/model/effort and behavior flags exactly as
  // the ordinary agent-completion hand-off does. Keeping this in the generator
  // makes the synthetic stage-0 result indistinguishable from a real one to
  // the rest of task creation.
  metadata.readOnly = nextStage.readOnly ?? false;
  if (nextStage.model) metadata.model = nextStage.model;
  if (nextStage.providerId) {
    metadata.provider = nextStage.providerId;
    metadata.providerId = nextStage.providerId;
  }
  if (scan.usedLargeInputFallback) delete metadata.effort;
  if (nextStage.effort) metadata.effort = nextStage.effort;
  const nextStageReadOnly = nextStage.readOnly ?? false;
  const taskDefaults = metadata.pipeline.taskDefaults || {};
  for (const flag of PIPELINE_STAGE_BEHAVIOR_FLAGS) {
    if (flag in nextStage) {
      metadata[flag] = nextStage[flag];
    } else if (nextStageReadOnly) {
      metadata[flag] = false;
    } else if (flag in taskDefaults) {
      metadata[flag] = taskDefaults[flag];
    }
  }

  // No forced human approval here. The pipeline's own gates bound what an
  // external PR can do: Stage 1 already screened it, the Eligibility Gate is
  // tool-free, and Stage 3 runs sandboxed with the deterministic coordinator
  // owning every forge mutation. Forcing approval on every scanned PR held
  // the cheap tool-free gate behind a click on each run, including a targeted
  // "Review this PR" the maintainer had just pressed. The schedule's own
  // "Require approval" toggle (metadata.requireApproval from the interval
  // config) still holds the run when the user asks for that.
  emitLog(
    status === 'passed' ? 'info' : 'warn',
    `pr-reviewer security scan ${status} for ${app.name}: ${reports.length} external PR(s)`,
    { appId: app.id, analysisType: taskType },
  );
  return { skipped: false, scan };
}

function normalizedExpectedPullRequests(task) {
  const expected = task?.metadata?.issueWatcher;
  if (!expected || expected.strictPullRequestCoverage !== true || !Array.isArray(expected.pullRequests)) return null;
  const seen = new Set();
  const pullRequests = [];
  for (const item of expected.pullRequests) {
    if (!Number.isInteger(item?.number) || item.number < 1 || seen.has(item.number)) return null;
    if (!HEAD_SHA_RE.test(item.headSha) || !isSha256Hex(item.contentFingerprint)) return null;
    if (typeof item.authorLogin !== 'string' || !item.authorLogin.trim()) return null;
    seen.add(item.number);
    pullRequests.push({
      number: item.number,
      headSha: item.headSha,
      contentFingerprint: item.contentFingerprint,
      authorLogin: item.authorLogin,
      eligibilityFacts: normalizeEligibilityFacts(item.eligibilityFacts),
    });
  }
  return pullRequests;
}

// `facts` is already normalized by normalizedExpectedPullRequests.
function eligibilityFactsAllow(facts) {
  // The model's own quality verdict still applies to a waived PR.
  if (issuePrerequisiteWaived(facts)) return true;
  if (!facts.issueLookupComplete) return false;
  // "Related to a filed issue" is only half the bar: the gate also has to have
  // judged the diff against what that issue actually asks for. No screened
  // issue text reached it, no intent verdict is possible, so the answer is no —
  // a model that answered `eligible` without the requirement in front of it
  // guessed. A fact set the current preflight built always carries this
  // whenever the open/assigned check below passes, so in practice this rejects
  // a set persisted before intent screening existed, or one that never came
  // from the preflight at all.
  if (!facts.intentFingerprint) return false;
  const linked = new Set(facts.linkedIssueNumbers);
  const open = new Set(facts.openLinkedIssueNumbers);
  return facts.openerAssignedIssueNumbers.some((number) => linked.has(number) && open.has(number));
}

function validateEligibilityDecision(raw, expected) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.number) || raw.number < 1 || !HEAD_SHA_RE.test(raw.headSha)) return null;
  if (typeof raw.eligible !== 'boolean' || typeof raw.reason !== 'string') return null;
  const reason = raw.reason.trim();
  if (!reason || reason.length > MAX_REASON_CHARS) return null;
  const target = expected.get(raw.number);
  if (!target || target.headSha !== raw.headSha) return null;
  return {
    number: raw.number,
    headSha: raw.headSha,
    eligible: raw.eligible && eligibilityFactsAllow(target.eligibilityFacts),
  };
}

function invalidEligibility(reason, message = 'The eligibility gate did not return a complete validated decision set') {
  return { action: 'no-op', accepted: false, reason, message };
}

/**
 * A stage agent that finished having written NO parseable deliverable at all
 * (#6124). This is NOT the same as a payload the validator rejected: there is
 * nothing to re-read, so the identical stage re-dispatches into the identical
 * empty result — the shape that burned ~20 spawns in five minutes while the
 * churn park logged that it had stopped the loop.
 *
 * `permanent: true` is the posture `resolvePublicReviewAgentProvider` already
 * uses when no provider can enforce the stage's contract: surface a blocked
 * task carrying the reason instead of retrying it. Finalization only honours
 * the flag when the run named no other cause (see agentFinalization), so a
 * rate-limited or unauthenticated run still gets its ordinary retries.
 */
function stageProducedNoOutput(role) {
  return {
    action: 'no-op',
    accepted: false,
    permanent: true,
    reason: 'stage-produced-no-output',
    message: `The pr-reviewer ${role || 'pipeline'} stage agent finished without writing any parseable output`,
  };
}

function processEligibilityTaskOutput({ appId, success, payload, task } = {}) {
  if (!appId) return invalidEligibility('missing-app');
  if (!success) return invalidEligibility('agent-failed', 'The eligibility gate agent failed before returning a decision');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.decisions)) {
    return invalidEligibility('eligibility-response-invalid');
  }
  if (typeof payload.eligible !== 'boolean') return invalidEligibility('eligibility-response-invalid');

  const expectedList = normalizedExpectedPullRequests(task);
  if (!expectedList) return invalidEligibility('missing-eligibility-metadata');
  const expected = new Map(expectedList.map((item) => [item.number, item]));
  const decisions = [];
  const seen = new Set();
  for (const raw of payload.decisions) {
    if (seen.has(raw?.number)) return invalidEligibility('eligibility-response-incomplete');
    const decision = validateEligibilityDecision(raw, expected);
    if (!decision) return invalidEligibility('eligibility-response-invalid');
    seen.add(decision.number);
    decisions.push(decision);
  }
  if (decisions.length !== expected.size || seen.size !== expected.size) {
    return invalidEligibility('eligibility-response-incomplete');
  }
  // The outer flag is redundant but useful as a tamper-evident envelope field.
  // Compare it with the model's own per-PR answers before applying the stricter
  // server-side issue/assignment facts above.
  const modelEligible = payload.decisions.some((decision) => decision?.eligible === true);
  if (payload.eligible !== modelEligible) return invalidEligibility('eligibility-response-contradictory');

  const eligibleNumbers = decisions.filter((decision) => decision.eligible).map((decision) => decision.number);
  const rejectedNumbers = decisions.filter((decision) => !decision.eligible).map((decision) => decision.number);
  const nextIssueWatcher = {
    ...task.metadata.issueWatcher,
    pullRequests: expectedList
      .filter((item) => eligibleNumbers.includes(item.number))
      .map((item) => ({
        number: item.number,
        headSha: item.headSha,
        contentFingerprint: item.contentFingerprint,
        authorLogin: item.authorLogin,
        eligibilityFacts: item.eligibilityFacts,
        diffTruncated: false,
      })),
  };
  const eligibility = {
    complete: true,
    evaluatedCount: decisions.length,
    eligibleNumbers,
    rejectedNumbers,
    decisions,
  };
  const previousStageOutput = JSON.stringify({
    eligibility: 'passed',
    complete: true,
    evaluatedCount: decisions.length,
    eligibleNumbers,
    rejectedNumbers,
  });
  return {
    action: 'eligibility-evaluated',
    accepted: true,
    terminal: eligibleNumbers.length === 0,
    taskMetadata: {
      issueWatcher: nextIssueWatcher,
      prReviewerEligibility: eligibility,
      pipeline: {
        ...task.metadata.pipeline,
        eligibility,
        previousStageOutput,
        ...(eligibleNumbers.length === 0
          ? { status: 'filtered', terminalReason: 'no-eligible-prs' }
          : {}),
      },
    },
  };
}

export function isEligibilityPayload(payload) {
  return Boolean(payload && typeof payload === 'object' && !Array.isArray(payload)
    && typeof payload.eligible === 'boolean' && Array.isArray(payload.decisions));
}

export function isTaskOutputPayload(payload) {
  return isEligibilityPayload(payload) || isIssueWatcherPayload(payload);
}

export async function processTaskOutput(args = {}, deps) {
  const role = prReviewerStageRole(args.task?.metadata?.pipeline?.stages?.[args.task?.metadata?.pipeline?.currentStage ?? 0]);
  // Checked before the role switch: every stage of this pipeline delivers its
  // result as a parsed sentinel payload, so "no payload at all" is the same
  // permanent failure whichever stage produced it, and answering it here keeps
  // the per-role validators about the CONTENT of a payload that exists.
  if (args.payload == null) return stageProducedNoOutput(role);
  if (role === 'eligibility') return processEligibilityTaskOutput(args);
  if (role === 'actions') return processIssueWatcherOutput({ ...args, requireEligibilityFacts: true }, deps);
  return invalidEligibility('unsupported-pr-review-stage');
}
