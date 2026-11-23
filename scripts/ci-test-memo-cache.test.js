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

  // Related selection and smoke browser ownership both need sibling records.
  it.each([
    ['server', FULL_SUITE_SHARDS.server],
    ['client', FULL_SUITE_SHARDS.client],
    ['browser', 4],
  ])('restores and merges each full-run %s shard lineage once', (family, count) => {
    const mergeBrowserShards = "env.PORTOS_BROWSER_TEST_PROFILE == 'smoke' && '4' || '0'";
    const mergeExpression = family === 'browser'
      ? mergeBrowserShards
      : `fromJSON(needs.impact.outputs.plan).${family}_mode == 'full' && '0' || '${count}'`;
    const mergeInput = `\${{ ${mergeExpression} }}`;
    const rawJob = jobs[family];
    // Exercise the composite with every explicit sibling restore disabled.
    const noMergeJob = rawJob.replaceAll('inputs.merge-shards', "'0'");
    expect(step(noMergeJob, "Park the job's own restore")).toContain("if: fromJSON('0') >= 1");
    expect(step(noMergeJob, 'Merge the full-run shard lineages')).toContain("if: fromJSON('0') >= 1");
    const job = rawJob.replaceAll(mergeInput, String(count));
    const save = step(job, 'Save the test memo');
    if (family === 'browser') {
      const invocation = step(rawJob, 'Restore the test memo');
      expect(invocation).toContain('suite: browser\n');
      expect(invocation).toContain(`merge-shards: \${{ ${mergeBrowserShards} }}\n`);
      expect(save).toContain("steps.browser-tests.outcome == 'success' && github.event_name != 'pull_request'");
    } else {
      const invocation = step(rawJob, 'Restore the test memo');
      expect(invocation).toContain(`suite: ${family}\n`);
      expect(invocation).toContain(`merge-shards: ${mergeInput}\n`);
      expect(ciYml).toContain(`merge-shards: ${mergeInput}\n`);
    }
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
      expect(step(noMergeJob, `Restore full-run shard ${shard} of the memo`)).toContain(`fromJSON('0') >= ${shard} &&`);
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
      expect(job.indexOf(`- name: Park full-run shard ${shard}\n`))
        .toBeLessThan(job.indexOf('- name: Merge the full-run shard lineages\n'));
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
    // A cache from an older shard layout must still fetch every current lineage.
    const previousLayout = fullKeys[0].replace(`of${count}-`, `of${count - 1}-`);
    expect(additionalKeys(restoreFrom(initial, [previousLayout], scopedContext))).toEqual(fullKeys);
    // The delimiter distinguishes, for example, client-4of4 from client-4of40.
    expect(additionalKeys(fallback.replace(`of${count}-`, `of${count}0-`))).toEqual(fullKeys);

    expect(memoPath(initial)).toBe(memoPath(save));
    expect(step(job, 'Park the job\'s own restore')).toContain('portos-test-memo-shards/0');
    const merge = step(job, 'Merge the full-run shard lineages');
    expect(merge).toContain('node scripts/merge-test-memo.js "$RUNNER_TEMP/portos-test-memo" "$RUNNER_TEMP"/portos-test-memo-shards/*');
    // Only a trusted run, which records into and saves the store, pays for the merge.
    expect(merge).toContain("if: fromJSON(inputs.merge-shards) >= 1 && github.event_name != 'pull_request'");
    // A pull request reads the parked lineages in place (#17617), in park order, own restore first.
    const inPlace = step(job, 'Read the full-run shard lineages in place');
    expect(inPlace).toContain("if: fromJSON(inputs.merge-shards) >= 1 && github.event_name == 'pull_request'");
    expect(inPlace).toContain('for dir in "$RUNNER_TEMP"/portos-test-memo-shards/*; do');
    expect(inPlace).toContain('echo "PORTOS_TEST_MEMO_READ_DIRS=$dirs" >> "$GITHUB_ENV"');
    expect(inPlace).not.toContain('merge-test-memo');
    expect(step(noMergeJob, 'Read the full-run shard lineages in place')).toContain("if: fromJSON('0') >= 1");
    expect(job.indexOf(`- name: Park full-run shard ${count}\n`)).toBeLessThan(job.indexOf('- name: Read the full-run shard lineages in place\n'));
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
