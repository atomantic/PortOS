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
