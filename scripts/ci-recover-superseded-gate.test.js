import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CANCEL_SETTLE_MS, DRAIN_POLL_INTERVAL_MS, DRAIN_TIMEOUT_MS, recoverSupersededGate } from './ci-recover-superseded-gate.js';

const env = {
  GITHUB_REPOSITORY: 'example/project', GITHUB_REPOSITORY_ID: '10', GITHUB_TOKEN: 'test-token',
  CI_RUN_ID: '102', CI_WORKFLOW_ID: '8', CI_RUN_HEAD_REPOSITORY_ID: '10', CI_RUN_HEAD_SHA: 'b'.repeat(40),
};
const run = (old = false) => ({
  id: old ? 101 : 102, workflow_id: 8, run_number: old ? 20 : 21, run_attempt: 1,
  repository: { id: 10, full_name: 'example/project' }, head_repository: { id: 10 },
  head_sha: (old ? 'a' : 'b').repeat(40), head_branch: 'fix/example',
  event: 'pull_request', pull_requests: [{ number: 12 }],
  status: old ? 'in_progress' : 'pending', conclusion: null,
});
const jobs = () => [
  { id: 1, run_id: 101, name: 'Server tests', status: 'completed', conclusion: 'failure', steps: [{ status: 'completed', conclusion: 'failure' }] },
  { id: 2, run_id: 101, name: 'CI Gate', status: 'queued', conclusion: null, started_at: null, completed_at: null, steps: [] },
];

// The public HTTP boundary is stateful: POST acceptance and observed settlement
// are independent, and the wait can change current-head/attempt/job identities.
function api(options = {}) {
  const state = {
    old: run(true), next: run(), jobs: jobs(), nextJobs: [],
    pr: { number: 12, state: 'open', base: { repo: { id: 10 } }, head: { sha: env.CI_RUN_HEAD_SHA, repo: { id: 10 }, ref: 'fix/example' } },
    ...options.state,
  };
  const writes = [];
  const reads = [];
  let clock = 0;
  const fetchImpl = vi.fn(async (url, init = {}) => {
    const path = new URL(url).pathname.replace('/repos/example/project', '');
    if (init.method === 'POST') {
      writes.push(path);
      const kind = path.endsWith('/force-cancel') ? 'force' : 'normal';
      if (options[`${kind}Settles`]) Object.assign(state.old, { status: 'completed', conclusion: 'cancelled' });
      if (kind === 'force') options.afterForce?.(state);
      if (options[`${kind}Throws`]) throw new Error('connection lost after write');
      return { status: options[`${kind}Status`] ?? 202 };
    }
    reads.push(path);
    if (options.unreadable === path) return { status: 403, ok: false };
    let body;
    if (path === '/actions/workflows/ci.yml') body = { id: 8, path: '.github/workflows/ci.yml', state: 'active', ...options.workflow };
    else if (path === '/actions/runs/102') body = state.next;
    else if (path === '/actions/runs/101') body = state.old;
    else if (path === '/pulls/12') body = state.pr;
    else if (path === '/actions/runs/102/attempts/1/jobs') body = { total_count: state.nextJobs.length, jobs: state.nextJobs };
    else if (path === '/actions/runs/101/attempts/1/jobs') body = { total_count: state.jobs.length, jobs: state.jobs, ...options.jobListing };
    else if (path === '/actions/workflows/8/runs') body = { total_count: 1, workflow_runs: [state.old], ...options.runListing };
    else throw new Error(`Unexpected request ${path}`);
    return { status: 200, ok: true, json: async () => structuredClone(body) };
  });
  const sleep = vi.fn(async (ms) => {
    clock += ms;
    options.duringWait?.(state, ms, { writes, advance: (elapsed) => { clock += elapsed; } });
  });
  return { state, writes, reads, execute: () => recoverSupersededGate({ env, fetchImpl, sleep, now: () => clock }), sleep };
}

