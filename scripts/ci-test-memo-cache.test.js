import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FULL_SUITE_SHARDS } from './ci-test-plan.js';
import { readCiJobs } from './lib/ciWorkflowJobs.js';

// The key lineage lives once, in the test-memo action; expanding it with each
// job's `suite`/`partition` inputs gives the keys that job actually uses.
const jobs = readCiJobs();
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
    const restore = step(jobs[jobId], 'Restore from the trusted memo cache');
    const save = step(jobs[jobId], 'Save the test memo');
    // The save reuses the restore's primary key rather than restating it.
    expect(save).toContain('key: ${{ steps.test-memo.outputs.key }}');
    const key = restore.match(/^ +key: (.+)$/m)[1];
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

  // Related selection narrows a test only through its own memo record
  // (#16424), and a full-run shard records only its slice, so the server
  // jobs must restore and merge every full-run shard lineage.
  it('merges every full-run server shard lineage into the restored memo', () => {
    const job = jobs.server;
    const ciYml = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
    expect(ciYml).toMatch(new RegExp(`suite: server\\n\\s+partition: server-[^\\n]+\\n(?:\\s+#[^\\n]*\\n)*\\s+merge-shards: ${FULL_SUITE_SHARDS.server}\\n`));
    const context = { 'runner.os': 'Linux', 'runner.arch': 'X64', 'github.run_id': 123 };
    const restoreKey = step(job, 'Restore from the trusted memo cache').match(/^ +key: (.+)$/m)[1];
    for (let shard = 1; shard <= FULL_SUITE_SHARDS.server; shard += 1) {
      const restore = step(job, `Restore full-run shard ${shard} of the memo`);
      expect(restore).toContain(`if: fromJSON(inputs.merge-shards) >= ${shard}`);
      expect(restore).toContain(`path: ${'${{ runner.temp }}'}/portos-test-memo-shards/${shard}`);
      // The prefix finds exactly the key that full-run shard saves, and no other shard's.
      const saved = (index) => expand(restoreKey, { ...context, 'matrix.shard': index, 'strategy.job-total': FULL_SUITE_SHARDS.server });
      const prefix = expand(restore.match(/^ +key: (.+)$/m)[1], context);
      expect(saved(shard).startsWith(prefix)).toBe(true);
      for (let other = 1; other <= FULL_SUITE_SHARDS.server; other += 1) if (other !== shard) expect(saved(other).startsWith(prefix)).toBe(false);
    }
    expect(step(job, 'Merge the full-run shard lineages')).toContain('node scripts/merge-test-memo.js "$RUNNER_TEMP/portos-test-memo" "$RUNNER_TEMP"/portos-test-memo-shards/*');
  });
});
