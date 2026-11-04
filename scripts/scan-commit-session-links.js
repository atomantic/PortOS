#!/usr/bin/env node
/**
 * Refuse a branch whose commit messages link to an AI conversation session.
 *
 * AGENTS.md (Git Workflow) bans those links from commits, and history on
 * `main` is permanent, so the check runs before merge: in pregate against the
 * branch's own commits (`<merge base>..HEAD`), and in the CI `impact` job
 * against the pull request's commits that are not already on the default
 * branch. Commits already on `main` are never this branch's to answer for.
 *
 * CI's checkout is a depth-2 merge ref, which does not hold the pull request's
 * commits, so the CI mode reads them from the compare API instead of git.
 * `--description` checks the pull request's description instead (see
 * .github/workflows/pr-description.yml).
 * Comparing against the default branch rather than the PR base keeps a release
 * PR from answering for every `main` commit it promotes.
 *
 * Runs before any dependency install, so it stays on Node builtins
 * (scripts/pre-install-entrypoints.test.js).
 *
 * Usage:
 *   node scripts/scan-commit-session-links.js --base <ref>   # <ref>..HEAD
 *   node scripts/scan-commit-session-links.js                # pull_request CI, else origin/main..HEAD
 *   node scripts/scan-commit-session-links.js --description  # the pull request's description (CI)
 *
 * Exit codes: 0 clean, 1 findings, 2 the commits could not be read.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { resolveApiBase } from './lib/githubActionsApi.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';

const SESSION_LINK = /\b(?:claude\.ai\/(?:code\/session|chat\/|share\/)|(?:chatgpt\.com|chat\.openai\.com)\/(?:c|share)\/)/i;
// Labels are printed to CI logs, so any token carrying a session link is redacted.
const SESSION_TOKEN = new RegExp(`\\S*${SESSION_LINK.source.replace('\\b', '')}\\S*`, 'gi');
const RECORD = '\x1e';
const FIELD = '\x1f';
const MAX_LOG_BYTES = 64 * 1024 * 1024;
const COMPARE_PAGE_SIZE = 100;
const MAX_COMPARE_PAGES = 50;

const revParse = (rev, cwd) => {
  const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() || null : null;
};

/** Entries whose text carries a session link, with the matched link prefix (never the id). */
export function findSessionLinks(entries) {
  return entries.flatMap(({ label, text }) => {
    const match = SESSION_LINK.exec(text);
    return match ? [{ label, link: match[0] }] : [];
  });
}

const commitEntry = (sha, message) => ({
  label: `${sha.slice(0, 10)} "${message.split('\n', 1)[0].replace(SESSION_TOKEN, '<session link>')}"`,
  text: message,
});

/** This branch's own commits since `base`. */
export function readBranchCommits(base, { cwd } = {}) {
  const out = execFileSync('git', ['log', `--format=%H${FIELD}%B${RECORD}`, `${base}..HEAD`], {
    cwd, encoding: 'utf8', maxBuffer: MAX_LOG_BYTES,
  });
  return out.split(RECORD).map((record) => record.replace(/^\n/, '')).filter(Boolean).map((record) => {
    const [sha, message = ''] = record.split(FIELD);
    return commitEntry(sha, message);
  });
}

const pullRequestApi = (env, fetchImpl) => {
  const apiBase = resolveApiBase(env.GITHUB_API_URL);
  if (!apiBase || !env.GITHUB_REPOSITORY || !env.GITHUB_TOKEN) {
    throw new Error('needs GITHUB_REPOSITORY, GITHUB_TOKEN and a valid GITHUB_API_URL');
  }
  return async (path) => {
    const response = await fetchImpl(`${apiBase}/repos/${env.GITHUB_REPOSITORY}/${path}`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`GET ${path.split('?')[0]} answered HTTP ${response.status}`);
    return response.json();
  };
};

