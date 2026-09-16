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

import { RETRY_DELAY_MS, retryCancelledCiRun, retryTargetFromEnv } from './ci-retry-cancelled-run.js';
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
  CI_RUN_HEAD_REPOSITORY_ID: '555',
  CI_RUN_HEAD_SHA: 'c'.repeat(40),
};

const json = (body) => ({ ok: true, status: 200, json: async () => body });

/**
 * A fetch stub routed by URL shape. `jobs`/`runs` default to the clean
 * external-cancel case so each test overrides only what it is about.
 */
function stubFetch({ jobs = [], runs = [], rerunStatus = 201, live } = {}) {
  const calls = [];
  const impl = vi.fn(async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET' });
    // The ATTEMPT-scoped path, deliberately: /runs/{id}/jobs returns the
    // LATEST attempt's jobs, which is the wrong set after a human re-run.
    if (url.includes('/attempts/1/jobs?')) return json({ total_count: jobs.length, jobs });
    if (url.includes('/runs?')) {
      return json({
        total_count: runs.length,
        workflow_runs: runs.map((r) => ({ head_repository: { id: 555 }, ...r })),
      });
    }
    if (url.endsWith('/rerun')) return { ok: rerunStatus < 300, status: rerunStatus };
    if (/\/actions\/runs\/\d+$/.test(url)) {
      return json({ run_attempt: 1, status: 'completed', conclusion: 'cancelled', ...live });
    }
    throw new Error(`unexpected url ${url}`);
  });
  return { impl, calls, rerunRequested: () => calls.some((c) => c.url.endsWith('/rerun')) };
}

