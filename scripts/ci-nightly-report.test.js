/**
 * The nightly report names the merges since the last green scheduled run. These
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
function stubFetch(routes) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    if (init.method && init.method !== 'GET') return { ok: true, status: 201, json: async () => ({}) };
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
  const GREEN_RUNS = { workflow_runs: [
    { id: 500, head_sha: HEAD, event: 'push' },
    { id: 495, head_sha: 'c'.repeat(40), event: 'pull_request' },
    { id: 490, head_sha: BASE, event: 'schedule' },
  ] };
  const redRoutes = (issues) => ({
    '/actions/runs/500/jobs': RUN_JOBS,
    '/actions/workflows/ci.yml/runs': GREEN_RUNS,
    [`/compare/${BASE}...${HEAD}`]: {
      total_commits: 2,
      commits: [mergeCommit('5555555555', 21, 'Break Windows'), commit('6666666666', 'inner commit')],
    },
    '/issues?': issues,
  });
  const OPEN_ISSUE = { number: 77, title: 'main is red' };

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

  it('closes the open issue on a green run', async () => {
    const { fetchImpl, writes } = stubFetch({ '/issues?': [OPEN_ISSUE] });
    const result = await reportMainHealth({
      env: { ...ENV, CI_RUN_CONCLUSION: 'success' }, logger, writeSummary: vi.fn(), fetchImpl,
    });
    expect(result).toMatchObject({ action: 'closed', syncFailed: false });
    expect(writes().map(({ method, url }) => `${method} ${url.split('/repos/example/repo')[1]}`))
      .toEqual(['POST /issues/77/comments', 'PATCH /issues/77']);
    expect(writes()[1].body).toEqual({ state: 'closed', state_reason: 'completed' });
  });

  it('does nothing on a green run when no issue is open', async () => {
    const { fetchImpl, writes } = stubFetch({ '/issues?': [] });
    const result = await reportMainHealth({
      env: { ...ENV, CI_RUN_CONCLUSION: 'success' }, logger, writeSummary: vi.fn(), fetchImpl,
    });
    expect(result).toMatchObject({ action: 'none', syncFailed: false });
    expect(writes()).toEqual([]);
  });

  it('fails loudly rather than opening a duplicate when the issue listing is unreadable', async () => {
    const { fetchImpl, writes } = stubFetch(redRoutes(null));
    const result = await reportMainHealth({ env: ENV, logger, writeSummary: vi.fn(), fetchImpl });
    expect(result.syncFailed).toBe(true);
    expect(writes()).toEqual([]);
  });

  it('survives every diagnostic lookup failing and still files an honest issue', async () => {
    const { fetchImpl, writes } = stubFetch({ '/actions/runs/500/jobs': null, '/actions/workflows/ci.yml/runs': null, '/issues?': [] });
    const writeSummary = vi.fn();
    const { report } = await reportMainHealth({ env: ENV, logger, writeSummary, fetchImpl });
    expect(report).toContain('could not be read');
    expect(report).toContain('suspect range is unknown');
    expect(writes()[0].body.body).toContain('Commit range: unknown');
  });
});
