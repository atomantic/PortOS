import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FULL_SUITE_SHARDS } from './ci-test-plan.js';
import { workflowJobs } from './lib/workflowJobs.js';

const jobs = workflowJobs(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
const step = (job, name) => job.split(`- name: ${name}\n`)[1].split('\n      - name:')[0];
const expand = (template, context) => template.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, key) => {
  if (!(key in context)) throw new Error(`Unknown cache input: ${key}`);
  return context[key];
});

describe('trusted CI test-memo cache reuse', () => {
  // A scoped 1of1 job used to request a lineage no trusted full run ever saved.
  it.each([
    ['server', 'server', 'Linux'],
    ['client', 'client', 'Linux'],
    ['windows-server', 'windows', 'Windows'],
  ])('%s can restore a full-run shard without crossing runtime or job families', (jobId, family, os) => {
    const restore = step(jobs[jobId], 'Restore the test memo');
    const save = step(jobs[jobId], 'Save the test memo');
    const key = save.match(/^ +key: (.+)$/m)[1];
    const prefixes = restore.match(/restore-keys: \|\n((?: +test-memo-[^\n]+\n?)+)/)[1].trim().split('\n').map(line => line.trim());
    const context = {
      'runner.os': os, 'runner.arch': 'X64', 'matrix.shard': 1,
      'strategy.job-total': 1, 'github.run_id': 123,
    };
    const seeded = Array.from({ length: FULL_SUITE_SHARDS[family] }, (_, index) => expand(key, {
      ...context, 'matrix.shard': index + 1, 'strategy.job-total': FULL_SUITE_SHARDS[family],
    }));
    const restoreFrom = (available, ctx = context) => prefixes
      .map(prefix => available.find(candidate => candidate.startsWith(expand(prefix, ctx))))
      .find(Boolean);

    expect(restoreFrom(seeded)).toBeTruthy();
    // Prefer the matching partition when one exists, even if another shard is newer.
    const exact = expand(key, context);
    expect(restoreFrom([...seeded, exact])).toBe(exact);
    expect(restoreFrom(seeded, { ...context, 'runner.arch': 'ARM64' })).toBeUndefined();
    expect(restoreFrom(seeded, { ...context, 'runner.os': 'OtherOS' })).toBeUndefined();
    const foreign = seeded.map(value => value.replace(`-${jobId}-`, '-other-job-'));
    expect(restoreFrom(foreign)).toBeUndefined();
    expect(save).toContain("github.event_name != 'pull_request'");
  });
});
