#!/usr/bin/env node

/**
 * Resolve the commit a pull-request CI run diffs against, reading it out of the
 * checkout instead of the event payload.
 *
 * ZERO external dependencies — this runs before `npm ci` in every test job.
 *
 * actions/checkout builds a `pull_request` run from `refs/pull/<n>/merge`, a
 * merge commit whose FIRST parent is the base-branch commit GitHub merged the
 * pull request into. Reading that parent beats
 * `github.event.pull_request.base.sha` twice over:
 *
 *   - It needs no history. `merge-base(HEAD^1, HEAD)` is HEAD^1 by
 *     construction, so `fetch-depth: 2` is enough for both the impact plan's
 *     `<base>...HEAD` diff and Vitest's `--changed <sha>` (which also runs a
 *     three-dot diff internally). Every job used to clone all ~13k commits to
 *     get the same answer.
 *   - It cannot drift. The payload's `base.sha` is the base tip when the event
 *     fired, and GitHub rebuilds the merge ref when the base branch moves, so
 *     the two can disagree — at which point a three-dot diff attributes
 *     base-branch commits to the pull request.
 *
 * Non-pull_request runs force the complete suite (`CI_FORCE_FULL`), so they
 * need no base at all and this emits nothing.
 */

import { spawnSync } from 'child_process';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { writeStepEnv } from './lib/githubOutput.js';

/** Resolve a revision to a commit sha, or null when git cannot. */
export function gitRevParse(rev) {
  const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], {
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim() || null;
}

/**
 * The base commit for this run, or null when the run needs none.
 *
 * The `HEAD^2` probe is what distinguishes a merge-ref checkout from a plain
 * head-commit one: only the former has a second parent, and only the former
 * has a first parent that means "the base branch".
 */
export function resolveBaseSha({ eventName, revParse = gitRevParse } = {}) {
  if (eventName !== 'pull_request') return null;
  if (!revParse('HEAD^2')) return null;
  return revParse('HEAD^1');
}

function main() {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const baseSha = resolveBaseSha({ eventName });
  if (baseSha) {
    writeStepEnv('CI_BASE_SHA', baseSha);
    console.log(`📌 Diff base for this pull request: ${baseSha}`);
    return;
  }
  if (eventName === 'pull_request') {
    // Say so here rather than leaving the reader with "tests the complete
    // suite", which describes a forced-full run and is the opposite of what
    // happens next: a scoped pull request with no base fails loudly one step
    // later, on the planner's throw or the runner's requiresBaseSha guard.
    // Not fatal on its own — a pull request into the release branch forces
    // the complete suite and legitimately needs no base.
    console.error('❌ pull_request checkout is not a merge ref — no diff base to resolve.');
    return;
  }
  console.log('No pull-request merge base to resolve — this run tests the complete suite.');
}

if (isDirectlyInvoked(import.meta.url)) main();
