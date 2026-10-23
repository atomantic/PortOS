/**
 * The nightly report names the merges since the last green scheduled run. These
 * tests pin the three outcomes a reader must never confuse: a real range, an
 * empty range, and a range that could not be read.
 */
import { describe, expect, it, vi } from 'vitest';

import { buildNightlyReport, mergedPullRequests, reportNightlyFailure } from './ci-nightly-report.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const ENV = {
  GITHUB_EVENT_NAME: 'schedule',
  GITHUB_REPOSITORY: 'example/repo',
  GITHUB_RUN_ID: '500',
  GITHUB_SHA: HEAD,
  GITHUB_TOKEN: 'synthetic-token',
};

const commit = (sha, message) => ({ sha, commit: { message } });
const mergeCommit = (sha, number, title) => commit(sha, `Merge pull request #${number} from example/branch-${number}\n\n${title}`);

/** A fetch stub that answers by URL fragment and records what it was asked. */
function stubFetch(routes) {
  const calls = [];
  const fetchImpl = vi.fn(async (url) => {
    calls.push(url);
    const hit = Object.entries(routes).find(([fragment]) => url.includes(fragment));
    if (!hit || hit[1] === null) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => hit[1] };
  });
  return { fetchImpl, calls };
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

describe('reportNightlyFailure', () => {
  it('only acts on a scheduled run', async () => {
    const { fetchImpl } = stubFetch({});
    const writeSummary = vi.fn();
    const result = await reportNightlyFailure({
      env: { ...ENV, GITHUB_EVENT_NAME: 'pull_request' }, logger: { log() {} }, writeSummary, fetchImpl,
    });
    expect(result).toEqual({ ran: false });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(writeSummary).not.toHaveBeenCalled();
  });

  it('compares from the last green scheduled run, skipping this run, and drops the gate job', async () => {
    const { fetchImpl, calls } = stubFetch({
      '/actions/runs/500/jobs': RUN_JOBS,
      '/actions/workflows/ci.yml/runs': { workflow_runs: [
        { id: 500, head_sha: HEAD },
        { id: 490, head_sha: BASE },
      ] },
      [`/compare/${BASE}...${HEAD}`]: {
        total_commits: 2,
        commits: [mergeCommit('5555555555', 21, 'Break Windows'), commit('6666666666', 'inner commit')],
      },
    });
    const writeSummary = vi.fn();
    const { ran, report } = await reportNightlyFailure({ env: ENV, logger: { log() {} }, writeSummary, fetchImpl });
    expect(ran).toBe(true);
    expect(calls.some((url) => url.includes(`/compare/${BASE}...${HEAD}`))).toBe(true);
    expect(report).toContain('#21 Break Windows');
    expect(report).toContain('Windows server unit tests (1/3) — failed step: Run server tests on Windows');
    expect(report).not.toContain('Require every selected job to pass');
    expect(writeSummary).toHaveBeenCalledWith(report);
  });

  it('survives every lookup failing and still publishes an honest report', async () => {
    const { fetchImpl } = stubFetch({ '/actions/runs/500/jobs': null, '/actions/workflows/ci.yml/runs': null });
    const { report } = await reportNightlyFailure({ env: ENV, logger: { log() {} }, writeSummary: vi.fn(), fetchImpl });
    expect(report).toContain('could not be read');
    expect(report).toContain('suspect range is unknown');
  });
});
