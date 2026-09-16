/**
 * Every test here is about a guard that must NOT fire a retry. The retry
 * itself is one API call; the risk is re-running the suite on a genuine red,
 * looping forever, or fighting a legitimate `cancel-in-progress` supersession.
 *
 * The API-base and repository validation live in lib/githubActionsApi.test.js,
 * shared with scripts/cancel-current-ci-run.js.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it, vi } from 'vitest';

import { retryCancelledCiRun, retryTargetFromEnv } from './ci-retry-cancelled-run.js';
import { workflowJobs } from './lib/workflowJobs.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RECOVERY_WORKFLOW = readFileSync(
  join(REPO_ROOT, '.github/workflows/ci-cancel-recovery.yml'),
  'utf8',
);

const BASE_ENV = {
  GITHUB_REPOSITORY: 'example-owner/example-repo',
  GITHUB_TOKEN: 'token-value',
  CI_RUN_ID: '4242',
  CI_RUN_ATTEMPT: '1',
  CI_RUN_NUMBER: '900',
  CI_WORKFLOW_ID: '77',
  CI_RUN_EVENT: 'pull_request',
  CI_RUN_CONCLUSION: 'cancelled',
  CI_RUN_HEAD_BRANCH: 'claim/issue-1',
  CI_RUN_HEAD_SHA: 'c'.repeat(40),
};

const json = (body) => ({ ok: true, status: 200, json: async () => body });

/**
 * A fetch stub routed by URL shape. `jobs`/`runs` default to the clean
 * external-cancel case so each test overrides only what it is about.
 */
function stubFetch({ jobs = [], runs = [], rerunStatus = 201 } = {}) {
  const calls = [];
  const impl = vi.fn(async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET' });
    if (url.includes('/jobs?')) return json({ total_count: jobs.length, jobs });
    if (url.includes('/runs?')) return json({ total_count: runs.length, workflow_runs: runs });
    if (url.endsWith('/rerun')) return { ok: rerunStatus < 300, status: rerunStatus };
    throw new Error(`unexpected url ${url}`);
  });
  return { impl, calls, rerunRequested: () => calls.some((c) => c.url.endsWith('/rerun')) };
}

const silent = { log: () => {}, error: () => {} };
const noSummary = () => {};
const run = (env, fetchStub) => retryCancelledCiRun({
  env, fetchImpl: fetchStub.impl, logger: silent, writeSummary: noSummary,
});

describe('retryTargetFromEnv', () => {
  it('accepts a well-formed workflow_run environment', () => {
    const target = retryTargetFromEnv(BASE_ENV);
    expect(target).toMatchObject({ runId: '4242', runAttempt: 1, runNumber: 900, workflowId: '77' });
    expect(target.repoPath).toBe('https://api.github.com/repos/example-owner/example-repo');
  });

  it.each([
    ['a non-numeric run id', { CI_RUN_ID: '4242; rm -rf /' }],
    ['a missing token', { GITHUB_TOKEN: '' }],
    ['a malformed repository', { GITHUB_REPOSITORY: 'example-owner' }],
    ['an empty head branch', { CI_RUN_HEAD_BRANCH: '' }],
    ['a non-https API base', { GITHUB_API_URL: 'http://api.example.com' }],
  ])('rejects %s', (_label, override) => {
    expect(retryTargetFromEnv({ ...BASE_ENV, ...override })).toBeNull();
  });
});

