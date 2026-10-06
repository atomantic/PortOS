import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { workflowJobs } from './lib/workflowJobs.js';

// A hung Vitest worker or child process otherwise holds a runner for GitHub's
// 360-minute default and stalls the required gate jobs behind it.
describe.each(['ci.yml', 'release.yml'])('%s job timeouts', (file) => {
  const jobs = workflowJobs(readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8'));

  it('gives every non-reusable job an integer timeout-minutes', () => {
    const missing = Object.entries(jobs)
      // GitHub rejects timeout-minutes on a job that only calls a reusable workflow.
      .filter(([, body]) => !/^ {4}uses:/m.test(body))
      .filter(([, body]) => !/^ {4}timeout-minutes:\s*[1-9]\d*\s*$/m.test(body))
      .map(([id]) => id);
    expect(missing).toEqual([]);
  });
});

// A step-level timeout fails the step and keeps its log; only the job-level
// timeout cancels the job and loses it (#10415).
describe('ci.yml Windows server test step', () => {
  const body = workflowJobs(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  const text = Object.values(body).find((b) => b.includes('name: Run server tests on Windows'));

  it('has its own timeout-minutes below the job timeout', () => {
    const step = text.split('- name: Run server tests on Windows')[1].split(/\n {6}- name:/)[0];
    const stepMin = Number(/^ {8}timeout-minutes:\s*(\d+)\s*$/m.exec(step)?.[1]);
    const jobMin = Number(/^ {4}timeout-minutes:\s*(\d+)\s*$/m.exec(text)?.[1]);
    expect(stepMin).toBeGreaterThan(0);
    expect(stepMin).toBeLessThan(jobMin);
  });
});