describe('superseded aggregate recovery through the Actions API', () => {
  it('normally cancels first, waits, then force-cancels only the stale queued aggregate and reads back settlement', async () => {
    const fixture = api({ forceSettles: true });
    expect(await fixture.execute()).toEqual({ outcome: 'settled', reason: 'force-cancel-settled' });
    expect(fixture.writes).toEqual(['/actions/runs/101/cancel', '/actions/runs/101/force-cancel']);
    expect(fixture.sleep).toHaveBeenCalledWith(CANCEL_SETTLE_MS);
    expect(fixture.sleep).toHaveBeenCalledOnce();
    expect(fixture.reads.at(-1)).toBe('/actions/runs/101');
    expect(fixture.state.jobs[0].conclusion).toBe('failure');
    // A duplicate observer cannot cancel again or rewrite the genuine failure.
    expect((await fixture.execute()).outcome).toBe('held');
    expect(fixture.writes).toHaveLength(2);
  });

  const startDraining = (fixture) => {
    Object.assign(fixture.state.jobs[0], { status: 'in_progress', conclusion: null,
      steps: [{ status: 'in_progress', conclusion: null }] });
  };

  it('observes finishing non-gate work before qualifying the queued aggregate, without cancelling live jobs', async () => {
    const fixture = api({ forceSettles: true, duringWait: (state, ms, { writes }) => {
      if (ms !== DRAIN_POLL_INTERVAL_MS) return;
      expect(writes).toEqual([]);
      state.jobs[0] = jobs()[0];
    } });
    startDraining(fixture);
    expect(await fixture.execute()).toEqual({ outcome: 'settled', reason: 'force-cancel-settled' });
    expect(fixture.sleep.mock.calls.map(([ms]) => ms)).toEqual([DRAIN_POLL_INTERVAL_MS, CANCEL_SETTLE_MS]);
    expect(fixture.writes).toEqual(['/actions/runs/101/cancel', '/actions/runs/101/force-cancel']);
  });

  it('holds persistently live work at one total deadline without any write', async () => {
    const fixture = api();
    startDraining(fixture);
    expect(await fixture.execute()).toEqual({ outcome: 'held', reason: 'old-jobs-drain-timeout' });
    expect(fixture.sleep.mock.calls.reduce((total, [ms]) => total + ms, 0)).toBe(DRAIN_TIMEOUT_MS);
    expect(fixture.writes).toEqual([]);
  });

  it('includes time consumed during inspection in the drain deadline instead of resetting its budget', async () => {
    const fixture = api({ duringWait: (_state, _ms, { advance }) => advance(DRAIN_TIMEOUT_MS) });
    startDraining(fixture);
    expect(await fixture.execute()).toEqual({ outcome: 'held', reason: 'old-jobs-drain-timeout' });
    expect(fixture.sleep).toHaveBeenCalledOnce();
    expect(fixture.writes).toEqual([]);
  });

  it.each([
    ['current head changes', (s) => { s.pr.head.sha = 'c'.repeat(40); }],
    ['old attempt changes', (s) => { s.old.run_attempt = 2; }],
    ['old job data becomes incomplete', (s) => { s.jobs[0].steps = null; }],
  ])('stops read-only drain polling if %s', async (_name, duringWait) => {
    const fixture = api({ duringWait });
    startDraining(fixture);
    expect((await fixture.execute()).outcome).toBe('held');
    expect(fixture.sleep).toHaveBeenCalledOnce();
    expect(fixture.writes).toEqual([]);
  });

  it('observes the old run completing during drain without cancellation', async () => {
    const fixture = api({ duringWait: (s) => Object.assign(s.old, { status: 'completed', conclusion: 'cancelled' }) });
    startDraining(fixture);
    expect(await fixture.execute()).toEqual({ outcome: 'settled', reason: 'old-run-settled-during-drain' });
    expect(fixture.writes).toEqual([]);
  });

  it('does not force after normal cancellation settles', async () => {
    const fixture = api({ normalSettles: true });
    expect(await fixture.execute()).toEqual({ outcome: 'settled', reason: 'normal-cancel-settled' });
    expect(fixture.writes).toEqual(['/actions/runs/101/cancel']);
  });

  it.each([
    ['live tests', (s) => { s.jobs[0].status = 'in_progress'; }],
    ['live step despite inconsistent terminal job', (s) => { s.jobs[0].steps[0].status = 'in_progress'; }],
    ['missing non-gate inventory', (s) => { s.jobs.shift(); }],
    ['live cleanup step', (s) => { s.jobs.push({ id: 3, run_id: 101, name: 'Cleanup', status: 'in_progress' }); }],
    ['started gate', (s) => { s.jobs[1].started_at = '2026-01-01T00:00:00Z'; }],
    ['running gate', (s) => { s.jobs[1].status = 'in_progress'; }],
    ['unknown terminal result', (s) => { s.jobs[0].conclusion = null; }],
    ['same-head rerun', (s) => { s.old.head_sha = s.next.head_sha; }],
    ['different PR', (s) => { s.old.pull_requests = [{ number: 13 }]; }],
    ['different repository', (s) => { s.old.repository.id = 11; }],
    ['different workflow', (s) => { s.old.workflow_id = 9; }],
    ['foreign head repository', (s) => { s.old.head_repository.id = 11; }],
    ['current PR moved', (s) => { s.pr.head.sha = 'c'.repeat(40); }],
    ['successor has jobs', (s) => { s.nextJobs.push({ id: 4 }); }],
    ['rerun attempt changed', (s) => { s.old.run_attempt = 2; }],
  ])('refuses %s without a write', async (_name, change) => {
    const fixture = api();
    change(fixture.state);
    expect((await fixture.execute()).outcome).toBe('held');
    expect(fixture.writes).toEqual([]);
  });

  it.each([
    ['PR head moved', (s) => { s.pr.head.sha = 'c'.repeat(40); }],
    ['successor started', (s) => { s.next.status = 'in_progress'; }],
    ['old rerun started', (s) => { s.old.run_attempt = 2; }],
    ['gate started', (s) => { s.jobs[1].status = 'in_progress'; }],
    ['non-gate cleanup started', (s) => { s.jobs[0].status = 'in_progress'; }],
  ])('revalidates %s after normal cancellation before any escalation', async (_name, duringWait) => {
    const fixture = api({ duringWait });
    expect((await fixture.execute()).outcome).toBe('held');
    expect(fixture.writes).toEqual(['/actions/runs/101/cancel']);
  });

  it.each([
    { unreadable: '/pulls/12' },
    { jobListing: { total_count: 101 } },
    { runListing: { total_count: 2 } },
    { workflow: { path: '.github/workflows/other.yml' } },
  ])('fails closed on incomplete, inaccessible or mismatched API evidence: %j', async (options) => {
    const fixture = api(options);
    expect((await fixture.execute()).outcome).toBe('held');
    expect(fixture.writes).toEqual([]);
  });

  it.each([false, true])('reads back an uncertain normal write without escalation (settled=%s)', async (normalSettles) => {
    const fixture = api({ normalThrows: true, normalSettles });
    expect((await fixture.execute()).outcome).toBe(normalSettles ? 'settled' : 'uncertain');
    expect(fixture.writes).toEqual(['/actions/runs/101/cancel']);
    expect(fixture.reads).toContain('/actions/runs/101');
    expect(fixture.sleep).not.toHaveBeenCalled();
  });

  it.each([
    [false, false, 'uncertain'], [false, true, 'settled'], [true, false, 'pending'],
  ])('reports force acceptance separately from observed outcome (%s/%s)', async (accepted, forceSettles, outcome) => {
    const fixture = api({ forceThrows: !accepted, forceSettles });
    expect((await fixture.execute()).outcome).toBe(outcome);
    expect(fixture.writes).toHaveLength(2);
    expect(fixture.reads.at(-1)).toBe(forceSettles ? '/actions/runs/101' : '/actions/runs/101/attempts/1/jobs');
  });

  it('retains uncertainty when accepted force cancellation cannot be independently verified', async () => {
    const fixture = api({ afterForce: (state) => { state.old.run_attempt = 2; } });
    expect(await fixture.execute()).toEqual({ outcome: 'uncertain', reason: 'force-cancel-outcome-unverified' });
    expect(fixture.writes).toHaveLength(2);
  });

  it('keeps requested recovery on trusted default-branch code outside the CI group, with existing permissions', () => {
    const workflow = readFileSync(new URL('../.github/workflows/ci-cancel-recovery.yml', import.meta.url), 'utf8');
    const job = workflow.slice(workflow.indexOf('  superseded-gate:'));
    expect(workflow).toContain('types: [requested, completed]');
    expect(job).toContain("github.event.action == 'requested'");
    expect(job).toContain('actions: write');
    expect(job).not.toMatch(/pull-requests:|checks:|ref:|pull_request_target/);
    expect(job).toContain('group: ci-superseded-gate-');
    expect(job).toContain('persist-credentials: false');
    const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
    expect(ci).toMatch(/name: CI Gate\s+if: always\(\)/);
  });
});
