/**
 * The nightly report names the merges since the last green run on main. These
 * tests pin the three outcomes a reader must never confuse: a real range, an
 * empty range, and a range that could not be read.
 */
import { describe, expect, it, vi } from 'vitest';

import { buildMainRedIssueBody, buildNightlyReport, mergedPullRequests, reportMainHealth } from './ci-nightly-report.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const ENV = {
  CI_RUN_ID: '500',
  CI_RUN_SHA: HEAD,
  CI_RUN_BRANCH: 'main',
  CI_RUN_EVENT: 'push',
  CI_RUN_CONCLUSION: 'failure',
  GITHUB_REPOSITORY: 'example/repo',
  GITHUB_TOKEN: 'synthetic-token',
};

const commit = (sha, message) => ({ sha, commit: { message } });
const mergeCommit = (sha, number, title) => commit(sha, `Merge pull request #${number} from example/branch-${number}\n\n${title}`);

/**
 * A fetch stub that answers GETs by URL fragment and records every request,
 * writes included. A `null` route is a failing endpoint.
 */
function stubFetch(routes, { writeStatus = 201 } = {}) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    if (init.method && init.method !== 'GET') {
      return { ok: writeStatus < 300, status: writeStatus, json: async () => ({}) };
    }
    const hit = Object.entries(routes).find(([fragment]) => url.includes(fragment));
    if (!hit || hit[1] === null) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => hit[1] };
  });
  const writes = () => calls.filter((call) => call.method !== 'GET');
  return { fetchImpl, calls, writes };
}

const RUN_JOBS = { jobs: [
  { name: 'Windows server unit tests (1/3)', conclusion: 'failure', steps: [{ name: 'Run server tests on Windows', conclusion: 'failure' }] },
  { name: 'CI Gate', conclusion: 'failure', steps: [{ name: 'Require every selected job to pass', conclusion: 'failure' }] },
  { name: 'Server tests (1/2)', conclusion: 'success', steps: [] },
] };

describe('mergedPullRequests', () => {
  it('reads merge-commit and squash-merge subjects, ignores ordinary commits', () => {
    const pulls = mergedPullRequests([
      mergeCommit('1111111111', 12, 'Fix the thing'),
      commit('2222222222', 'wip: not a merge'),
      commit('3333333333', 'Add widget (#13)\n\nbody'),
    ]);
    expect(pulls).toEqual([
      { number: 12, title: 'Fix the thing', sha: '111111111' },
      { number: 13, title: 'Add widget', sha: '333333333' },
    ]);
  });

  it('strips workflow-command syntax from a contributor-controlled title', () => {
    const [pull] = mergedPullRequests([mergeCommit('4444444444', 7, '::error::forged\nsecond line')]);
    expect(pull.title).not.toMatch(/\n/);
    expect(pull.title.startsWith('::')).toBe(false);
  });

  it('tolerates a missing commit list', () => {
    expect(mergedPullRequests(undefined)).toEqual([]);
  });
});

describe('buildNightlyReport', () => {
  const base = { sha: BASE, runId: 490 };

  it('lists the range newest-first with the failing step', () => {
    const report = buildNightlyReport({
      failedJobs: [{ name: 'Server tests (1/2)', steps: ['Run server tests'] }],
      base,
      head: HEAD,
      pulls: [{ number: 1, title: 'Old', sha: 'aaaaaaaaa' }, { number: 2, title: 'New', sha: 'bbbbbbbbb' }],
    });
    expect(report).toContain('Server tests (1/2) — failed step: Run server tests');
    expect(report.indexOf('#2 New')).toBeLessThan(report.indexOf('#1 Old'));
    expect(report).toContain('2 pull request(s) merged since');
  });

  it('says an empty range is a flake/environment suspect, not "no suspects"', () => {
    const report = buildNightlyReport({ failedJobs: [], base, head: HEAD, pulls: [] });
    expect(report).toContain('No pull request merged in that range');
  });

  it('keeps an unreadable range distinct from an empty one', () => {
    const report = buildNightlyReport({ failedJobs: null, base, head: HEAD, pulls: null });
    expect(report).toContain('could not be read');
    expect(report).not.toContain('No pull request merged');
  });

  it('reports an unknown range when no earlier green run exists', () => {
    expect(buildNightlyReport({ failedJobs: [], base: null, head: HEAD, pulls: null }))
      .toContain('suspect range is unknown');
  });

  it('flags a cut-off compare listing as missing the newest merges', () => {
    const report = buildNightlyReport({
      failedJobs: [], base, head: HEAD, truncated: true, pulls: [{ number: 1, title: 'A', sha: 'ccccccccc' }],
    });
    expect(report).toContain('the newest merges are not shown');
  });
});

