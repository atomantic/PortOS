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

const restoreKey = restore => restore.match(/^ +key: (.+)$/m)[1];
const restorePrefixes = restore => restore.match(/restore-keys: \|\n((?: +test-memo-[^\n]+\n?)+)/)[1]
  .trim().split('\n').map(line => line.trim());
const restoreFrom = (restore, available, context) => {
  const key = expand(restoreKey(restore), context);
  if (available.includes(key)) return key;
  return restorePrefixes(restore)
    .map(prefix => available.find(candidate => candidate.startsWith(expand(prefix, context))))
    .find(Boolean);
};
const memoPath = stepText => stepText.match(/^ +path: (.+)$/m)[1];
const ciYml = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

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
    const key = restoreKey(restore);
    const context = {
      'runner.os': os, 'runner.arch': 'X64', 'matrix.shard': 1,
      'strategy.job-total': 1, 'github.run_id': 123,
    };
    const seeded = Array.from({ length: FULL_SUITE_SHARDS[family] }, (_, index) => expand(key, {
      ...context, 'matrix.shard': index + 1, 'strategy.job-total': FULL_SUITE_SHARDS[family],
    }));

    expect(restoreFrom(restore, seeded, context)).toBeTruthy();
    // Prefer the matching partition when one exists, even if another shard is newer.
    const exact = expand(key, context);
    expect(restoreFrom(restore, [...seeded, exact], context)).toBe(exact);
    expect(restoreFrom(restore, seeded, { ...context, 'runner.arch': 'ARM64' })).toBeUndefined();
    expect(restoreFrom(restore, seeded, { ...context, 'runner.os': 'OtherOS' })).toBeUndefined();
    const foreign = seeded.map(value => value.replace(`-${jobId}-`, '-other-job-'));
    expect(restoreFrom(restore, foreign, context)).toBeUndefined();
    expect(save).toContain("github.event_name != 'pull_request'");
  });

  // Related selection needs the memo records from each distinct full-run shard.
  it.each(['server', 'client'])('restores and merges each full-run %s shard lineage once', (family) => {
    const count = FULL_SUITE_SHARDS[family];
    // The expanded job inlines the merge-shards expression; scoped plans (any
    // mode but 'full') evaluate it to the shard count, which is the
    // configuration these assertions model.
    const mergeExpression = `fromJSON(needs.impact.outputs.plan).${family}_mode == 'full' && '0' || '${count}'`;
    expect(jobs[family]).toContain(mergeExpression);
    const job = jobs[family].replaceAll(`\${{ ${mergeExpression} }}`, String(count));
    const save = step(job, 'Save the test memo');
    expect(ciYml).toMatch(new RegExp(`suite: ${family}\\n\\s+partition: ${family}-[^\\n]+\\n(?:\\s+#[^\\n]*\\n)*\\s+merge-shards: \\$\\{\\{ fromJSON\\(needs\\.impact\\.outputs\\.plan\\)\\.${family}_mode == 'full' && '0' \\|\\| '${count}' \\}\\}\\n`));
    // Full sharded runs restore only their own lineage; scoped plans keep the merge.
    expect(ciYml).not.toMatch(/merge-shards: [23]\n/);
    const initial = step(job, 'Restore from the trusted memo cache');
    const context = { 'runner.os': 'Linux', 'runner.arch': 'X64', 'github.run_id': 123 };
    const fullKeys = Array.from({ length: count }, (_, index) => expand(restoreKey(initial), {
      ...context, 'matrix.shard': index + 1, 'strategy.job-total': count,
    }));
    const scopedContext = { ...context, 'matrix.shard': 1, 'strategy.job-total': 1 };
    const scopedKey = expand(restoreKey(initial), scopedContext);

    const prefixes = fullKeys.map((_, index) => {
      const shard = index + 1;
      const restore = step(job, `Restore full-run shard ${shard} of the memo`);
      expect(restore).toContain(`id: restore-shard-${shard}`);
      const [, minimum, template] = restore.match(/^ +if: >-\n +fromJSON\(inputs\.merge-shards\) >= (\d) &&\n +!startsWith\(steps\.restore\.outputs\.cache-matched-key, format\('([^']+)', runner\.os, runner\.arch, inputs\.suite, inputs\.merge-shards\)\)$/m);
      expect(Number(minimum)).toBe(shard);
      const formatArgs = [context['runner.os'], context['runner.arch'], family, count];
      const skipPrefix = template.replace(/\{(\d)\}/g, (_, argument) => formatArgs[argument]);
      // Use the same complete lineage prefix in the exclusion and the lookup.
      expect(skipPrefix).toBe(fullKeys[index].replace(/\d+$/, ''));
      expect(restorePrefixes(restore).map(prefix => expand(prefix, context))).toEqual([skipPrefix]);
      expect(expand(restoreKey(restore), context)).toBe(skipPrefix);
      // Cache versions include the saved path.
      expect(memoPath(restore)).toBe(memoPath(save));
      const park = step(job, `Park full-run shard ${shard}`);
      expect(park).toContain(`if: steps.restore-shard-${shard}.outcome == 'success'`);
      expect(park).toContain(`portos-test-memo-shards/${shard}`);
      return skipPrefix;
    });

    const additionalKeys = (matched = '') => fullKeys.filter((_, index) => !matched.startsWith(prefixes[index]));
    for (const [index, exact] of fullKeys.entries()) {
      const fullContext = { ...context, 'matrix.shard': index + 1, 'strategy.job-total': count };
      const matched = restoreFrom(initial, fullKeys, fullContext);
      expect(matched).toBe(exact);
      expect(additionalKeys(matched)).toEqual(fullKeys.filter(key => key !== exact));
    }
    const fallback = restoreFrom(initial, fullKeys.toReversed(), scopedContext);
    expect(fallback).toBe(fullKeys.at(-1));
    expect(additionalKeys(fallback)).toEqual(fullKeys.slice(0, -1));
    expect(additionalKeys(restoreFrom(initial, [fallback, scopedKey], scopedContext))).toEqual(fullKeys);
    expect(additionalKeys(restoreFrom(initial, [], scopedContext))).toEqual(fullKeys);
    // The delimiter distinguishes, for example, client-3of3 from client-3of30.
    expect(additionalKeys(fallback.replace(`of${count}-`, `of${count}0-`))).toEqual(fullKeys);

    expect(memoPath(initial)).toBe(memoPath(save));
    expect(step(job, 'Park the job\'s own restore')).toContain('portos-test-memo-shards/0');
    expect(step(job, 'Merge the full-run shard lineages')).toContain('node scripts/merge-test-memo.js "$RUNNER_TEMP/portos-test-memo" "$RUNNER_TEMP"/portos-test-memo-shards/*');
  });

  it('keeps the database consumer on its unsharded restore and save path', () => {
    const job = jobs.database;
    const invocation = step(job, 'Restore the test memo');
    expect(invocation).toMatch(/suite: db\n\s+partition: db\n/);
    expect(invocation).not.toContain('merge-shards');
    const action = readFileSync(new URL('../.github/actions/test-memo/action.yml', import.meta.url), 'utf8');
    expect(action).toMatch(/merge-shards:\n[^]*?default: '0'/);
    expect(action).toContain('value: ${{ steps.restore.outputs.cache-primary-key }}');
    const restore = step(job, 'Restore from the trusted memo cache');
    const save = step(job, 'Save the test memo');
    expect(restoreKey(restore)).toBe('test-memo-${{ runner.os }}-${{ runner.arch }}-db-${{ github.run_id }}');
    expect(memoPath(restore)).toBe(memoPath(save));
    expect(save).toContain('key: ${{ steps.test-memo.outputs.key }}');
    expect(save).toContain("steps.db-tests.outcome == 'success' && github.event_name != 'pull_request'");
  });
});
