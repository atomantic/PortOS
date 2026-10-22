import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { requireDependabotAdmission } from './ci-dependabot-admission.js';
import { workflowJobs } from './lib/workflowJobs.js';
import { summarizeGateResults } from './ci-gate-report.js';

const held = {
  eventName: 'pull_request',
  event: { pull_request: { user: { login: 'dependabot[bot]' } } },
  attempt: '1',
  triggeringActor: 'dependabot[bot]',
};
const workflow = (name) => readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8');

describe('Dependabot maintainer release', () => {
  it('holds opened, synchronized and rebased updates even when a writer pushed the change', () => {
    for (const action of ['opened', 'synchronize', 'reopened']) {
      expect(() => requireDependabotAdmission({ ...held, triggeringActor: 'maintainer', event: { ...held.event, action } }))
        .toThrow('Dependabot CI is held');
    }
  });

  it('admits writer-triggered reruns of the same run, but never automatic bot recovery', () => {
    expect(() => requireDependabotAdmission({ ...held, attempt: '2', triggeringActor: 'maintainer' })).not.toThrow();
    for (const triggeringActor of ['github-actions[bot]', 'dependabot[bot]', 'some-app[bot]', '', undefined]) {
      expect(() => requireDependabotAdmission({ ...held, attempt: '2', triggeringActor })).toThrow('held');
    }
    // A new head creates a new run, not another attempt of the approved run.
    expect(() => requireDependabotAdmission({ ...held, attempt: '1', triggeringActor: 'maintainer' })).toThrow('held');
  });

  it('preserves ordinary PRs and explicit dispatch, schedule and release behavior', () => {
    expect(() => requireDependabotAdmission({ ...held, event: { pull_request: { user: { login: 'contributor' } } } })).not.toThrow();
    for (const eventName of ['workflow_dispatch', 'schedule', 'push']) {
      expect(() => requireDependabotAdmission({ eventName })).not.toThrow();
    }
    expect(() => requireDependabotAdmission({ ...held, event: {} })).toThrow('Missing pull request author');
  });

  it('runs admission before planning/installing and keeps the required gate red on refusal', () => {
    const ci = workflowJobs(workflow('ci'));
    expect(ci.impact.indexOf('node scripts/ci-dependabot-admission.js'))
      .toBeLessThan(ci.impact.indexOf('node scripts/ci-base-sha.js'));
    expect(ci.impact).not.toContain('continue-on-error: true');
    for (const name of ['prompt-history', 'server', 'client', 'lint', 'database', 'browser', 'windows-server', 'node-minimum', 'linux-containment', 'docker-containment-live', 'supercollider-live']) {
      expect(ci[name]).toContain('needs: impact');
    }
    expect(ci.gate).toContain('if: always()');
    expect(ci.gate).toContain('CI_GATE_RESULT_IMPACT: ${{ needs.impact.result }}');
    expect(summarizeGateResults([{ job: 'impact', result: 'failure' }, { job: 'client', result: 'skipped' }]).verdict).toBe('failure');
    const native = ci['supercollider-live'];
    expect(native.indexOf('node scripts/ci-dependabot-admission.js')).toBeGreaterThan(-1);
    expect(native.indexOf('node scripts/ci-dependabot-admission.js')).toBeLessThan(native.indexOf('actions/setup-node@'));
    // The Docker containment live suite installs from the public registry inside its container.
    const contained = ci['docker-containment-live'];
    expect(contained.indexOf('node scripts/ci-dependabot-admission.js')).toBeGreaterThan(-1);
    expect(contained.indexOf('node scripts/ci-dependabot-admission.js')).toBeLessThan(contained.indexOf('actions/setup-node@'));
    expect(workflow('ci')).not.toContain('pull_request_target:');
    expect(workflow('ci')).not.toMatch(/(?:contents|actions): write/);
    expect(ci.gate).toContain('supercollider-live]');
    expect(ci.gate).toContain('CI_GATE_RESULT_SUPERCOLLIDER_LIVE: ${{ needs.supercollider-live.result }}');
  });
});
