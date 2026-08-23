#!/usr/bin/env node

// Decides whether the commit being released was ALREADY validated by a full CI
// run, so the release workflow does not repeat the ~8-minute suite the
// main -> release pull request just finished.
//
// Two independent conditions must hold, because each alone is forgeable:
//
//   1. CONTENT, not SHA. A candidate commit vouches for this push only when its
//      git tree is byte-identical to the tree being released. A merge commit on
//      `release` has the same tree as the `main` tip it merged (release is
//      strictly behind main), and that tip is the SHA the release PR gated.
//   2. FULLNESS. The gate must be `Full CI Gate`, which ci.yml publishes only
//      when the impact plan chose the complete suite. The aggregate `CI Gate`
//      check is green on impact-scoped PR runs too, so it cannot distinguish
//      "the full suite passed on this tree" from "some subset of it did".
//
// Anything else — a direct push to `release`, a merge that changed the tree, a
// missing/failed/scoped gate, an unreachable checks API — reports
// `verified=false`, and the release workflow runs the complete suite.

import { spawnSync } from 'child_process';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { writeStepOutput } from './lib/githubOutput.js';

// Must match the `Full CI Gate` job name in .github/workflows/ci.yml.
// verify-ci-status.test.js asserts that, because a silent rename here would
// make every release fall back to the full suite forever with no other symptom.
export const FULL_CI_GATE_CHECK_NAME = 'Full CI Gate';

/** Tree SHA and parent SHAs from `git show -s --format=%T%n%P <commit>`. */
export function parseCommitSummary(showOutput) {
  const [tree = '', parents = ''] = String(showOutput || '').split('\n');
  return {
    tree: tree.trim() || null,
    parents: parents.trim().split(' ').filter(Boolean),
  };
}

/** True when a `/check-runs` payload holds a completed, successful full gate. */
export function hasPassingGate(checkRuns) {
  return Array.isArray(checkRuns) && checkRuns.some((run) => (
    run?.name === FULL_CI_GATE_CHECK_NAME
    && run?.status === 'completed'
    && run?.conclusion === 'success'
  ));
}

/**
 * SHA of the first candidate whose green full gate vouches for `headTree`.
 *
 * Checks are fetched lazily so a verified first candidate costs one API call.
 *
 * @param {Array<{sha: string, tree: string|null}>} candidates
 * @param {string|null} headTree tree SHA of the commit being released
 * @param {(sha: string) => Array|null} fetchCheckRuns null = could not ask
 */
export function findVerifiedSha(candidates, headTree, fetchCheckRuns) {
  if (!headTree) return null;
  for (const { sha, tree } of candidates) {
    if (tree !== headTree) continue;
    if (hasPassingGate(fetchCheckRuns(sha))) return sha;
  }
  return null;
}

const capture = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
};

// null = the checks API could not be answered for this sha, [] = it answered
// with no gate. Both end the release at "unverified", but only the first warns.
//
// The parse is guarded because an unreadable answer must degrade to "run the
// full suite", not throw: an uncaught throw here fails the verify job, and the
// release then reports a hard error instead of simply re-testing the tree.
// A 200 carrying non-JSON (proxy/captive-portal HTML) is the realistic case.
function fetchCheckRuns(repo, sha) {
  const query = `check_name=${encodeURIComponent(FULL_CI_GATE_CHECK_NAME)}&filter=latest`;
  const body = capture('gh', ['api', `repos/${repo}/commits/${sha}/check-runs?${query}`]);
  if (body === null) {
    console.warn(`⚠️  Checks API unreachable for ${sha.slice(0, 8)} — treating it as unverified.`);
    return null;
  }
  return parseCheckRuns(body, sha);
}

/** check_runs from a `/check-runs` response body, or null when unreadable. */
export function parseCheckRuns(body, sha = '') {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    console.warn(`⚠️  Unreadable checks response for ${String(sha).slice(0, 8)} — treating it as unverified.`);
    return null;
  }
  return Array.isArray(parsed?.check_runs) ? parsed.check_runs : [];
}

function emit(verified, reason) {
  writeStepOutput('verified', verified);
  writeStepOutput('reason', reason);
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const head = process.env.GITHUB_SHA || capture('git', ['rev-parse', 'HEAD']);
  if (!repo || !head) {
    console.log('❔ No repository or head SHA available — running the full suite.');
    emit(false, 'missing repository or head SHA');
    return;
  }

  const { tree: headTree, parents } = parseCommitSummary(
    capture('git', ['show', '-s', '--format=%T%n%P', head]),
  );
  // HEAD first: a workflow_dispatch or re-run may have gated this exact SHA.
  // Parents are tree-checked too, so the previous release tip cannot vouch for
  // a merge that actually changed the tree.
  const candidates = [
    { sha: head, tree: headTree },
    ...parents.map((sha) => ({ sha, tree: capture('git', ['rev-parse', `${sha}^{tree}`]) })),
  ];

  const verified = findVerifiedSha(candidates, headTree, (sha) => fetchCheckRuns(repo, sha));
  if (verified) {
    const short = verified.slice(0, 8);
    console.log(`✅ Full CI already passed on ${short} with this exact tree — skipping the suite.`);
    emit(true, `${FULL_CI_GATE_CHECK_NAME} succeeded on ${short} with an identical tree`);
    return;
  }

  console.log(`🧪 No green ${FULL_CI_GATE_CHECK_NAME} for this tree — running the full suite.`);
  emit(false, `no successful ${FULL_CI_GATE_CHECK_NAME} for this tree`);
}

if (isDirectlyInvoked(import.meta.url)) main();
