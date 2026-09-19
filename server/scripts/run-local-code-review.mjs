#!/usr/bin/env node

/**
 * Auth-independent local-review bridge for unattended claim agents.
 * Reads one JSON request from stdin and writes the service result to stdout.
 */
import { getCodeReviewDefaults, runLocalClaimCommentReview, runLocalCodeReview } from '../services/codeReview.js';

import { Console } from 'node:console';
import { isReviewerConfigFault, reviewerModelsFromDefaults } from '../lib/reviewerConfig.js';

// Provider/runtime diagnostics belong on stderr; stdout is exactly one JSON
// response for the claim procedure's jq gate.
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

try {
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const defaults = await getCodeReviewDefaults().catch(() => null);
  const model = request.model || reviewerModelsFromDefaults(defaults)[request.backend] || null;
  const effort = request.effort || defaults?.[`${request.backend}Effort`] || null;
  const review = request.kind === 'claim-comments'
    ? runLocalClaimCommentReview
    : runLocalCodeReview;
  const result = await review({ ...request, model, effort });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) {
    // A reviewer that CAN'T be satisfied reads identically to one that merely
    // timed out, and the claim procedure answers both with `review-blocked` —
    // leaving the PR open to wait out an outage that will never end (#7660). Say
    // which it is, naming the reviewer, so the operator sees a config fault.
    process.stderr.write(isReviewerConfigFault(result.code)
      ? `Reviewer configuration fault (${result.code}) for ${request.backend}: ${result.error}\n`
      : `${result.error}\n`);
    process.exitCode = 1;
  }
} catch (err) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: err.message })}\n`);
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
}