const silent = { log: () => {}, error: () => {} };
const noSummary = () => {};
/** No suite ever sleeps — the production wait is always replaced. */
const noWait = async () => {};
/** ...and `waits` records what the delay WOULD have been. */
const fakeClock = () => {
  const waits = [];
  return { waits, wait: async (ms) => { waits.push(ms); } };
};
const invoke = (options) => retryCancelledCiRun({
  logger: silent, writeSummary: noSummary, wait: noWait, ...options,
});
const run = (env, fetchStub) => invoke({ env, fetchImpl: fetchStub.impl });

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

  it('retries a job whose STEP failed but whose conclusion reads cancelled', async () => {
    // The fail-fast self-cancel can land while the failing job is still in its
    // post-steps, and GitHub then records that job as `cancelled`. Trusting the
    // job conclusion alone would re-run a genuinely red tree.
    const fetchStub = stubFetch({
      jobs: [{
        name: 'Server tests',
        conclusion: 'cancelled',
        steps: [{ conclusion: 'success' }, { conclusion: 'failure' }],
      }],
    });
    await expect(run(BASE_ENV, fetchStub))
      .resolves.toMatchObject({ outcome: 'skipped', reason: 'job-failed' });
    expect(fetchStub.rerunRequested()).toBe(false);
  });

  it('is not suppressed by an OLDER sibling run', async () => {
    // The supersession guard must compare, not merely detect a sibling.
    const fetchStub = stubFetch({ runs: [{ id: 4000, run_number: 899 }, { id: 4242, run_number: 900 }] });
    await expect(run(BASE_ENV, fetchStub)).resolves.toMatchObject({ outcome: 'requested' });
  });

  it('is not suppressed by a same-named branch on a different fork', async () => {
    // `?branch=` matches head_branch alone, so two forks pushing `patch-1`
    // share a listing. Only a missed retry, but it is avoidable.
    const fetchStub = stubFetch({
      runs: [{ id: 9001, run_number: 950, head_repository: { id: 999 } }],
    });
    await expect(run(BASE_ENV, fetchStub)).resolves.toMatchObject({ outcome: 'requested' });
  });

  it('reads a job listing that spans two pages before deciding', async () => {
    // A failing job on page 2 must still block the retry.
    const pages = {
      1: { total_count: 2, jobs: [{ name: 'Client', conclusion: 'cancelled' }] },
      2: { total_count: 2, jobs: [{ name: 'Server tests', conclusion: 'failure' }] },
    };
    const impl = vi.fn(async (url) => {
      if (url.includes('/jobs?')) return json(pages[new URL(url).searchParams.get('page')]);
      return json({ workflow_runs: [] });
    });
    await expect(invoke({ env: BASE_ENV, fetchImpl: impl }))
      .resolves.toMatchObject({ outcome: 'skipped', reason: 'job-failed' });
  });

  it('never lets a pull-request job name forge an Actions workflow command', async () => {
    // `job.name` comes from the PR's own workflow file, and Actions parses a
    // line starting with `::` as a command.
    const logged = [];
    const fetchStub = stubFetch({
      jobs: [{ name: 'Server\n::add-mask::secret', conclusion: 'failure' }],
    });
    await invoke({
      env: BASE_ENV,
      fetchImpl: fetchStub.impl,
      logger: { log: (l) => logged.push(l), error: (l) => logged.push(l) },
    });

    const text = logged.join('\n');
    expect(text).toContain('Server');
    expect(text).not.toContain('::add-mask::');
    expect(text.split('\n').some((line) => line.startsWith('::'))).toBe(false);
  });

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

  it.each([
    ['a human already re-ran it', { run_attempt: 2 }],
    ['it is running again', { status: 'in_progress', conclusion: '' }],
    ['the re-run has since succeeded', { conclusion: 'success' }],
  ])('never spends the budget when the live run says %s', async (_label, live) => {
    // The workflow_run payload is a snapshot; this job can start long after it.
    const fetchStub = stubFetch({ live });
    await expect(run(BASE_ENV, fetchStub))
      .resolves.toMatchObject({ outcome: 'skipped', reason: 'run-state-moved-on' });
    expect(fetchStub.rerunRequested()).toBe(false);
  });

  it('does not retry when the live run state cannot be read', async () => {
    const impl = vi.fn(async (url) => {
      if (url.includes('/jobs?')) return json({ total_count: 0, jobs: [] });
      if (url.includes('/runs?')) return json({ workflow_runs: [] });
      return { ok: false, status: 500 };
    });
    await expect(invoke({ env: BASE_ENV, fetchImpl: impl }))
      .resolves.toMatchObject({ outcome: 'unavailable', reason: 'run-state-unavailable' });
    expect(impl.mock.calls.some(([url]) => url.endsWith('/rerun'))).toBe(false);
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
    await expect(invoke({ env: BASE_ENV, fetchImpl: impl }))
      .resolves.toMatchObject({ outcome: 'unavailable', reason: 'jobs-unavailable' });
    expect(impl.mock.calls.some(([url]) => url.endsWith('/rerun'))).toBe(false);
  });

  it('does not retry when the job listing is truncated', async () => {
    // total_count outruns the page: a failing job could be on the page we
    // never received.
    const impl = vi.fn(async (url) => (url.includes('/jobs?')
      ? json({ total_count: 40, jobs: [] })
      : json({ workflow_runs: [] })));
    await expect(invoke({ env: BASE_ENV, fetchImpl: impl }))
      .resolves.toMatchObject({ outcome: 'unavailable', reason: 'jobs-unavailable' });
  });

  it('does not retry when the sibling-run listing cannot be read', async () => {
    const impl = vi.fn(async (url) => {
      if (url.includes('/runs?')) return { ok: false, status: 403 };
      if (url.includes('/jobs?')) return json({ total_count: 0, jobs: [] });
      return json({ run_attempt: 1, status: 'completed', conclusion: 'cancelled' });
    });
    await expect(invoke({ env: BASE_ENV, fetchImpl: impl }))
      .resolves.toMatchObject({ outcome: 'unavailable', reason: 'sibling-runs-unavailable' });
  });

  it('survives a network failure without throwing', async () => {
    const impl = vi.fn(async () => { throw new Error('socket hang up'); });
    await expect(invoke({ env: BASE_ENV, fetchImpl: impl }))
      .resolves.toMatchObject({ outcome: 'unavailable' });
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
    await invoke({
      env: { ...BASE_ENV, CI_RUN_HEAD_BRANCH: 'evil <img src=x>' },
      fetchImpl: fetchStub.impl,
      writeSummary: (markdown) => written.push(markdown),
    });

    expect(written).toHaveLength(1);
    expect(written[0]).toContain('reason: superseded');
    expect(written[0]).toContain('run: 4242');
    expect(written[0]).not.toContain('evil');
  });
});

