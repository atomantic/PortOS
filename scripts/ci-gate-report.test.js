/**
 * The gate's job is to say WHY the run is not mergeable. Before issue 7437 it
 * said "did not pass" for a cancel and for a red suite alike, so these tests
 * are about the distinction, not about the exit code: both still block.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it, vi } from 'vitest';

import { collectGateResults, reportGate, summarizeGateResults } from './ci-gate-report.js';
import { workflowJobs } from './lib/workflowJobs.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');

const results = (pairs) => Object.entries(pairs).map(([job, result]) => ({ job, result }));

describe('collectGateResults', () => {
  it('reads only the prefixed variables and restores hyphenated job ids', () => {
    expect(collectGateResults({
      CI_GATE_RESULT_SERVER: 'success',
      CI_GATE_RESULT_WINDOWS_SERVER: 'cancelled',
      CI_GATE_LABEL: 'CI Gate',
      PATH: '/usr/bin',
    })).toEqual([
      { job: 'server', result: 'success' },
      { job: 'windows-server', result: 'cancelled' },
    ]);
  });

  it('names an unset result rather than dropping the job', () => {
    // `needs.<job>.result` arrives empty when a job never reported. Dropping it
    // would let the gate pass on a silently missing job.
    expect(collectGateResults({ CI_GATE_RESULT_DATABASE: '  ' }))
      .toEqual([{ job: 'database', result: 'unknown' }]);
  });
});

describe('summarizeGateResults', () => {
  it('passes when every job succeeded or was skipped', () => {
    const summary = summarizeGateResults(results({ server: 'success', database: 'skipped' }));
    expect(summary.verdict).toBe('pass');
    expect(summary.lines.join('\n')).toContain('server=success');
  });

  it('reports a cancel with no failure as CANCELLED and names the cancelled jobs', () => {
    const summary = summarizeGateResults(results({
      impact: 'success',
      server: 'cancelled',
      client: 'cancelled',
      database: 'success',
      'windows-server': 'cancelled',
    }));

    expect(summary.verdict).toBe('cancelled');
    const text = summary.lines.join('\n');
    expect(text).toContain('CANCELLED, not failed');
    expect(text).toContain('no job REPORTED a failure');
    // The gate reads job CONCLUSIONS, and a fail-fast run hides a real
    // failure behind the same conclusions (#7482, #7571). The summary must
    // therefore send the reader to the logs, never imply the tree is green.
    expect(text).toContain('READ THE JOB LOGS FIRST');
    expect(text).toContain('does NOT mean no test failed');
    expect(text).not.toMatch(/\bNo test failed\b/);
    expect(text).toContain('could NOT be read');
    expect(summary.lines).toContain('Cancelled jobs: server, client, windows-server');
    expect(summary.lines).toContain('Jobs that finished: impact=success, database=success');
    // The reader needs somewhere to go next, and the doc is the only place the
    // external-vs-supersession distinction is written down.
    expect(text).toContain('docs/TROUBLESHOOTING.md');
  });

  it('reports a real failure as a failure even when cancelled siblings outnumber it', () => {
    // The repo cancels its own siblings from a failing job, so this shape is
    // the NORMAL red run — calling it "cancelled" would be the worse mistake.
    const summary = summarizeGateResults(results({
      server: 'failure',
      client: 'cancelled',
      'windows-server': 'cancelled',
    }));

    expect(summary.verdict).toBe('failure');
    expect(summary.lines).toContain('Failed jobs: server=failure');
    expect(summary.lines.join('\n')).not.toContain('CANCELLED, not failed');
    expect(summary.lines.join('\n')).toContain('client, windows-server');
  });

  it('treats an unrecognised result as a failure, not as collateral of a cancel', () => {
    const summary = summarizeGateResults(results({ server: 'unknown', client: 'cancelled' }));
    expect(summary.verdict).toBe('failure');
    expect(summary.lines).toContain('Failed jobs: server=unknown');
  });

  it('accepts a skipped job by default, but never under requireSuccess', () => {
    // A per-job `skipped` is the impact plan working as designed, so the
    // aggregate gate passes on it. `Full CI Gate` must not: a release skips
    // the complete suite on the strength of that check.
    expect(summarizeGateResults(results({ gate: 'skipped' })).verdict).toBe('pass');

    const strict = summarizeGateResults(results({ gate: 'skipped' }), 'Full CI Gate', { requireSuccess: true });
    expect(strict.verdict).toBe('failure');
    expect(strict.lines).toContain('Failed jobs: gate=skipped');
  });

  it('fails when no job results were supplied at all', () => {
    // A green required check that examined nothing is indistinguishable from
    // a real pass, so an empty set must fail rather than pass vacuously.
    const summary = summarizeGateResults([]);
    expect(summary.verdict).toBe('failure');
    expect(summary.lines.join('\n')).toContain('nothing was checked');
  });

  it('uses the supplied gate label so the two gates are distinguishable', () => {
    const summary = summarizeGateResults(results({ gate: 'cancelled' }), 'Full CI Gate');
    expect(summary.lines[0]).toContain('Full CI Gate');
  });

  it('stops sending the reader to the logs once the steps have been cleared', () => {
    // The paragraph above is the guard against the #7482 / #7571 misdiagnosis,
    // and it is still right when NOTHING checked the steps. Once the lookup HAS
    // run and found none, repeating it would send every genuine external cancel
    // hunting for a failure that really is absent — so the two states differ,
    // and neither may imply the tree is green.
    const summary = summarizeGateResults(results({ server: 'cancelled' }), 'CI Gate', { culprits: [] });

    expect(summary.verdict).toBe('cancelled');
    const text = summary.lines.join('\n');
    expect(text).toContain("Checked every job's STEP conclusions too, and none failed");
    expect(text).not.toContain('READ THE JOB LOGS FIRST');
    expect(text).not.toMatch(/\bNo test failed\b/);
  });

  it('names the culprit instead of reporting a cancel when a job has a failed step', () => {
    // The shape of every fail-fast run (7574): the failing job's own conclusion
    // is `cancelled` because the cancel beat GitHub to writing it, so this is
    // the ONLY input that can tell the reader a test actually failed.
    const summary = summarizeGateResults(
      results({ impact: 'success', server: 'cancelled', 'windows-server': 'cancelled' }),
      'CI Gate',
      { culprits: [{ name: 'Windows server unit tests (3/3)', steps: ['Run server tests on Windows'] }] },
    );

    expect(summary.verdict).toBe('failure');
    const text = summary.lines.join('\n');
    expect(text).not.toContain('CANCELLED, not failed');
    expect(summary.lines).toContain(
      'Failing job: Windows server unit tests (3/3) — failed step: Run server tests on Windows',
    );
    // The cancelled siblings still get named, as collateral rather than cause.
    expect(summary.lines).toContain('Cancelled jobs: server, windows-server');
    expect(text).toContain('--log-failed');
  });

  it('keeps the cancelled verdict when the lookup could not run at all', () => {
    // A genuine external cancel, or a lookup that failed. Either way it must
    // stay `cancelled`, so the run still earns its one automatic retry from
    // ci-cancel-recovery.yml.
    const summary = summarizeGateResults(results({ server: 'cancelled' }), 'CI Gate', { culprits: null });
    expect(summary.verdict).toBe('cancelled');
    expect(summary.lines.join('\n')).toContain('CANCELLED, not failed');
  });
});

describe('reportGate', () => {
  const capture = () => {
    const logged = [];
    const errored = [];
    const summaries = [];
    return {
      logged,
      errored,
      summaries,
      logger: { log: (l) => logged.push(l), error: (l) => errored.push(l) },
      writeSummary: (markdown) => summaries.push(markdown),
    };
  };

  it('turns CI_GATE_REQUIRE_SUCCESS on for the strict gate', async () => {
    const { ...sinks } = capture();
    await expect(reportGate({
      env: { CI_GATE_RESULT_GATE: 'skipped', CI_GATE_REQUIRE_SUCCESS: 'true' }, ...sinks,
    })).resolves.toMatchObject({ verdict: 'failure', ok: false });
    await expect(reportGate({ env: { CI_GATE_RESULT_GATE: 'skipped' }, ...sinks }))
      .resolves.toMatchObject({ verdict: 'pass', ok: true });
  });

  it('writes a pass to stdout and reports ok', async () => {
    const { logged, errored, ...sinks } = capture();
    const outcome = await reportGate({ env: { CI_GATE_RESULT_SERVER: 'success' }, ...sinks });

    expect(outcome).toMatchObject({ verdict: 'pass', ok: true });
    expect(logged.join('\n')).toContain('CI Gate passed');
    expect(errored).toEqual([]);
  });

  it('writes a cancel to stderr AND to the run summary, and still blocks', async () => {
    // Nobody expands a step log before concluding "CI is red", so the summary
    // page carries the same verdict.
    const { logged, errored, summaries, ...sinks } = capture();
    const outcome = await reportGate({
      env: { CI_GATE_RESULT_SERVER: 'cancelled' },
      logger: sinks.logger,
      writeSummary: sinks.writeSummary,
    });

    expect(outcome).toMatchObject({ verdict: 'cancelled', ok: false });
    expect(errored.join('\n')).toContain('CANCELLED');
    expect(logged).toEqual([]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain('CI Gate');
    expect(summaries[0]).toContain('CANCELLED, not failed');
  });
});

describe('reportGate culprit lookup', () => {
  const API_ENV = {
    GITHUB_REPOSITORY: 'example/portos',
    GITHUB_RUN_ID: '123456789',
    GITHUB_TOKEN: 'ephemeral-test-token',
    CI_GATE_RESULT_SERVER: 'cancelled',
    CI_GATE_RESULT_WINDOWS_SERVER: 'cancelled',
  };
  const jobsResponse = (jobs) => ({ ok: true, status: 200, json: async () => ({ jobs }) });
  const run = (options) => {
    const errored = [];
    const summaries = [];
    return reportGate({
      env: API_ENV,
      logger: { log: () => {}, error: (line) => errored.push(line) },
      writeSummary: (markdown) => summaries.push(markdown),
      ...options,
    }).then((outcome) => ({ outcome, errored, summaries }));
  };

  it('reports a failure naming the job and step behind a cancelled run', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jobsResponse([
      { name: 'Server tests (1/2)', conclusion: 'cancelled', steps: [{ name: 'Run server tests', conclusion: 'cancelled' }] },
      {
        name: 'Windows server unit tests (3/3)',
        conclusion: 'cancelled',
        steps: [
          { name: 'Checkout', conclusion: 'success' },
          { name: 'Run server tests on Windows', conclusion: 'failure' },
        ],
      },
    ]));

    const { outcome, errored } = await run({ fetchImpl });

    expect(outcome).toMatchObject({ verdict: 'failure', ok: false });
    expect(errored.join('\n')).toContain('Windows server unit tests (3/3) — failed step: Run server tests on Windows');
    // The gate reads THIS run, not one a workflow input could point it at.
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.github.com/repos/example/portos/actions/runs/123456789/jobs?per_page=100',
      expect.any(Object),
    );
  });

  it("ignores the gate jobs' own failed steps", async () => {
    // Both gates fail downstream of any red run, so naming one would send the
    // reader back to the check they are already looking at.
    const fetchImpl = vi.fn().mockResolvedValue(jobsResponse([
      { name: 'CI Gate', conclusion: 'failure', steps: [{ name: 'Require every selected job to pass', conclusion: 'failure' }] },
      { name: 'Full CI Gate', conclusion: 'failure', steps: [{ name: 'Require the aggregate gate to have passed', conclusion: 'failure' }] },
    ]));

    const { outcome, errored } = await run({ fetchImpl });

    expect(outcome).toMatchObject({ verdict: 'cancelled', ok: false });
    expect(errored.join('\n')).toContain('CANCELLED, not failed');
  });

  it('falls back to the cancelled wording when the API is unavailable', async () => {
    // A network blip must never flip a cancelled run red — the run still needs
    // its one automatic retry from ci-cancel-recovery.yml. The lookup's own
    // failure modes are pinned in lib/githubActionsApi.test.js; this is the
    // gate's side of that contract.
    const { outcome, errored } = await run({ fetchImpl: vi.fn().mockRejectedValue(new Error('network unavailable')) });
    expect(outcome).toMatchObject({ verdict: 'cancelled', ok: false });
    expect(errored.join('\n')).toContain('CANCELLED, not failed');
  });

  it('does not query the API for a verdict that already names its cause', async () => {
    const fetchImpl = vi.fn();
    await run({ env: { ...API_ENV, CI_GATE_RESULT_SERVER: 'success', CI_GATE_RESULT_WINDOWS_SERVER: 'success' }, fetchImpl });
    await run({ env: { ...API_ENV, CI_GATE_RESULT_SERVER: 'failure' }, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('ci.yml gate wiring', () => {
  const jobs = workflowJobs(WORKFLOW);

  it.each(['gate', 'full-gate'])('%s runs the reporter instead of an inline script', (id) => {
    expect(jobs[id]).toContain('run: node scripts/ci-gate-report.js');
    expect(jobs[id]).toMatch(/CI_GATE_LABEL:/);
    // Reachable only with a checkout, and the gate has no elevated-token work.
    expect(jobs[id]).toContain('persist-credentials: false');
    // The reporter and its two imports all live under scripts/; a full-tree
    // checkout on the fan-in job every required check waits on is ~12x the
    // download for nothing.
    expect(jobs[id]).toContain('sparse-checkout: scripts');
  });

  it.each(['gate', 'full-gate'])('gives %s the read-only grant its culprit lookup needs', (id) => {
    // Without the token the reporter silently falls back to the cancelled
    // wording, which is exactly the misleading verdict this lookup replaced.
    expect(jobs[id]).toContain('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
    expect(jobs[id]).toMatch(/\n    permissions:\n      contents: read\n      actions: read\n/);
    // Listing jobs is a read. Cancelling stays a leaf-job privilege.
    expect(jobs[id]).not.toContain('actions: write');
  });

  it('excludes exactly the gate job names the reporter filters out', () => {
    // The reporter drops these two by NAME, so a renamed gate would start
    // reporting itself as the culprit behind every cancelled run.
    expect(jobs.gate).toContain('name: CI Gate');
    expect(jobs['full-gate']).toContain('name: Full CI Gate');
  });

  it('runs the full gate in strict mode and the aggregate gate not', () => {
    expect(jobs['full-gate']).toContain("CI_GATE_REQUIRE_SUCCESS: 'true'");
    expect(jobs.gate).not.toContain('CI_GATE_REQUIRE_SUCCESS');
  });

  it('feeds the aggregate gate every job it waits on', () => {
    // A job added to `needs:` without its CI_GATE_RESULT_ line would be waited
    // for and then never checked — the silent hole this asserts away.
    const needs = jobs.gate.match(/needs: \[([^\]]+)\]/)[1]
      .split(',')
      .map((name) => name.trim());
    expect(needs).toContain('windows-server');
    for (const name of needs) {
      expect(jobs.gate, name).toContain(`CI_GATE_RESULT_${name.toUpperCase().replace(/-/g, '_')}:`);
    }
  });
});
