/**
 * The gate's job is to say WHY the run is not mergeable. Before #7437 it said
 * "did not pass" for a cancel and for a red suite alike, so these tests are
 * about the distinction, not about the exit code: both still block.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it } from 'vitest';

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
    expect(summary.cancelled).toEqual(['server', 'client', 'windows-server']);
    const text = summary.lines.join('\n');
    expect(text).toContain('CANCELLED, not failed');
    expect(text).toContain('no job reported a failure');
    expect(text).toContain('Cancelled jobs: server, client, windows-server');
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
    expect(summary.failed).toEqual(['server=failure']);
    const text = summary.lines.join('\n');
    expect(text).toContain('Failed jobs: server=failure');
    expect(text).not.toContain('CANCELLED, not failed');
    expect(text).toContain('client, windows-server');
  });

  it('treats an unrecognised result as a failure, not as collateral of a cancel', () => {
    const summary = summarizeGateResults(results({ server: 'unknown', client: 'cancelled' }));
    expect(summary.verdict).toBe('failure');
    expect(summary.failed).toEqual(['server=unknown']);
  });

  it('uses the supplied gate label so the two gates are distinguishable', () => {
    const summary = summarizeGateResults(results({ gate: 'cancelled' }), 'Full CI Gate');
    expect(summary.lines[0]).toContain('Full CI Gate');
  });
});

describe('reportGate', () => {
  const silentLogger = { log: () => {}, error: () => {} };
  const capture = () => {
    const logged = [];
    const errored = [];
    return { logged, errored, logger: { log: (l) => logged.push(l), error: (l) => errored.push(l) } };
  };

  it('writes a pass to stdout and reports ok', () => {
    const { logged, errored, logger } = capture();
    const outcome = reportGate({ env: { CI_GATE_RESULT_SERVER: 'success' }, logger, writeSummary: () => {} });

    expect(outcome).toMatchObject({ verdict: 'pass', ok: true });
    expect(logged.join('\n')).toContain('CI Gate passed');
    expect(errored).toEqual([]);
  });

  it('publishes the verdict to the run summary, not only the step log', () => {
    // Nobody expands a step log before concluding "CI is red"; the summary page
    // is where the cancelled-vs-failed distinction actually gets read.
    const written = [];
    reportGate({
      env: { CI_GATE_RESULT_SERVER: 'cancelled' },
      logger: silentLogger,
      writeSummary: (markdown) => written.push(markdown),
    });

    expect(written).toHaveLength(1);
    expect(written[0]).toContain('CI Gate');
    expect(written[0]).toContain('CANCELLED, not failed');
  });

  it('writes a cancel to stderr and still blocks', () => {
    const { logged, errored, logger } = capture();
    const outcome = reportGate({ env: { CI_GATE_RESULT_SERVER: 'cancelled' }, logger, writeSummary: () => {} });

    expect(outcome).toMatchObject({ verdict: 'cancelled', ok: false });
    expect(errored.join('\n')).toContain('CANCELLED');
    expect(logged).toEqual([]);
  });
});

describe('ci.yml gate wiring', () => {
  const jobs = workflowJobs(WORKFLOW);

  it.each(['gate', 'full-gate'])('%s runs the reporter instead of an inline script', (id) => {
    expect(jobs[id]).toContain('run: node scripts/ci-gate-report.js');
    // The inline `node -e` the reporter replaced could not be tested at all.
    expect(jobs[id]).not.toMatch(/node -e/);
    expect(jobs[id]).toMatch(/CI_GATE_LABEL:/);
    // Reachable only with a checkout, and the gate has no elevated-token work.
    expect(jobs[id]).toContain('persist-credentials: false');
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