describe('retryCancelledCiRun guards', () => {
  it('re-dispatches a cancelled pull-request run with no failing job and no successor', async () => {
    const fetchStub = stubFetch({
      jobs: [{ name: 'DB tests', conclusion: 'success' }, { name: 'Client', conclusion: 'cancelled' }],
      runs: [{ id: 4242, run_number: 900 }],
    });

    await expect(run(BASE_ENV, fetchStub)).resolves.toMatchObject({ outcome: 'requested' });
    expect(fetchStub.rerunRequested()).toBe(true);
  });

  it('never retries a run that is already attempt 2 — the retry budget', async () => {
    const fetchStub = stubFetch();
    await expect(run({ ...BASE_ENV, CI_RUN_ATTEMPT: '2' }, fetchStub))
      .resolves.toMatchObject({ outcome: 'skipped', reason: 'retry-budget-exhausted' });
    expect(fetchStub.impl).not.toHaveBeenCalled();
  });

  it('never retries a legitimate cancel-in-progress supersession', async () => {
    const fetchStub = stubFetch({ runs: [{ id: 5000, run_number: 901 }, { id: 4242, run_number: 900 }] });
    await expect(run(BASE_ENV, fetchStub))
      .resolves.toMatchObject({ outcome: 'skipped', reason: 'superseded' });
    expect(fetchStub.rerunRequested()).toBe(false);
  });

  it.each(['failure', 'timed_out'])(
    'never retries a run whose job concluded %s — this repo self-cancels on a real red',
    async (conclusion) => {
      // scripts/cancel-current-ci-run.js makes the RUN read `cancelled` while a
      // job really failed. Retrying that re-runs the whole suite on a red tree.
      const fetchStub = stubFetch({
        jobs: [{ name: 'Server tests', conclusion }, { name: 'Client', conclusion: 'cancelled' }],
      });
      await expect(run(BASE_ENV, fetchStub))
        .resolves.toMatchObject({ outcome: 'skipped', reason: 'job-failed' });
      expect(fetchStub.rerunRequested()).toBe(false);
    },
  );

  it.each([
    ['a run that did not end cancelled', { CI_RUN_CONCLUSION: 'failure' }, 'not-cancelled'],
    ['a nightly or dispatched run', { CI_RUN_EVENT: 'schedule' }, 'not-a-pull-request'],
    ['a malformed environment', { CI_RUN_ID: 'not-a-number' }, 'invalid-environment'],
  ])('skips %s', async (_label, override, reason) => {
    const fetchStub = stubFetch();
    await expect(run({ ...BASE_ENV, ...override }, fetchStub))
      .resolves.toMatchObject({ outcome: 'skipped', reason });
    expect(fetchStub.impl).not.toHaveBeenCalled();
  });

  it('encodes the branch name into the query, never into a path', async () => {
    // The head branch is attacker-controlled on a fork PR.
    const fetchStub = stubFetch();
    await run({ ...BASE_ENV, CI_RUN_HEAD_BRANCH: 'feat/../../evil?x=1' }, fetchStub);

    const listing = fetchStub.calls.find((c) => c.url.includes('/runs?'));
    expect(listing.url).toContain('branch=feat%2F..%2F..%2Fevil%3Fx%3D1');
    expect(listing.url).not.toContain('/evil');
  });

  it('does not retry when the job listing cannot be read', async () => {
    // "We could not see the jobs" must never read as "no job failed".
    const impl = vi.fn(async (url) => (url.includes('/jobs?')
      ? { ok: false, status: 502 }
      : json({ workflow_runs: [] })));
    await expect(retryCancelledCiRun({
      env: BASE_ENV, fetchImpl: impl, logger: silent, writeSummary: noSummary,
    })).resolves.toMatchObject({ outcome: 'unavailable', reason: 'jobs-unavailable' });
    expect(impl.mock.calls.some(([url]) => url.endsWith('/rerun'))).toBe(false);
  });

  it('does not retry when the job listing is truncated', async () => {
    // total_count outruns the page: a failing job could be on the page we
    // never received.
    const impl = vi.fn(async (url) => (url.includes('/jobs?')
      ? json({ total_count: 40, jobs: [] })
      : json({ workflow_runs: [] })));
    await expect(retryCancelledCiRun({
      env: BASE_ENV, fetchImpl: impl, logger: silent, writeSummary: noSummary,
    })).resolves.toMatchObject({ outcome: 'unavailable', reason: 'jobs-unavailable' });
  });

  it('does not retry when the sibling-run listing cannot be read', async () => {
    const impl = vi.fn(async (url) => (url.includes('/runs?')
      ? { ok: false, status: 403 }
      : json({ total_count: 0, jobs: [] })));
    await expect(retryCancelledCiRun({
      env: BASE_ENV, fetchImpl: impl, logger: silent, writeSummary: noSummary,
    })).resolves.toMatchObject({ outcome: 'unavailable', reason: 'sibling-runs-unavailable' });
  });

  it('survives a network failure without throwing', async () => {
    const impl = vi.fn(async () => { throw new Error('socket hang up'); });
    await expect(retryCancelledCiRun({
      env: BASE_ENV, fetchImpl: impl, logger: silent, writeSummary: noSummary,
    })).resolves.toMatchObject({ outcome: 'unavailable' });
  });

  it('reports a rejected rerun rather than claiming success', async () => {
    const fetchStub = stubFetch({ rerunStatus: 403 });
    await expect(run(BASE_ENV, fetchStub))
      .resolves.toMatchObject({ outcome: 'unavailable', reason: 'rerun-rejected', status: 403 });
  });

  it('records why it did not retry on the recovery run summary', async () => {
    // "Why wasn't my run retried?" has to be answerable without reading logs,
    // and the summary must never echo the attacker-controlled branch name.
    const written = [];
    const fetchStub = stubFetch({ runs: [{ id: 5000, run_number: 901 }] });
    await retryCancelledCiRun({
      env: { ...BASE_ENV, CI_RUN_HEAD_BRANCH: 'evil <img src=x>' },
      fetchImpl: fetchStub.impl,
      logger: silent,
      writeSummary: (markdown) => written.push(markdown),
    });

    expect(written).toHaveLength(1);
    expect(written[0]).toContain('reason: superseded');
    expect(written[0]).toContain('run: 4242');
    expect(written[0]).not.toContain('evil');
  });
});

