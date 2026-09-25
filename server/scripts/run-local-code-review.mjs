#!/usr/bin/env node

/**
 * Auth-independent local-review bridge for unattended claim agents.
 * Reads one JSON request from stdin and writes the service result to stdout.
 */
import { getCodeReviewDefaults, reportReviewerFailure, reportReviewerSuccess, runLocalClaimCommentReview, runLocalCodeReview } from '../services/codeReview.js';

import { Console } from 'node:console';
import { isReviewerConfigFault, reviewerModelsFromDefaults, reviewerEffortsFromDefaults } from '../lib/reviewerConfig.js';
import { localReviewBridgeRequest } from '../lib/localReviewBridge.js';
import { stopCodexAppServer } from '../services/codexAppServer.js';

// Provider/runtime diagnostics belong on stderr; stdout is exactly one JSON
// response for the claim procedure's jq gate.
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

try {
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  // Resolved follow-up pins already include defaults. An explicit task clear
  // must not re-inherit the global pins when it reaches this bridge.
  const defaults = request.inheritDefaults === false ? null : await getCodeReviewDefaults().catch(() => null);
  const model = request.model || reviewerModelsFromDefaults(defaults)[request.backend] || null;
  const effort = request.effort || reviewerEffortsFromDefaults(defaults)[request.backend] || null;
  const review = request.kind === 'claim-comments'
    ? runLocalClaimCommentReview
    : runLocalCodeReview;
  const result = await review({ ...localReviewBridgeRequest(request, process.cwd()), model, effort });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  const recordOutcome = result.ok
    ? reportReviewerSuccess(request.backend)
    : reportReviewerFailure(request.backend, result);
  await recordOutcome.catch((err) => {
    process.stderr.write(`Unable to persist reviewer health: ${err.message}\n`);
  });
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
} finally {
  await stopCodexAppServer().catch((err) => {
    process.stderr.write(`Unable to stop Codex app-server: ${err.message}\n`);
  });
}
