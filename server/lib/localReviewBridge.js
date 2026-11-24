/**
 * `LOCAL_REVIEW_BRIDGE_SCRIPT`: absolute path of the stdin bridge into the local code-review service, shared by
 * the two prompt builders that hand it to agents.
 *
 * `localReviewBridgeRequest` preserves claim-review isolation even if its redundant `toolFree` flag is cleared.
 */

import { join } from 'path';
import { PATHS } from './fileUtils.js';

// `server/scripts/run-local-code-review.mjs`: same reviewers and `timeoutMs` forwarding as `POST /api/code-review/local`, but no HTTP and so no instance-password gate.
// Resolved once because the CoS claim procedure and the review-loop section both name it; callers apply their own `shellQuote`.
export const LOCAL_REVIEW_BRIDGE_SCRIPT = join(PATHS.root, 'server/scripts/run-local-code-review.mjs');
export const LOCAL_REVIEW_LIFECYCLE_GUIDE = join(PATHS.root, 'docs/LOCAL_REVIEW_LIFECYCLE.md');
export const LOCAL_REVIEW_LIFECYCLE_SCRIPT = join(PATHS.root, 'server/scripts/local-review-lifecycle.mjs');

/** Preserve a claim's enforced review policy at the bridge boundary. */
export function localReviewBridgeRequest(request, cwd) {
  const { timeoutMs, ...reviewRequest } = request;
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) reviewRequest.timeoutMs = timeoutMs;
  if (request.kind === 'claim-review') reviewRequest.toolFree = true;
  return { ...reviewRequest, cwd };
}

/**
 * Shell block that runs `pipeline` (diff command | jq | bridge) and prints the review findings.
 * The reply lives in shell variables, never a temp file: agents routinely dropped the cleanup `trap`
 * of the old mktemp form and left bridge replies and diffs in the host temp directory (#18466).
 * `pipefail` makes a failing diff command fail the run instead of reviewing an empty diff.
 */
export function buildLocalReviewShell(pipeline) {
  return `set -o pipefail
RESPONSE="$(${pipeline})"; STATUS=$?
if [ "$STATUS" -ne 0 ]; then
  echo "Local reviewer failed: $(printf '%s' "$RESPONSE" | jq -r '.error // "review diff or bridge command failed"' 2>/dev/null || echo "review diff or bridge command failed")" >&2
  exit 1
fi
if ! FINDINGS="$(printf '%s' "$RESPONSE" | jq -er 'select(.ok == true and (.verdict == "clean" or .verdict == "findings")) | .findings | select(type == "string" and length > 0)')"; then
  echo "Local reviewer failed: $(printf '%s' "$RESPONSE" | jq -r '.error // "missing .findings in reviewer response"')" >&2
  exit 1 # Never treat an absent or malformed response as clean.
fi
printf '%s\\n' "$FINDINGS"`;
}
