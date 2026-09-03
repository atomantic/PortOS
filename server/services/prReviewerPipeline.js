/**
 * Role-aware output contract for the pr-reviewer pipeline.
 *
 * Security Scan is a server-side preflight. The Eligibility Gate is a
 * reasoning-only, tool-free stage whose only durable result is a boolean
 * allowlist. The Actions stage reuses issue-watcher's deterministic forge
 * coordinator after the eligible set has been narrowed. Keeping this wrapper
 * separate means the action hook cannot accidentally consume an eligibility
 * response, and eligibility reasons can never cross into the action stage.
 */

import { MODEL_ABUSE_GUARD_ID, issuePrerequisiteWaived, normalizeEligibilityFacts } from '../lib/modelAbuseGuard.js';
import { PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE, PUBLIC_REVIEW_GATE_EXECUTION_PROFILE } from '../lib/agentExecutionProfiles.js';
import { createPrReviewerDefaultStages } from './taskScheduleRegistry.js';
import {
  isTaskOutputPayload as isIssueWatcherPayload,
  processTaskOutput as processIssueWatcherOutput,
} from './issueWatcher.js';

const HEAD_SHA_RE = /^[a-f0-9]{40}$/i;
const CONTENT_FINGERPRINT_RE = /^[a-f0-9]{64}$/i;
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
  const executionProfile = role === 'eligibility'
    ? PUBLIC_REVIEW_GATE_EXECUTION_PROFILE
    : PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE;
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

function normalizedExpectedPullRequests(task) {
  const expected = task?.metadata?.issueWatcher;
  if (!expected || expected.strictPullRequestCoverage !== true || !Array.isArray(expected.pullRequests)) return null;
  const seen = new Set();
  const pullRequests = [];
  for (const item of expected.pullRequests) {
    if (!Number.isInteger(item?.number) || item.number < 1 || seen.has(item.number)) return null;
    if (!HEAD_SHA_RE.test(item.headSha) || !CONTENT_FINGERPRINT_RE.test(item.contentFingerprint)) return null;
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
  if (role === 'eligibility') return processEligibilityTaskOutput(args);
  if (role === 'actions') return processIssueWatcherOutput({ ...args, requireEligibilityFacts: true }, deps);
  return invalidEligibility('unsupported-pr-review-stage');
}
