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

/** Preserve a claim's enforced review policy at the bridge boundary. */
export function localReviewBridgeRequest(request, cwd) {
  const { timeoutMs, ...reviewRequest } = request;
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) reviewRequest.timeoutMs = timeoutMs;
  if (request.kind === 'claim-review') reviewRequest.toolFree = true;
  return { ...reviewRequest, cwd };
}
