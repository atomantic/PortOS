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
 * Comparing against the default branch rather than the PR base keeps a release
 * PR from answering for every `main` commit it promotes.
 *
 * Runs before any dependency install, so it stays on Node builtins
 * (scripts/pre-install-entrypoints.test.js).
 *
 * Usage:
 *   node scripts/scan-commit-session-links.js --base <ref>   # <ref>..HEAD
 *   node scripts/scan-commit-session-links.js                # pull_request CI, else origin/main..HEAD
 *
 * Exit codes: 0 clean, 1 findings, 2 the commits could not be read.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { resolveApiBase } from './lib/githubActionsApi.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';

const SESSION_LINK = /\b(?:claude\.ai\/(?:code\/session|chat\/|share\/)|(?:chatgpt\.com|chat\.openai\.com)\/(?:c|share)\/)/i;
const RECORD = '\x1e';
const FIELD = '\x1f';
const MAX_LOG_BYTES = 64 * 1024 * 1024;
const COMPARE_PAGE_SIZE = 100;
const MAX_COMPARE_PAGES = 50;

const revParse = (rev, cwd) => {
  const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() || null : null;
};

/** Commits whose message carries a session link, with the matched link prefix (never the id). */
export function findSessionLinks(commits) {
  return commits.flatMap(({ sha, message }) => {
    const match = SESSION_LINK.exec(message);
    return match ? [{ sha, subject: message.split('\n', 1)[0], link: match[0] }] : [];
  });
}

/** This branch's own commits since `base`, oldest last. */
export function readBranchCommits(base, { cwd } = {}) {
  const out = execFileSync('git', ['log', `--format=%H${FIELD}%B${RECORD}`, `${base}..HEAD`], {
    cwd, encoding: 'utf8', maxBuffer: MAX_LOG_BYTES,
  });
  return out.split(RECORD).map((record) => record.replace(/^\n/, '')).filter(Boolean).map((record) => {
    const [sha, message = ''] = record.split(FIELD);
    return { sha, message };
  });
}

/** The pull request's commits not yet on the default branch, from the compare API. */
export async function readPullRequestCommits({ env = process.env, fetchImpl = fetch } = {}) {
  const apiBase = resolveApiBase(env.GITHUB_API_URL);
  const repository = env.GITHUB_REPOSITORY;
  const head = env.PORTOS_CI_CANDIDATE_HEAD;
  const branch = env.CI_DEFAULT_BRANCH || 'main';
  if (!apiBase || !repository || !head || !env.GITHUB_TOKEN) {
    throw new Error('compare needs GITHUB_REPOSITORY, PORTOS_CI_CANDIDATE_HEAD, GITHUB_TOKEN and a valid GITHUB_API_URL');
  }
  const commits = [];
  for (let page = 1; page <= MAX_COMPARE_PAGES; page += 1) {
    const url = `${apiBase}/repos/${repository}/compare/${encodeURIComponent(branch)}...${encodeURIComponent(head)}?per_page=${COMPARE_PAGE_SIZE}&page=${page}`;
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`compare ${branch}...${head.slice(0, 9)} answered HTTP ${response.status}`);
    const body = await response.json();
    const batch = Array.isArray(body.commits) ? body.commits : [];
    commits.push(...batch.map((item) => ({ sha: item.sha, message: item.commit?.message ?? '' })));
    if (commits.length >= (body.total_commits ?? 0) || batch.length === 0) return commits;
  }
  throw new Error(`compare ${branch}...${head.slice(0, 9)} has more than ${MAX_COMPARE_PAGES * COMPARE_PAGE_SIZE} commits`);
}

/** Run the check; returns the exit code and lines so the suite can read the verdict in-process. */
export async function runCommitSessionLinkScan({ argv = [], env = process.env, cwd, fetchImpl } = {}) {
  const baseFlag = argv.indexOf('--base');
  const explicit = baseFlag === -1 ? null : argv[baseFlag + 1];
  let commits;
  try {
    if (!explicit && env.GITHUB_EVENT_NAME === 'pull_request') {
      commits = await readPullRequestCommits({ env, fetchImpl });
    } else {
      const base = (explicit ? [explicit] : ['origin/main', 'main']).map((ref) => revParse(ref, cwd)).find(Boolean);
      if (!base) {
        return explicit
          ? { code: 2, lines: [`❌ Commit-message scan could not resolve ${explicit}`] }
          : { code: 0, lines: ['⏭️  Commit-message scan skipped: no main branch to compare against'] };
      }
      commits = readBranchCommits(base, { cwd });
    }
  } catch (error) {
    return { code: 2, lines: [`❌ Commit-message scan could not read the branch's commits: ${error.message}`] };
  }

  const findings = findSessionLinks(commits);
  if (findings.length === 0) {
    return { code: 0, lines: [`✅ Commit-message scan clean: no AI session links in ${commits.length} branch commit(s)`] };
  }
  return {
    code: 1,
    lines: [
      `❌ ${findings.length} commit message(s) link to an AI conversation session (AGENTS.md, Git Workflow):`,
      ...findings.map(({ sha, subject, link }) => `   ${sha.slice(0, 10)} "${subject}" contains ${link}…`),
      '   Reword those commits to drop the link (for example a Claude-Session: trailer), then push again.',
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
