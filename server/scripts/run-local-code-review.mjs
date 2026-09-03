#!/usr/bin/env node

/**
 * Auth-independent local-review bridge for unattended claim agents.
 * Reads one JSON request from stdin and writes the service result to stdout.
 */
import { getCodeReviewDefaults, runLocalClaimCommentReview, runLocalCodeReview } from '../services/codeReview.js';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

try {
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const defaults = await getCodeReviewDefaults().catch(() => null);
  const model = request.model || defaults?.[`${request.backend}Model`] || null;
  const effort = request.effort || defaults?.[`${request.backend}Effort`] || null;
  const review = request.kind === 'claim-comments'
    ? runLocalClaimCommentReview
    : runLocalCodeReview;
  const result = await review({ ...request, model, effort });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) {
    process.stderr.write(`${result.error}\n`);
    process.exitCode = 1;
  }
} catch (err) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: err.message })}\n`);
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
}