describe('ci-cancel-recovery.yml wiring', () => {
  const jobs = workflowJobs(RECOVERY_WORKFLOW);

  it('triggers on a completed CI run and nothing else', () => {
    expect(RECOVERY_WORKFLOW).toMatch(/on:\n {2}workflow_run:\n {4}workflows: \[CI\]\n {4}types: \[completed\]/);
    // A `pull_request` trigger here would run with the PR's own code.
    expect(RECOVERY_WORKFLOW).not.toMatch(/^\s{2}pull_request:/m);
  });

  it('pre-filters on the same three cheap guards the script re-checks', () => {
    for (const guard of [
      "github.event.workflow_run.conclusion == 'cancelled'",
      "github.event.workflow_run.event == 'pull_request'",
      'github.event.workflow_run.run_attempt == 1',
    ]) {
      expect(jobs.retry).toContain(guard);
    }
  });

  it('passes the run identity the script validates', () => {
    for (const key of ['CI_RUN_ID', 'CI_RUN_ATTEMPT', 'CI_RUN_NUMBER', 'CI_WORKFLOW_ID',
      'CI_RUN_EVENT', 'CI_RUN_CONCLUSION', 'CI_RUN_HEAD_BRANCH', 'CI_RUN_HEAD_SHA']) {
      expect(jobs.retry, key).toContain(`${key}: \${{ github.event.workflow_run.`);
    }
  });

  it('never checks out or builds the pull request head with its writable token', () => {
    // workflow_run runs the default-branch copy; checking out the PR head here
    // would hand `actions: write` to code from a fork.
    expect(jobs.retry).toContain('persist-credentials: false');
    expect(jobs.retry).not.toMatch(/ref:\s*\$\{\{/);
    // `run:` lines only — a prose comment may mention npm, a step may not.
    const commands = jobs.retry.split('\n').filter((line) => /^\s+run:/.test(line));
    expect(commands).toEqual(['        run: node scripts/ci-retry-cancelled-run.js']);
  });

  it('re-dispatches from a sparse checkout with no dependency install', () => {
    // Latency is the whole point of this workflow: a full-tree checkout plus
    // setup-node would roughly double its time-to-re-dispatch, and the script
    // imports Node builtins only.
    expect(jobs.retry).toContain('sparse-checkout: scripts');
    expect(jobs.retry).not.toContain('actions/setup-node');
  });

  it('grants write only to actions, and never cancels its own recovery', () => {
    expect(RECOVERY_WORKFLOW).toMatch(/permissions:\n {2}contents: read\n {2}actions: write\n/);
    expect(RECOVERY_WORKFLOW).toContain('cancel-in-progress: false');
  });
});
