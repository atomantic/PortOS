import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
const NON_LEAF_JOBS = new Set(['impact', 'gate', 'full-gate']);
const FAIL_FAST_STEP = [
  '      - name: Cancel sibling CI jobs after failure',
  "        if: failure() && github.event_name == 'pull_request'",
  '        env:',
  '          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
  '        run: node scripts/cancel-current-ci-run.js',
].join('\n');

function workflowJobs(yaml) {
  const jobsStart = yaml.indexOf('\njobs:\n');
  const body = yaml.slice(jobsStart);
  const jobs = {};
  let current = null;
  for (const line of body.split('\n')) {
    const header = line.match(/^ {2}([a-z][a-z0-9-]*):\s*$/);
    if (header) {
      current = header[1];
      jobs[current] = [];
      continue;
    }
    if (current) jobs[current].push(line);
  }
  return Object.fromEntries(Object.entries(jobs).map(([id, lines]) => [id, lines.join('\n')]));
}

describe('ci.yml fail-fast cancellation contract', () => {
  const jobs = workflowJobs(WORKFLOW);
  const leafJobs = Object.keys(jobs).filter((id) => (
    !NON_LEAF_JOBS.has(id) && /^\s*needs:\s*impact\s*$/m.test(jobs[id])
  ));

  it('discovers every direct impact leaf job for contract checks', () => {
    expect(leafJobs).not.toHaveLength(0);
  });

  it('adds the cancellation step as the final step of every expensive leaf job', () => {
    for (const id of leafJobs) {
      const body = jobs[id];
      expect(body, id).toBeTruthy();
      const step = body.slice(body.lastIndexOf('      - name: Cancel sibling CI jobs after failure')).trimEnd();
      expect(step, id).toBe(FAIL_FAST_STEP);
      expect(body.match(/GITHUB_TOKEN:/g), id).toHaveLength(1);
    }
  });

  it('grants only the leaf jobs the minimum cancellation permissions', () => {
    for (const id of leafJobs) {
      const body = jobs[id];
      expect(body, id).toMatch(/\n    permissions:\n      contents: read\n      actions: write\n/);
    }
    for (const id of NON_LEAF_JOBS) {
      expect(jobs[id], id).not.toContain('actions: write');
    }
  });

  it('does not pass arbitrary repository or run targets to the helper', () => {
    for (const id of leafJobs) {
      const body = jobs[id];
      expect(body, id).not.toMatch(/GITHUB_(?:REPOSITORY|RUN_ID):/);
      const step = body.slice(body.lastIndexOf('      - name: Cancel sibling CI jobs after failure'));
      expect(step, id).not.toContain('\n        with:');
      expect(body, id).toContain('if: failure()');
    }
  });

  it('does not persist the elevated checkout token into leaf job steps', () => {
    for (const id of leafJobs) {
      const body = jobs[id];
      const checkoutStart = body.indexOf('      - uses: actions/checkout@v7');
      const nextStep = body.indexOf('\n      - ', checkoutStart + 1);
      const checkout = body.slice(checkoutStart, nextStep === -1 ? undefined : nextStep);
      expect(checkout, id).toContain('persist-credentials: false');
    }
  });

  it('grants the reusable release caller the permission leaf jobs require', () => {
    const releaseWorkflow = readFileSync(join(REPO_ROOT, '.github/workflows/release.yml'), 'utf8');
    const fullCi = releaseWorkflow.slice(releaseWorkflow.indexOf('\n  full-ci:'));
    expect(fullCi).toMatch(/\n    permissions:\n      contents: read\n      actions: write\n/);
  });
});