describe('buildMainRedIssueBody', () => {
  it('carries only job names, the commit range and the run URL', () => {
    const body = buildMainRedIssueBody({
      failedJobs: [{ name: 'Server tests (1/2)', steps: ['Run server tests'] }],
      base: { sha: BASE, runId: 490 },
      head: HEAD,
      runUrl: 'https://github.com/example/repo/actions/runs/500',
      compareBase: 'https://github.com/example/repo/compare',
    });
    expect(body).toContain('Server tests (1/2) — failed step: Run server tests');
    expect(body).toContain(`compare/${BASE}...${HEAD}`);
    expect(body).toContain('https://github.com/example/repo/actions/runs/500');
  });

  it('says so when no range is known', () => {
    expect(buildMainRedIssueBody({ failedJobs: null, base: null, head: HEAD, runUrl: 'u', compareBase: 'c' }))
      .toContain('Commit range: unknown');
  });
});

describe('reportMainHealth', () => {
  const logger = { log() {}, error() {} };
  const run = (overrides = {}) => ({
    id: 500, run_number: 10, run_attempt: 1, head_sha: HEAD, head_branch: 'main',
    event: 'push', status: 'completed', conclusion: 'failure', ...overrides,
  });
  const EARLIER_GREEN = run({ id: 490, run_number: 9, head_sha: BASE, event: 'schedule', conclusion: 'success' });
  const runsRoute = (runs) => ({ '/actions/workflows/ci.yml/runs': { workflow_runs: runs } });
  const redRoutes = (issues, current = run(), otherRuns = [EARLIER_GREEN]) => ({
    '/actions/runs/500/attempts/1/jobs': RUN_JOBS,
    ...runsRoute([current, ...otherRuns]),
    [`/compare/${BASE}...${HEAD}`]: {
      total_commits: 2,
      commits: [mergeCommit('5555555555', 21, 'Break Windows'), commit('6666666666', 'inner commit')],
    },
    '/issues?': issues,
  });
  const OPEN_ISSUE = { number: 77, title: 'main is red' };
  const greenRoutes = (issues) => ({ ...runsRoute([run({ run_attempt: 2, conclusion: 'success' })]), '/issues?': issues });

  it('leaves the newer red alert open after an older green rerun', async () => {
    const newerRed = run({ id: 501, run_number: 11, head_sha: BASE });
    const { fetchImpl, writes } = stubFetch({
      ...runsRoute([run({ run_attempt: 2, conclusion: 'success' }), newerRed]),
      '/actions/runs/501/attempts/1/jobs': RUN_JOBS,
      '/issues?': [{ ...OPEN_ISSUE, body: 'Run: https://github.com/example/repo/actions/runs/501' }],
    });
    const result = await reportMainHealth({
      env: { ...ENV, CI_RUN_CONCLUSION: 'success' }, logger, writeSummary: vi.fn(), fetchImpl,
    });
    expect(result).toMatchObject({ action: 'none', syncFailed: false });
    expect(writes()).toEqual([]);
  });

  it('ignores a delayed red event after a newer run goes green', async () => {
    const newerGreen = run({ id: 501, run_number: 11, head_sha: BASE, conclusion: 'success' });
    const { fetchImpl, calls, writes } = stubFetch(redRoutes([], run(), [EARLIER_GREEN, newerGreen]));
    const result = await reportMainHealth({ env: ENV, logger, writeSummary: vi.fn(), fetchImpl });
    expect(result).toMatchObject({ action: 'none', syncFailed: false });
    expect(result.report).toContain('Last green run: #490');
    expect(calls.filter(({ url }) => url.includes('/actions/workflows/ci.yml/runs'))).toHaveLength(1);
    expect(writes()).toEqual([]);
  });

  it.each([
    [{ CI_RUN_CONCLUSION: 'cancelled' }],
    [{ CI_RUN_EVENT: 'pull_request' }],
    [{ CI_RUN_BRANCH: 'feature' }],
  ])('ignores a run that says nothing about main (%o)', async (override) => {
    const { fetchImpl } = stubFetch({});
    const result = await reportMainHealth({ env: { ...ENV, ...override }, logger, writeSummary: vi.fn(), fetchImpl });
    expect(result).toEqual({ ran: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // Run 43934445327: the macOS runner was never acquired, GitHub cancelled the
  // job with no steps, and the gates failed because a selected job was not green.
  const GATES = [
    { name: 'CI Gate', conclusion: 'failure', steps: [{ name: 'Require every selected job to pass', conclusion: 'failure' }] },
    { name: 'Full CI Gate', conclusion: 'failure', steps: [{ name: 'Require the aggregate gate to have passed', conclusion: 'failure' }] },
  ];
  const NEVER_ACQUIRED = { name: 'macOS native release-agent supervision', conclusion: 'cancelled', steps: [] };

  it('changes nothing when the only non-green job never got a runner', async () => {
    const { fetchImpl, writes, calls } = stubFetch({ ...runsRoute([run()]), '/actions/runs/500/attempts/1/jobs': { jobs: [
      { name: 'Server tests (1/2)', conclusion: 'success', steps: [] }, NEVER_ACQUIRED, ...GATES,
    ] }, '/issues?': [OPEN_ISSUE] });
    const writeSummary = vi.fn();
    const result = await reportMainHealth({ env: ENV, logger, writeSummary, fetchImpl });
    expect(result).toEqual({ ran: false, inconclusive: true });
    expect(writes()).toEqual([]);
    expect(writeSummary).not.toHaveBeenCalled();
    expect(calls.some(({ url }) => url.includes('/issues?'))).toBe(false);
  });

  it('ignores newer cancellations, unrelated runs and a runner-capacity-only attempt', async () => {
    const capacity = run({ id: 501, run_number: 11, run_attempt: 2 });
    const cancelled = run({ id: 502, run_number: 12, conclusion: 'cancelled' });
    const pr = run({ id: 503, run_number: 13, event: 'pull_request', conclusion: 'success' });
    const otherBranch = run({ id: 504, run_number: 14, head_branch: 'feature', conclusion: 'success' });
    const { fetchImpl, calls, writes } = stubFetch({
      ...redRoutes([], run(), [EARLIER_GREEN, pr, cancelled, otherBranch, capacity]),
      '/actions/runs/501/attempts/2/jobs': { jobs: [NEVER_ACQUIRED, ...GATES] },
      '/actions/runs/501/attempts/1': run({ id: 501, run_number: 11, conclusion: 'cancelled' }),
    });
    const result = await reportMainHealth({ env: ENV, logger, writeSummary: vi.fn(), fetchImpl });
    expect(result).toMatchObject({ action: 'created', syncFailed: false });
    expect(calls.filter(({ url }) => url.includes('/actions/runs/501/') && url.includes('/jobs')).map(({ url }) => new URL(url).pathname))
      .toEqual(['/repos/example/repo/actions/runs/501/attempts/2/jobs']);
    expect(writes()).toHaveLength(1);
  });

  it('preserves a newer red verdict when a retry of it is cancelled', async () => {
    const newerRed = run({ id: 501, run_number: 11, head_sha: BASE });
    const { fetchImpl, writes } = stubFetch({
      ...runsRoute([run({ conclusion: 'success' }), { ...newerRed, run_attempt: 2, conclusion: 'cancelled' }]),
      '/actions/runs/501/attempts/1/jobs': RUN_JOBS,
      '/actions/runs/501/attempts/1': newerRed,
      '/issues?': [{ ...OPEN_ISSUE, body: 'Run: https://github.com/example/repo/actions/runs/501' }],
    });
    const result = await reportMainHealth({
      env: { ...ENV, CI_RUN_CONCLUSION: 'success' }, logger, writeSummary: vi.fn(), fetchImpl,
    });
    expect(result).toMatchObject({ action: 'none', syncFailed: false });
    expect(writes()).toEqual([]);
  });

  it('does not close the alert when the newer red result cannot be classified', async () => {
    const { fetchImpl, writes } = stubFetch({
      ...runsRoute([run({ conclusion: 'success' }), run({ id: 501, run_number: 11 })]),
      '/actions/runs/501/attempts/1/jobs': null,
      '/issues?': [OPEN_ISSUE],
    });
    const result = await reportMainHealth({
      env: { ...ENV, CI_RUN_CONCLUSION: 'success' }, logger, writeSummary: vi.fn(), fetchImpl,
    });
    expect(result).toMatchObject({ action: 'none', syncFailed: true });
    expect(writes()).toEqual([]);
  });

  it('ignores a red replay when the same run’s current attempt is green', async () => {
    const { fetchImpl, writes } = stubFetch(redRoutes([OPEN_ISSUE], run({ run_attempt: 2, conclusion: 'success' })));
    const result = await reportMainHealth({ env: ENV, logger, writeSummary: vi.fn(), fetchImpl });
    expect(result).toMatchObject({ action: 'none', syncFailed: false });
    expect(writes()).toEqual([]);
  });

  it('lets a newer green push close an alert from an older red run', async () => {
    const olderRed = run({ id: 499, run_number: 9, head_sha: BASE });
    const { fetchImpl, writes } = stubFetch({
      ...runsRoute([olderRed, run({ conclusion: 'success' })]),
      '/issues?': [{ ...OPEN_ISSUE, body: 'Run: https://github.com/example/repo/actions/runs/499' }],
    });
    const result = await reportMainHealth({
      env: { ...ENV, CI_RUN_CONCLUSION: 'success' }, logger, writeSummary: vi.fn(), fetchImpl,
    });
    expect(result).toMatchObject({ action: 'closed', syncFailed: false });
    expect(writes()).toHaveLength(1);
  });

  it('ignores an old rerun outside the recent run list when there is a newer verdict', async () => {
    const { fetchImpl, writes } = stubFetch({
      ...runsRoute([run({ id: 501, run_number: 11, conclusion: 'success' })]),
      '/actions/runs/500': run({ run_attempt: 2, path: '.github/workflows/ci.yml' }),
    });
    const result = await reportMainHealth({ env: ENV, logger, writeSummary: vi.fn(), fetchImpl });
    expect(result).toMatchObject({ action: 'none', syncFailed: false });
    expect(writes()).toEqual([]);
  });

  it('still reports red when a real failure sits beside a never-started job', async () => {
    const stub = stubFetch({ ...redRoutes([]), '/actions/runs/500/attempts/1/jobs': { jobs: [...RUN_JOBS.jobs, NEVER_ACQUIRED] } });
    const result = await reportMainHealth({ env: ENV, logger, writeSummary: vi.fn(), fetchImpl: stub.fetchImpl });
    expect(result.action).toBe('created');
    expect(stub.writes()[0].body.body).toContain('Windows server unit tests (1/3) — failed step');
  });

  it('names a job cancelled after it started as a timeout suspect and stays red', async () => {
    const stub = stubFetch({ ...redRoutes([]), '/actions/runs/500/attempts/1/jobs': { jobs: [
      { name: 'Browser suites (1/2)', conclusion: 'cancelled', steps: [{ name: 'Run browser suites', conclusion: 'cancelled' }] },
      ...GATES,
    ] } });
    const result = await reportMainHealth({ env: ENV, logger, writeSummary: vi.fn(), fetchImpl: stub.fetchImpl });
    expect(result.action).toBe('created');
    expect(stub.writes()[0].body.body).toContain('Browser suites (1/2) — cancelled after it started (a job timeout or a lost runner)');
  });

  it('names a timed_out job without a failed step', async () => {
    const stub = stubFetch({ ...redRoutes([], run({ conclusion: 'timed_out' })), '/actions/runs/500/attempts/1/jobs': { jobs: [
      { name: 'DB tests', conclusion: 'timed_out', steps: [] }, ...GATES,
    ] } });
    await reportMainHealth({ env: { ...ENV, CI_RUN_CONCLUSION: 'timed_out' }, logger, writeSummary: vi.fn(), fetchImpl: stub.fetchImpl });
    expect(stub.writes()[0].body.body).toContain('DB tests — timed out');
  });

  it('creates one labelled issue for the first red run and writes the suspect summary', async () => {
    const { fetchImpl, writes } = stubFetch(redRoutes([]));
    const writeSummary = vi.fn();
    const result = await reportMainHealth({ env: ENV, logger, writeSummary, fetchImpl });
    expect(result).toMatchObject({ ran: true, action: 'created', syncFailed: false });
    expect(writes()).toHaveLength(1);
    const [create] = writes();
    expect(create).toMatchObject({ method: 'POST', body: { title: 'main is red', labels: ['bug', 'area:ci', 'model:medium', 'effort:medium'] } });
    expect(create.url).toMatch(/\/repos\/example\/repo\/issues$/);
    expect(create.body.body).toContain('Windows server unit tests (1/3) — failed step: Run server tests on Windows');
    expect(create.body.body).not.toContain('Require every selected job to pass');
    expect(create.body.body).toContain(`${BASE}...${HEAD}`);
    expect(writeSummary).toHaveBeenCalledWith(expect.stringContaining('#21 Break Windows'));
  });

  it('updates the existing issue for a second red run instead of opening another', async () => {
    const { fetchImpl, writes } = stubFetch(redRoutes([OPEN_ISSUE, { number: 5, title: 'unrelated' }]));
    const result = await reportMainHealth({ env: ENV, logger, writeSummary: vi.fn(), fetchImpl });
    expect(result).toMatchObject({ action: 'updated', syncFailed: false });
    expect(writes().map(({ method, url }) => `${method} ${url.split('/repos/example/repo')[1]}`))
      .toEqual(['PATCH /issues/77', 'POST /issues/77/comments']);
  });

  it('ignores a pull request that happens to carry the title', async () => {
    const { fetchImpl, writes } = stubFetch(redRoutes([{ ...OPEN_ISSUE, pull_request: {} }]));
    const result = await reportMainHealth({ env: ENV, logger, writeSummary: vi.fn(), fetchImpl });
    expect(result.action).toBe('created');
    expect(writes()[0].method).toBe('POST');
  });

  it('closes the same run’s red alert after its retry goes green and records the recovery', async () => {
    const redBody = 'Failed jobs: Windows server unit tests\n\nCommit range: unknown';
    const { fetchImpl, writes } = stubFetch(greenRoutes([{ ...OPEN_ISSUE, body: redBody }]));
    const result = await reportMainHealth({
      env: { ...ENV, CI_RUN_CONCLUSION: 'success' }, logger, writeSummary: vi.fn(), fetchImpl,
    });
    expect(result).toMatchObject({ action: 'closed', syncFailed: false });
    expect(writes()).toEqual([{
      method: 'PATCH',
      url: 'https://api.github.com/repos/example/repo/issues/77',
      body: {
        state: 'closed',
        state_reason: 'completed',
        body: `${redBody}\n\nGreen again at \`${HEAD.slice(0, 9)}\`: https://github.com/example/repo/actions/runs/500`,
      },
    }]);
  });

  it('reports a sync failure when the green close update fails', async () => {
    const { fetchImpl, writes } = stubFetch(greenRoutes([{ ...OPEN_ISSUE, body: null }]), { writeStatus: 503 });
    const result = await reportMainHealth({
      env: { ...ENV, CI_RUN_CONCLUSION: 'success' }, logger, writeSummary: vi.fn(), fetchImpl,
    });
    expect(result).toMatchObject({ action: 'closed', syncFailed: true });
    expect(writes().map(({ method }) => method)).toEqual(['PATCH']);
    expect(writes()[0].body.body).toBe(`Green again at \`${HEAD.slice(0, 9)}\`: https://github.com/example/repo/actions/runs/500`);
  });

  it('does nothing on a green run when no issue is open', async () => {
    const { fetchImpl, calls, writes } = stubFetch({ '/issues?': [] });
    const result = await reportMainHealth({
      env: { ...ENV, CI_RUN_CONCLUSION: 'success' }, logger, writeSummary: vi.fn(), fetchImpl,
    });
    expect(result).toMatchObject({ action: 'none', syncFailed: false });
    expect(writes()).toEqual([]);
    expect(calls.map(({ url }) => new URL(url).pathname)).toEqual(['/repos/example/repo/issues']);
  });

  it('fails loudly rather than opening a duplicate when the issue listing is unreadable', async () => {
    const { fetchImpl, writes } = stubFetch(redRoutes(null));
    const result = await reportMainHealth({ env: ENV, logger, writeSummary: vi.fn(), fetchImpl });
    expect(result.syncFailed).toBe(true);
    expect(writes()).toEqual([]);
  });

  it('leaves the issue untouched when the authoritative run listing fails', async () => {
    const { fetchImpl, writes } = stubFetch({ '/actions/workflows/ci.yml/runs': null, '/issues?': [OPEN_ISSUE] });
    const log = { log: vi.fn(), error: vi.fn() };
    for (const CI_RUN_CONCLUSION of ['success', 'failure']) {
      const result = await reportMainHealth({
        env: { ...ENV, CI_RUN_CONCLUSION }, logger: log, writeSummary: vi.fn(), fetchImpl,
      });
      expect(result).toMatchObject({ action: 'none', syncFailed: true });
    }
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('recent main CI runs could not be read'));
    expect(writes()).toEqual([]);
  });

  it('leaves the issue untouched when the current red jobs cannot be classified', async () => {
    const { fetchImpl, writes } = stubFetch({ ...redRoutes([]), '/actions/runs/500/attempts/1/jobs': null });
    const result = await reportMainHealth({ env: ENV, logger, writeSummary: vi.fn(), fetchImpl });
    expect(result).toMatchObject({ action: 'none', syncFailed: true });
    expect(result.report).toContain('Failing jobs: **could not be read**');
    expect(writes()).toEqual([]);
  });

  it('keeps an unreadable compare distinct while filing the current red alert', async () => {
    const { fetchImpl, writes } = stubFetch({ ...redRoutes([]), [`/compare/${BASE}...${HEAD}`]: null });
    const result = await reportMainHealth({ env: ENV, logger, writeSummary: vi.fn(), fetchImpl });
    expect(result).toMatchObject({ action: 'created', syncFailed: false });
    expect(result.report).toContain('The commit range could not be read');
    expect(writes()[0].body.body).toContain(`${BASE}...${HEAD}`);
  });
});
