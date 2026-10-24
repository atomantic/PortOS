import { join } from 'path';
import { PATHS } from './fileUtils.js';

/**
 * Absolute path of the stdin bridge into the local-review service
 * (`server/scripts/run-local-code-review.mjs`): same reviewers, same
 * `timeoutMs` forwarding as `POST /api/code-review/local`, but no HTTP and so
 * no instance-password gate.
 *
 * Two prompt builders hand it to agents — the CoS claim procedure
 * (`services/cosTaskPrompts.js`) drives every tool-free reviewer through it, and
 * the review-loop section (`services/promptSections/reviewLifecycle.js`) names
 * it as the fallback when the gated endpoint answers 401. Resolved once here so
 * moving or renaming the script cannot break one prompt while the other keeps
 * working. Each caller applies its own `shellQuote`.
 */
export const LOCAL_REVIEW_BRIDGE_SCRIPT = join(PATHS.root, 'server/scripts/run-local-code-review.mjs');
export const LOCAL_REVIEW_LIFECYCLE_GUIDE = join(PATHS.root, 'docs/LOCAL_REVIEW_LIFECYCLE.md');
export const LOCAL_REVIEW_LIFECYCLE_SCRIPT = join(PATHS.root, 'server/scripts/local-review-lifecycle.mjs');
export const LOCAL_REVIEW_ATTRIBUTION_GUIDE = join(PATHS.root, 'docs/PR_REVIEW_ATTRIBUTION.md');

/** Preserve a claim's enforced review policy at the bridge boundary. */
export function localReviewBridgeRequest(request, cwd) {
  const { timeoutMs, recordAttribution: _recordAttribution, ...reviewRequest } = request;
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) reviewRequest.timeoutMs = timeoutMs;
  if (request.kind === 'claim-review') reviewRequest.toolFree = true;
  return { ...reviewRequest, cwd };
}

/** Preserve completed review evidence while keeping receipt failures out of availability gates. */
export function localReviewAttributionErrorGate({ cleanupDiff = false } = {}) {
  const diffCleanup = cleanupDiff ? '"$REVIEW_DIFF" ' : '';
  return `if jq -e '.attributionError != null' "$REVIEW_RESPONSE" >/dev/null; then
  trap 'rm -f ${diffCleanup}"\${REVIEW_RESPONSE}.findings"' EXIT
  jq -r '.findings // empty' "$REVIEW_RESPONSE"
  echo "Review completed; attribution persistence failed. Stop publication, not review-blocked. Repair attribution from the retained private response: $REVIEW_RESPONSE" >&2
  exit 1
fi`;
}
