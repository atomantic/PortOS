/**
 * The spawn-time preconditions a public-content review stage must satisfy
 * before an agent is started for it.
 *
 * These four gates used to sit inline in `runAgentSpawn`, each followed by its
 * own hand-copied "block the task and bail" epilogue. Collecting them here
 * makes the ORDER the contract — the scan clears the input, the eligibility
 * gate names which pull requests may be touched, the vendor row must declare a
 * maintained recipe for the requested posture, and only then is the model
 * itself checked — instead of an ordering you have to reconstruct by reading
 * 180 lines of orchestrator.
 *
 * Every gate FAILS CLOSED: a stage whose preflight state is missing, partial,
 * or unrecognized is blocked, never spawned "optimistically". The two content
 * gates carry `emit: 'warn-log'` rather than `'agent:error'` because a
 * fail-closed safety outcome must not create an automatic investigator that
 * could retry the same unvalidated input; a provider/model misconfiguration is
 * an operator-visible failure and does raise one.
 *
 * `validateModel` is INJECTED rather than imported. The model check is the only
 * one of the four that touches a live runtime (it probes an Ollama catalog and
 * capability report), and importing that service here would drag the local-LLM
 * graph into a `lib/` leaf and invert the dependency direction this directory
 * exists to keep clean. Injecting it also makes the gate order testable on its
 * own, with a stub, rather than only through the spawn.
 */

import { publicReviewProviderBlock } from './providerVendors.js';
import { PUBLIC_REVIEW_NO_TOOL_POSTURE } from './agentExecutionProfiles.js';

const PUBLIC_REVIEW_SCAN_STATUSES = new Set(['passed', 'findings']);

/** Why this task's model-abuse scan does not clear it to spawn, or null. */
export function publicReviewScanBlock(task) {
  const scan = task?.metadata?.pipeline?.securityScan;
  const hasClearedPr = Number.isInteger(scan?.safePrCount) && scan.safePrCount > 0;
  if (scan?.completed === true && PUBLIC_REVIEW_SCAN_STATUSES.has(scan.status) && hasClearedPr) return null;

  if (scan?.completed === true && scan.status === 'findings' && !hasClearedPr) {
    return {
      reason: 'Public review withheld: the model-abuse scan cleared no pull requests',
      category: 'public-review-no-cleared-prs',
    };
  }
  return {
    reason: `Public review withheld: the model-abuse scan is incomplete${scan?.code ? ` (${scan.code})` : ''}`,
    category: 'public-review-security-scan-incomplete',
  };
}

/**
 * Why this task's eligibility gate does not clear it to take actions, or null.
 *
 * Demands COVERAGE, not merely a non-empty result: every pull request the issue
 * watcher saw must appear in `eligibleNumbers`, so a gate that silently skipped
 * one cannot pass as a complete verdict.
 */
export function publicReviewEligibilityBlock(task) {
  const eligibility = task?.metadata?.pipeline?.eligibility;
  const eligibleNumbers = Array.isArray(eligibility?.eligibleNumbers)
    ? eligibility.eligibleNumbers.filter((number) => Number.isInteger(number) && number > 0)
    : [];
  const expected = task?.metadata?.issueWatcher?.pullRequests;
  const expectedNumbers = Array.isArray(expected)
    ? expected.map((item) => item?.number).filter((number) => Number.isInteger(number) && number > 0)
    : [];
  const allowed = new Set(eligibleNumbers);
  const coverageMatches = expectedNumbers.length === eligibleNumbers.length
    && expectedNumbers.every((number) => allowed.has(number));
  if (eligibility?.complete === true && eligibleNumbers.length > 0 && coverageMatches) return null;
  if (eligibility?.complete === true && eligibleNumbers.length === 0) {
    return {
      reason: 'Public review withheld: the eligibility gate cleared no pull requests',
      category: 'public-review-no-eligible-prs',
    };
  }
  return {
    reason: 'Public review withheld: a complete eligibility gate result is required before actions',
    category: 'public-review-eligibility-incomplete',
  };
}

/**
 * The first spawn precondition this task fails, as
 * `{ reason, category, emit }`, or null when every one of them passes.
 *
 * `emit` names how the caller should announce the block: `'warn-log'` for a
 * fail-closed content outcome, `'agent:error'` for a misconfiguration worth an
 * investigator.
 *
 * An ORDINARY task (no execution profile, so `publicReviewPosture` is null)
 * passes straight through — `publicReviewProviderBlock` owns the
 * "no posture requested" case, which is what #5866 got wrong by re-deriving it
 * from a boolean support check.
 */
export async function checkPublicReviewSpawnPreconditions({
  task,
  provider,
  selectedModel,
  publicReviewPosture,
  publicReview,
  publicReviewActions,
  publicReviewNoTools,
  privateSecurity,
  validateModel,
} = {}) {
  if (publicReview && !privateSecurity) {
    const scanBlock = publicReviewScanBlock(task);
    if (scanBlock) return { ...scanBlock, emit: 'warn-log' };
  }
  if (publicReviewActions) {
    const eligibilityBlock = publicReviewEligibilityBlock(task);
    if (eligibilityBlock) return { ...eligibilityBlock, emit: 'warn-log' };
  }
  // One posture check for both stages. Eligibility is declared by the vendor
  // row and re-asserted HERE, at spawn time, because a schedule or API payload
  // can be edited without the browser: the picker is a convenience, never the
  // enforcement.
  const postureBlock = publicReviewProviderBlock(provider, publicReviewPosture);
  if (postureBlock) return { ...postureBlock, emit: 'agent:error' };

  if (publicReviewNoTools && !privateSecurity) {
    const modelPolicy = await validateModel({
      provider,
      model: selectedModel,
      posture: PUBLIC_REVIEW_NO_TOOL_POSTURE,
    });
    if (!modelPolicy.ok) {
      return {
        reason: `Public review model is unavailable or not tool-free (${modelPolicy.code})`,
        category: modelPolicy.code || 'public-review-model-unsupported',
        emit: 'agent:error',
      };
    }
  }
  return null;
}
