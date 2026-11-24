#!/usr/bin/env node

/**
 * Resolve the commit a pull-request CI run diffs against, reading it out of the checkout instead of the event payload, and, on a push to `main`, the last green main commit the native jobs gate against. ZERO external dependencies: this runs before `npm ci` in every test job.
 *
 * actions/checkout builds a `pull_request` run from `refs/pull/<n>/merge`, a merge commit whose FIRST parent is the base-branch commit GitHub merged into. Reading it beats `github.event.pull_request.base.sha`: it needs no history (`merge-base(HEAD^1, HEAD)` is HEAD^1 by construction, so `fetch-depth: 2` suffices for the impact plan's `<base>...HEAD` diff), and it cannot drift (the payload's `base.sha` is the base tip when the event fired, while GitHub rebuilds the merge ref when the base moves, so a three-dot diff would attribute base-branch commits to the pull request).
 * Non-pull_request runs force the complete suite (`CI_FORCE_FULL`), so they need no base. The impact job of a push to `main` opts in with `CI_GATED_BASE_LOOKUP=true` and gets `CI_GATED_BASE_SHA`: the head of the newest successful push or schedule CI run, fetched at depth 1, so the planner can skip the native single-purpose jobs whose inputs that green tree already proved. Any failure exports nothing, which runs them all.
 */

import { spawnSync } from 'child_process';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { writeStepEnv } from './lib/githubOutput.js';

// Runs listed under this workflow file only: release.yml's workflow_call of
// ci.yml is recorded under release.yml, so it never appears here.
export const CI_WORKFLOW_FILE = 'ci.yml';
// Both run the complete suite on main's tree. workflow_dispatch is left out
// because it can target any branch's tree under the same workflow.
const GATED_BASE_EVENTS = new Set(['push', 'schedule']);
const SHA_RE = /^[0-9a-f]{40}$/;
const LOOKUP_TIMEOUT_MS = 15_000;

/** Resolve a revision to a commit sha, or null when git cannot. */
export function gitRevParse(rev) {
  const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], {
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim() || null;
}

/** Run git, inheriting stderr so a failed fetch explains itself in the job log; true on exit 0. */
function runGit(args) {
  const result = spawnSync('git', args, { stdio: ['ignore', 'ignore', 'inherit'] });
  return !result.error && result.status === 0;
}

/**
 * The base commit for this run, or null when it needs none. The `HEAD^2` probe distinguishes a merge-ref checkout from a plain head-commit one: only the former has a second parent, and only its first parent means "the base branch".
 */
export function resolveBaseSha({ eventName, revParse = gitRevParse } = {}) {
  if (eventName !== 'pull_request') return null;
  if (!revParse('HEAD^2')) return null;
  return revParse('HEAD^1');
}

/**
 * The head sha of the newest successful push or schedule run on `main` in an Actions "list workflow runs" response (newest first), or null.
 */
export function pickGatedBaseSha(listing) {
  const runs = Array.isArray(listing?.workflow_runs) ? listing.workflow_runs : [];
  const run = runs.find((candidate) => GATED_BASE_EVENTS.has(candidate?.event)
    && candidate.conclusion === 'success'
    && candidate.head_branch === 'main'
    && SHA_RE.test(candidate.head_sha ?? ''));
  return run?.head_sha ?? null;
}

/**
 * The last green main commit, fetched into this checkout, or null when this run did not opt in or the lookup or fetch failed (null runs every native job).
 */
export async function resolveGatedBaseSha({ env = process.env, fetchImpl = globalThis.fetch, git = runGit } = {}) {
  if (env.CI_GATED_BASE_LOOKUP !== 'true') return null;
  const token = env.GITHUB_TOKEN;
  const repository = env.GITHUB_REPOSITORY;
  if (!token || !repository) {
    console.warn('⚠️ Gated-base lookup requested without GITHUB_TOKEN and GITHUB_REPOSITORY; every native job runs');
    return null;
  }
  const api = env.GITHUB_API_URL || 'https://api.github.com';
  const url = `${api}/repos/${repository}/actions/workflows/${CI_WORKFLOW_FILE}/runs?branch=main&status=success&per_page=20`;
  let listing;
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    listing = await response.json();
  } catch (err) {
    console.warn(`⚠️ Could not list green main CI runs (${err.message}); every native job runs`);
    return null;
  }
  const sha = pickGatedBaseSha(listing);
  if (!sha) {
    console.log('⏭️ No successful push or schedule CI run on main to gate against; every native job runs');
    return null;
  }
  if (!git(['fetch', '--no-tags', '--depth=1', 'origin', sha]) || !git(['cat-file', '-e', `${sha}^{commit}`])) {
    console.warn(`⚠️ Could not fetch last green main commit ${sha}; every native job runs`);
    return null;
  }
  return sha;
}

/**
 * The gated base when it is exactly this push's first parent, else null: the proof that the green tree is the immediate predecessor, so a diff against it is the whole change this push introduces. A green run further back leaves commits unproven in between.
 */
export function resolvePredecessorGreenSha({ gatedBaseSha, revParse = gitRevParse } = {}) {
  if (!gatedBaseSha) return null;
  return revParse('HEAD^1') === gatedBaseSha ? gatedBaseSha : null;
}

async function main() {
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
  const gatedBaseSha = await resolveGatedBaseSha();
  if (gatedBaseSha) {
    writeStepEnv('CI_GATED_BASE_SHA', gatedBaseSha);
    console.log(`📌 Native jobs gate on the diff since the last green main run: ${gatedBaseSha}`);
    const predecessor = resolvePredecessorGreenSha({ gatedBaseSha });
    if (predecessor) {
      writeStepEnv('CI_PREDECESSOR_GREEN_SHA', predecessor);
      console.log('📌 The last green main run is this push\'s first parent');
    }
  }
  console.log('No pull-request merge base to resolve — this run tests the complete suite.');
}

if (isDirectlyInvoked(import.meta.url)) await main();