describe('the wait before re-dispatching', () => {
  // The cancel this recovers from is caused by a saturated queue, so the
  // one-retry budget is worth least at the instant the event arrives (7439).
  // Every test injects the clock — a real five-minute sleep in CI is not a
  // test, it is an outage.

  it('waits the full delay, and re-dispatches only afterwards', async () => {
    const fetchStub = stubFetch({ runs: [{ id: 4242, run_number: 900 }] });
    const seenBeforeWait = [];
    const clock = fakeClock();

    await expect(invoke({
      env: BASE_ENV,
      fetchImpl: fetchStub.impl,
      wait: async (ms) => {
        seenBeforeWait.push(...fetchStub.calls.map((call) => call.url));
        await clock.wait(ms);
      },
    })).resolves.toMatchObject({ outcome: 'requested', phase: 'after-wait' });

    expect(clock.waits).toEqual([RETRY_DELAY_MS]);
    expect(seenBeforeWait.some((url) => url.endsWith('/rerun'))).toBe(false);
  });

  it('lets a supersession that lands DURING the wait win', async () => {
    // This is the re-check the delay exists for: the pre-wait listing said
    // there was no successor, and a push five minutes later must still
    // cancel the retry rather than re-running code nobody is waiting on.
    let pushedDuringWait = false;
    const impl = vi.fn(async (url) => {
      if (url.includes('/jobs?')) return json({ total_count: 0, jobs: [] });
      if (url.includes('/runs?')) {
        return json({
          workflow_runs: pushedDuringWait
            ? [{ id: 5000, run_number: 901, head_repository: { id: 555 } }]
            : [],
        });
      }
      return json({ run_attempt: 1, status: 'completed', conclusion: 'cancelled' });
    });

    await expect(invoke({
      env: BASE_ENV,
      fetchImpl: impl,
      wait: async () => { pushedDuringWait = true; },
    })).resolves.toMatchObject({ outcome: 'skipped', reason: 'superseded', phase: 'after-wait' });
    expect(impl.mock.calls.some(([url]) => url.endsWith('/rerun'))).toBe(false);
  });

  it('lets a human re-run that lands DURING the wait keep the budget', async () => {
    let rerunByHuman = false;
    const impl = vi.fn(async (url) => {
      if (url.includes('/jobs?')) return json({ total_count: 0, jobs: [] });
      if (url.includes('/runs?')) return json({ workflow_runs: [] });
      return json({
        run_attempt: rerunByHuman ? 2 : 1, status: 'completed', conclusion: 'cancelled',
      });
    });

    await expect(invoke({
      env: BASE_ENV,
      fetchImpl: impl,
      wait: async () => { rerunByHuman = true; },
    })).resolves.toMatchObject({ outcome: 'skipped', reason: 'run-state-moved-on', phase: 'after-wait' });
    expect(impl.mock.calls.some(([url]) => url.endsWith('/rerun'))).toBe(false);
  });

  it('does not hold a runner idle for a run that is already ineligible', async () => {
    // Skipping before the wait is what keeps the delay cheap: a genuinely red
    // run costs one API call, not five minutes of occupancy.
    const clock = fakeClock();
    await expect(invoke({
      env: BASE_ENV,
      fetchImpl: stubFetch({ jobs: [{ name: 'Server tests', conclusion: 'failure' }] }).impl,
      wait: clock.wait,
    })).resolves.toMatchObject({ outcome: 'skipped', reason: 'job-failed', phase: 'before-wait' });
    expect(clock.waits).toEqual([]);
  });

  it('records the phase and the delay it used on the run summary', async () => {
    // The tuning evidence this issue asks for: a summary written under a
    // since-changed constant must still say which delay produced it.
    const written = [];
    await invoke({
      env: BASE_ENV,
      fetchImpl: stubFetch({ runs: [{ id: 4242, run_number: 900 }] }).impl,
      writeSummary: (markdown) => written.push(markdown),
    });
    expect(written[0]).toContain('phase: after-wait');
    expect(written[0]).toContain(`delay: ${RETRY_DELAY_MS / 1000}s`);
  });
});

describe('ci-cancel-recovery.yml wiring', () => {
  const jobs = workflowJobs(RECOVERY_WORKFLOW);

  it('gives the recovery job a timeout that outlives the wait', () => {
    // The job now idles for RETRY_DELAY_MS before re-dispatching. A timeout
    // shorter than that would kill it mid-wait and silently turn 'retried
    // late' into 'never retried at all'.
    const timeoutMinutes = Number(jobs.retry.match(/^\s+timeout-minutes:\s*(\d+)\s*$/m)?.[1]);
    expect(Number.isFinite(timeoutMinutes)).toBe(true);
    expect(timeoutMinutes * 60_000).toBeGreaterThan(RETRY_DELAY_MS);
  });

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

  it('passes the run identity the script validates, each from the right field', () => {
    // The exact expression, not just the prefix: mapping CI_RUN_NUMBER to
    // `.id` would be a silently wrong supersession comparison.
    const FIELDS = {
      CI_RUN_ID: 'id',
      CI_RUN_ATTEMPT: 'run_attempt',
      CI_RUN_NUMBER: 'run_number',
      CI_WORKFLOW_ID: 'workflow_id',
      CI_RUN_EVENT: 'event',
      CI_RUN_CONCLUSION: 'conclusion',
      CI_RUN_HEAD_BRANCH: 'head_branch',
      CI_RUN_HEAD_REPOSITORY_ID: 'head_repository.id',
      CI_RUN_HEAD_SHA: 'head_sha',
    };
    for (const [key, field] of Object.entries(FIELDS)) {
      expect(jobs.retry, key).toContain(`${key}: \${{ github.event.workflow_run.${field} }}`);
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