/** The pull request's commits not yet on the default branch, from the compare API. */
export async function readPullRequestCommits({ env = process.env, fetchImpl = fetch } = {}) {
  const get = pullRequestApi(env, fetchImpl);
  const head = env.PORTOS_CI_CANDIDATE_HEAD;
  if (!head) throw new Error('needs PORTOS_CI_CANDIDATE_HEAD');
  const compare = `compare/${encodeURIComponent(env.CI_DEFAULT_BRANCH || 'main')}...${encodeURIComponent(head)}`;
  const entries = [];
  for (let page = 1; page <= MAX_COMPARE_PAGES; page += 1) {
    const body = await get(`${compare}?per_page=${COMPARE_PAGE_SIZE}&page=${page}`);
    const batch = Array.isArray(body.commits) ? body.commits : [];
    entries.push(...batch.map((item) => commitEntry(item.sha, item.commit?.message ?? '')));
    if (entries.length >= (body.total_commits ?? 0) || batch.length === 0) return entries;
  }
  throw new Error(`${compare} has more than ${MAX_COMPARE_PAGES * COMPARE_PAGE_SIZE} commits`);
}

/**
 * The pull request's description, read live: a squash merge copies it into
 * main's commit message, which is how most session links have reached main.
 * Runs from its own workflow on every description edit, so a later edit
 * cannot leave a stale green check behind.
 */
export async function readPullRequestDescription({ env = process.env, fetchImpl = fetch } = {}) {
  if (!/^\d+$/.test(env.CI_PR_NUMBER ?? '')) throw new Error('needs CI_PR_NUMBER');
  const pull = await pullRequestApi(env, fetchImpl)(`pulls/${env.CI_PR_NUMBER}`);
  return [{ label: 'the pull request description', text: pull.body ?? '' }];
}

/** Run the check; returns the exit code and lines so the suite can read the verdict in-process. */
export async function runCommitSessionLinkScan({ argv = [], env = process.env, cwd, fetchImpl } = {}) {
  const baseFlag = argv.indexOf('--base');
  const explicit = baseFlag === -1 ? null : argv[baseFlag + 1];
  const description = argv.includes('--description');
  const onPullRequest = !explicit && env.GITHUB_EVENT_NAME === 'pull_request';
  let entries;
  try {
    if (description) {
      entries = await readPullRequestDescription({ env, fetchImpl });
    } else if (onPullRequest) {
      entries = await readPullRequestCommits({ env, fetchImpl });
    } else {
      const base = (explicit ? [explicit] : ['origin/main', 'main']).map((ref) => revParse(ref, cwd)).find(Boolean);
      if (!base) {
        return explicit
          ? { code: 2, lines: [`❌ Commit-message scan could not resolve ${explicit}`] }
          : { code: 0, lines: ['⏭️  Commit-message scan skipped: no main branch to compare against'] };
      }
      entries = readBranchCommits(base, { cwd });
    }
  } catch (error) {
    return { code: 2, lines: [`❌ Commit-message scan could not read ${description ? 'the pull request description' : "the branch's commits"}: ${error.message}`] };
  }

  const findings = findSessionLinks(entries);
  if (findings.length === 0) {
    return { code: 0, lines: [`✅ Commit-message scan clean: no AI session links in ${entries.length} message(s)`] };
  }
  return {
    code: 1,
    lines: [
      `❌ ${findings.length} message(s) link to an AI conversation session (AGENTS.md, Git Workflow):`,
      ...findings.map(({ label, link }) => `   ${label} contains ${link}…`),
      description
        ? '   Edit the description to drop the link (for example a session footer); the edit re-runs this check.'
        : '   Reword those commits to drop the link (for example a Claude-Session: trailer), then push again.',
    ],
  };
}

async function main() {
  const { code, lines } = await runCommitSessionLinkScan({ argv: process.argv.slice(2) });
  for (const line of lines) (code === 0 ? console.log : console.error)(line);
  process.exitCode = code;
}

if (isDirectlyInvoked(import.meta.url)) {
  main().catch((error) => {
    console.error(`❌ Commit-message scan failed: ${error.message}`);
    process.exitCode = 2;
  });
}
